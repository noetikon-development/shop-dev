import type { Metadata } from "next";
import { requireSellerSessionPermission } from "@/lib/seller/session";
import { getSellerVerification, listSellerVerificationDocuments } from "@/lib/seller-verification/repository";
import { validateSellerVerificationSubmission, SELLER_VERIFICATION_SUBMISSION_FAILURE_MESSAGE } from "@/lib/seller-verification/validation";
import { PageHeader, Card, StatusBadge } from "@/components/seller/ui";
import { SellerVerificationForm } from "@/components/seller/verification-form";
import { SellerVerificationDocuments } from "@/components/seller/verification-documents";
import { SellerVerificationSubmitPanel } from "@/components/seller/verification-submit-panel";

export const metadata: Metadata = { title: "Verification" };

const STATUS_TONE: Record<string, "neutral" | "warning" | "success" | "danger"> = {
  DRAFT: "neutral",
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "danger",
};

/**
 * Seller Verification — identity/business information, documents, and
 * submission (Phases 2–5, requirements Phase 9).
 *
 * `requireSellerSessionPermission("manage_seller_settings")` is the SAME gate
 * `/seller/settings` uses (OWNER + MANAGER) — the session helper itself
 * derives `ctx.sellerId` from the caller's own ACTIVE SellerUser membership,
 * so this page can never load or accidentally leak another seller's record.
 * An unauthenticated visitor is redirected to `/seller/login`; a signed-in
 * user with no usable membership (or only STAFF) gets a real 403 — neither
 * ever reaches this page body.
 *
 * No SellerVerification row is created just by visiting this page — it stays
 * null (and the form starts blank) until the seller explicitly saves a draft
 * or uploads a document. Once submitted (PENDING) or decided
 * (APPROVED/REJECTED), the identity/business form and document controls
 * render read-only (`readOnly` on both components — a native
 * `<fieldset disabled>` in the form, conditional upload/delete controls in
 * the document list) rather than letting the seller edit data mid-review or
 * accidentally start a second DRAFT verification alongside a PENDING one.
 *
 * Phase 9 — the "Requirements" checklist below is a read-only PREVIEW built
 * from the exact same `validateSellerVerificationSubmission` the submit
 * server action re-runs authoritatively; it is a courtesy so the seller
 * knows what's missing before clicking Submit, never the enforcement itself.
 */
export default async function SellerVerificationPage() {
  const { ctx } = await requireSellerSessionPermission("manage_seller_settings");
  const [verification, documents] = await Promise.all([
    getSellerVerification(ctx),
    listSellerVerificationDocuments(ctx),
  ]);

  const status = verification?.status ?? "DRAFT";
  const readOnly = status !== "DRAFT";
  const pendingDocumentTypes = documents.filter((d) => d.status === "PENDING").map((d) => d.documentType);
  const requirements = validateSellerVerificationSubmission({
    businessType: verification?.businessType ?? null,
    legalName: verification?.legalName ?? null,
    phone: verification?.phone ?? null,
    addressLine1: verification?.addressLine1 ?? null,
    city: verification?.city ?? null,
    province: verification?.province ?? null,
    postalCode: verification?.postalCode ?? null,
    country: verification?.country ?? null,
    businessName: verification?.businessName ?? null,
    documentTypes: pendingDocumentTypes,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Seller verification"
        description="Identity, business information and supporting documents Axiaro uses to verify your seller account."
        actions={<StatusBadge tone={STATUS_TONE[status] ?? "neutral"}>{verification ? status : "Not started"}</StatusBadge>}
      />

      {status === "PENDING" && (
        <Card>
          <p className="text-sm text-ink">Your verification has been submitted and is under review.</p>
        </Card>
      )}
      {status === "REJECTED" && (
        <Card>
          <p className="text-sm text-ink">Your verification was not approved.</p>
          {verification?.reviewNote && (
            <div className="mt-3 rounded-sm bg-surface-sunken px-3 py-2 text-xs text-ink-soft">
              <p className="font-medium">Note from Axiaro</p>
              <p className="mt-1 whitespace-pre-wrap">{verification.reviewNote}</p>
            </div>
          )}
        </Card>
      )}
      {status === "APPROVED" && (
        <Card>
          <p className="text-sm text-ink">Your verification has been approved.</p>
        </Card>
      )}

      <Card>
        <SellerVerificationForm verification={verification} readOnly={readOnly} />
      </Card>

      <Card>
        <h2 className="mb-4 text-sm font-semibold">Supporting documents</h2>
        <SellerVerificationDocuments
          readOnly={readOnly}
          businessType={verification?.businessType}
          documents={documents.map((d) => ({
            id: d.id,
            documentType: d.documentType,
            status: d.status,
            uploadedAt: d.uploadedAt.toISOString(),
          }))}
        />
      </Card>

      {verification && status === "DRAFT" && (
        <Card>
          <h2 className="mb-3 text-sm font-semibold">Submit for review</h2>
          {!requirements.ok && (
            <div className="mb-4 rounded-sm bg-surface-sunken px-3 py-2 text-xs text-ink-soft">
              <p className="font-medium text-ink">Before you submit, you still need to:</p>
              <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
                {requirements.codes.map((code) => (
                  <li key={code}>{SELLER_VERIFICATION_SUBMISSION_FAILURE_MESSAGE[code]}</li>
                ))}
              </ul>
            </div>
          )}
          <SellerVerificationSubmitPanel />
        </Card>
      )}
    </div>
  );
}
