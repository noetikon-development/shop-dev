import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requirePermission } from "@/lib/admin/rbac";
import { prisma } from "@/lib/prisma";
import { getSellerVerificationForAdmin, listSellerVerificationDocumentsForAdmin } from "@/lib/seller-verification/repository";
import { SELLER_VERIFICATION_BUSINESS_TYPE_LABELS, type SellerVerificationBusinessType } from "@/lib/seller-verification/business-types";
import { countryName } from "@/lib/countries";
import { PageHeader, Card, StatusBadge } from "@/components/admin/ui";
import { SellerVerificationDecisionPanel, SellerVerificationDocumentReviewCard } from "@/components/admin/sellers/seller-verification-review";

export const metadata: Metadata = { title: "Seller verification" };

const STATUS_TONE: Record<string, "neutral" | "info" | "success" | "danger"> = {
  DRAFT: "neutral",
  PENDING: "info",
  APPROVED: "success",
  REJECTED: "danger",
};

/**
 * Admin Seller Verification review (Phase 4).
 *
 * `requirePermission("manage_settings")` — the SAME permission
 * `admin/sellers/actions.ts` already requires for seller lifecycle
 * decisions and Phase 3's signed-url action already used. No new permission,
 * `scripts/seed-rbac.ts` untouched. An unauthenticated visitor is redirected
 * to the admin login; a signed-in admin lacking the permission gets the
 * existing `forbidden()` 403 — neither ever reaches this page body.
 *
 * Read-only page: nothing here mutates anything on load. The actual
 * approve/reject decisions live in the two review components, each backed
 * by its own server action with its own full ownership-chain verification.
 */
export default async function AdminSellerVerificationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePermission("manage_settings");
  const { id: sellerId } = await params;

  const seller = await prisma.seller.findUnique({
    where: { id: sellerId },
    select: { id: true, displayName: true },
  });
  if (!seller) notFound();

  const verification = await getSellerVerificationForAdmin(sellerId);
  const documents = verification ? await listSellerVerificationDocumentsForAdmin(verification.id) : [];

  const address = verification
    ? [
        verification.addressLine1,
        verification.addressLine2,
        verification.barangay,
        verification.city,
        verification.province,
        verification.postalCode,
        verification.country ? countryName(verification.country) : null,
      ]
        .filter(Boolean)
        .join(", ") || null
    : null;

  return (
    <div>
      <Link
        href={`/admin/sellers/${sellerId}`}
        className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink"
      >
        <ChevronLeft size={15} /> {seller.displayName}
      </Link>
      <PageHeader
        title="Seller verification"
        description={`Identity and business review for ${seller.displayName}.`}
        actions={
          verification && (
            <StatusBadge tone={STATUS_TONE[verification.status] ?? "neutral"}>{verification.status}</StatusBadge>
          )
        }
      />

      {!verification ? (
        <Card>
          <p className="text-sm text-ink-faint">This seller has not started verification yet.</p>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
          <div className="space-y-4">
            <Card>
              <h2 className="mb-3 text-sm font-semibold">Identity</h2>
              <dl className="grid gap-3 sm:grid-cols-2 text-sm">
                <Field label="Legal name" value={verification.legalName} />
                <Field
                  label="Phone"
                  value={verification.phone}
                  extra={verification.phone ? (verification.phoneVerifiedAt ? "Verified" : "Not verified") : undefined}
                />
                <Field label="Address" value={address} />
              </dl>
            </Card>

            <Card>
              <h2 className="mb-3 text-sm font-semibold">Business information</h2>
              <dl className="grid gap-3 sm:grid-cols-2 text-sm">
                <Field
                  label="Business type"
                  value={
                    verification.businessType
                      ? SELLER_VERIFICATION_BUSINESS_TYPE_LABELS[verification.businessType as SellerVerificationBusinessType] ??
                        verification.businessType
                      : null
                  }
                />
                <Field label="Business name" value={verification.businessName} />
                <Field label="Business registration number" value={verification.businessRegistrationNumber} />
                <Field label="DTI registration number" value={verification.dtiRegistrationNumber} />
                <Field label="SEC registration number" value={verification.secRegistrationNumber} />
                <Field label="TIN" value={verification.tin} />
              </dl>
              <p className="mt-3 text-xs text-ink-faint">
                As provided by the seller — not independently confirmed unless a supporting document has been approved below.
              </p>
            </Card>

            <Card padded={false}>
              <div className="flex items-center justify-between border-b border-line px-5 py-3">
                <h2 className="text-sm font-semibold">Documents</h2>
                <span className="text-xs text-ink-faint">{documents.length}</span>
              </div>
              {documents.length === 0 ? (
                <p className="px-5 py-4 text-sm text-ink-faint">No documents uploaded yet.</p>
              ) : (
                <ul className="divide-y divide-line-soft">
                  {documents.map((d) => (
                    <li key={d.id} className="px-5 py-4">
                      <SellerVerificationDocumentReviewCard
                        sellerId={sellerId}
                        verificationId={verification.id}
                        document={{
                          id: d.id,
                          documentType: d.documentType,
                          status: d.status,
                          uploadedAt: d.uploadedAt.toISOString(),
                          mimeType: d.mimeType,
                          sizeBytes: d.sizeBytes,
                          reviewedAt: d.reviewedAt ? d.reviewedAt.toISOString() : null,
                          reviewNote: d.reviewNote,
                        }}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <div className="space-y-4">
            <Card>
              <h2 className="mb-2 text-sm font-semibold">Overview</h2>
              <dl className="space-y-2 text-sm">
                <Field label="Status" value={verification.status} />
                <Field
                  label="Submitted"
                  value={verification.submittedAt ? new Date(verification.submittedAt).toLocaleString() : null}
                />
                <Field
                  label="Reviewed"
                  value={verification.reviewedAt ? new Date(verification.reviewedAt).toLocaleString() : null}
                />
                <Field label="Reviewer" value={verification.reviewedByEmail} />
              </dl>
              {verification.reviewNote && (
                <div className="mt-3 rounded-sm bg-surface-sunken px-3 py-2 text-xs text-ink-soft">
                  <p className="font-medium">Note</p>
                  <p className="mt-1 whitespace-pre-wrap">{verification.reviewNote}</p>
                </div>
              )}
            </Card>

            <Card>
              <h2 className="mb-2 text-sm font-semibold">Decision</h2>
              {verification.status === "PENDING" ? (
                <SellerVerificationDecisionPanel sellerId={sellerId} verificationId={verification.id} />
              ) : (
                <p className="text-sm text-ink-soft">
                  {verification.status === "DRAFT"
                    ? "The seller has not submitted this for review yet."
                    : `This verification is ${verification.status.toLowerCase()}. Approving or rejecting it never changes the seller's account status.`}
                </p>
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, value, extra }: { label: string; value: string | null; extra?: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-faint">{label}</dt>
      <dd className="text-sm">
        {value ?? <span className="text-ink-faint">Not provided</span>}
        {extra ? ` · ${extra}` : ""}
      </dd>
    </div>
  );
}
