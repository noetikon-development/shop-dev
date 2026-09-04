import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireSellerSessionPermission } from "@/lib/seller/session";
import { getSellerRequestDetail, listRequestCategoryOptions } from "@/lib/seller/product-requests";
import { PageHeader, Card, StatusBadge } from "@/components/seller/ui";
import { requestStatusTone, requestStatusLabel } from "@/lib/seller/format";
import { RequestForm } from "@/components/seller/request-form";
import { RequestImagesPanel } from "@/components/seller/request-images-panel";
import { RequestSubmitPanel } from "@/components/seller/request-submit-panel";

export const metadata: Metadata = { title: "Product request" };

export default async function SellerProductRequestDetailPage({
  params,
}: PageProps<"/seller/product-requests/[id]">) {
  const { ctx } = await requireSellerSessionPermission("manage_offers");
  const { id } = await params;
  const [r, categories] = await Promise.all([
    getSellerRequestDetail(ctx, id),
    listRequestCategoryOptions(),
  ]);
  if (!r) notFound();

  return (
    <div>
      <Link
        href="/seller/product-requests"
        className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink"
      >
        <ArrowLeft size={14} /> Back to product requests
      </Link>
      <PageHeader
        title={r.name}
        description={r.categoryName ?? "No category chosen"}
        actions={<StatusBadge tone={requestStatusTone(r.status)}>{requestStatusLabel(r.status)}</StatusBadge>}
      />

      {r.status === "REJECTED" && r.reviewNote && (
        <div className="mb-6 rounded-sm border border-danger/30 bg-danger-50 px-4 py-3 text-sm text-danger">
          <p className="font-medium">Axiaro didn&rsquo;t approve this request</p>
          <p className="mt-1 whitespace-pre-wrap">{r.reviewNote}</p>
          <p className="mt-2 text-xs">Start a new request with the changes if you&rsquo;d still like Axiaro to carry it.</p>
        </div>
      )}
      {r.status === "PENDING" && (
        <div className="mb-6 rounded-sm border border-line bg-surface-sunken px-4 py-3 text-sm text-ink-soft">
          This request is with Axiaro for review. It&rsquo;s locked while it&rsquo;s in review.
        </div>
      )}
      {r.status === "APPROVED" && (
        <div className="mb-6 rounded-sm border border-line bg-surface-sunken px-4 py-3 text-sm text-ink-soft">
          Approved.{" "}
          {r.resultProduct ? (
            <>
              Axiaro created <strong className="text-ink">{r.resultProduct.name}</strong> —{" "}
              <Link href={`/seller/offers/new?q=${encodeURIComponent(r.resultProduct.name)}`} className="underline">
                list against it
              </Link>
              .
            </>
          ) : (
            "Axiaro is preparing the catalog entry."
          )}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        <div className="space-y-6">
          <Card>
            <h2 className="mb-4 text-sm font-semibold">{r.editable ? "Proposal" : "Submitted proposal"}</h2>
            {r.editable ? (
              <RequestForm
                mode="edit"
                requestId={r.id}
                categories={categories}
                defaults={{
                  proposedName: r.name,
                  proposedBrand: r.brand,
                  proposedShortDesc: r.shortDesc,
                  proposedDescription: r.description,
                  proposedCategoryId: r.categoryId,
                  categoryNote: r.categoryNote,
                  barcode: r.barcode,
                  sellerNote: r.sellerNote,
                  variants: r.variants,
                }}
              />
            ) : (
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <Field label="Brand">{r.brand}</Field>
                <Field label="Barcode">{r.barcode}</Field>
                <Field label="Category">{r.categoryName ?? r.categoryNote}</Field>
                <Field label="Short description" full>{r.shortDesc}</Field>
                <Field label="Description" full>{r.description}</Field>
                <Field label="Variants" full>
                  {r.variants.length
                    ? r.variants.map((v, i) => (
                        <span key={i} className="block">
                          {v.label}
                          {v.proposedSku ? ` · SKU ${v.proposedSku}` : ""}
                          {v.barcode ? ` · ${v.barcode}` : ""}
                        </span>
                      ))
                    : null}
                </Field>
                <Field label="Your note" full>{r.sellerNote}</Field>
              </dl>
            )}
          </Card>

          <Card>
            <h2 className="mb-4 text-sm font-semibold">Images</h2>
            <RequestImagesPanel
              requestId={r.id}
              editable={r.editable}
              images={r.images}
            />
          </Card>
        </div>

        <div className="space-y-6">
          {r.editable && (
            <Card>
              <h2 className="mb-3 text-sm font-semibold">Submit for review</h2>
              <RequestSubmitPanel
                requestId={r.id}
                blocks={r.duplicates?.blocks ?? []}
                warnings={r.duplicates?.warnings ?? []}
              />
            </Card>
          )}

          <Card>
            <h2 className="mb-3 text-sm font-semibold">Who does what</h2>
            <p className="text-sm text-ink-soft">
              You describe the product and attach reference photos. Axiaro reviews it, writes the
              canonical catalog entry (name, category, images, specs) in house style, and creates the
              product. Your photos are references — they don&rsquo;t become catalog images unless Axiaro
              chooses to use them.
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return (
    <div className={full ? "sm:col-span-2" : undefined}>
      <dt className="text-xs uppercase tracking-wide text-ink-faint">{label}</dt>
      {children ? (
        <dd className="mt-0.5 whitespace-pre-wrap font-medium text-ink">{children}</dd>
      ) : (
        <dd className="mt-0.5 text-ink-faint">—</dd>
      )}
    </div>
  );
}
