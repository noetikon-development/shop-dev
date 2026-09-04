import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, Store, AlertTriangle, Info } from "lucide-react";
import { requireAnyPermission } from "@/lib/admin/rbac";
import { getAdminProductRequest, searchCatalogForLink } from "@/lib/admin/seller-product-requests/repository";
import { productColourChoices } from "@/lib/admin/seller-product-requests/promote-image";
import { categorySelectOptions } from "@/lib/admin/catalog";
import { PageHeader, Card, StatusBadge } from "@/components/admin/ui";
import { RequestReviewActions } from "@/components/admin/seller-product-requests/review-actions";
import { LinkExistingPanel } from "@/components/admin/seller-product-requests/link-existing-panel";
import { CreateProductPanel } from "@/components/admin/seller-product-requests/create-product-panel";
import { PromoteImagesPanel } from "@/components/admin/seller-product-requests/promote-images-panel";

export const metadata: Metadata = { title: "Seller product request" };

const TONE = { DRAFT: "neutral", PENDING: "info", APPROVED: "success", REJECTED: "danger" } as const;
const LABEL = { DRAFT: "Draft", PENDING: "In review", APPROVED: "Approved", REJECTED: "Rejected" } as const;

export default async function AdminSellerProductRequestDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ linkq?: string }>;
}) {
  const admin = await requireAnyPermission(["manage_content", "create_products"]);
  const canReview = admin.isSuperAdmin || admin.permissions.has("manage_content");
  const canCreate = admin.isSuperAdmin || admin.permissions.has("create_products");
  const canImages = admin.isSuperAdmin || admin.permissions.has("manage_product_images");

  const { id } = await params;
  const { linkq } = await searchParams;
  const r = await getAdminProductRequest(id);
  if (!r) notFound();

  const [categories, linkMatches, colourChoices] = await Promise.all([
    r.status === "PENDING" && canCreate ? categorySelectOptions() : Promise.resolve([]),
    r.status === "PENDING" && canReview && linkq ? searchCatalogForLink(linkq) : Promise.resolve([]),
    r.status === "APPROVED" && r.resultProduct ? productColourChoices(r.resultProduct.id) : Promise.resolve([]),
  ]);

  const submitted = r.submittedAt ?? r.createdAt;

  return (
    <div>
      <Link
        href="/admin/seller-product-requests"
        className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink"
      >
        <ChevronLeft size={15} /> Seller product requests
      </Link>
      <PageHeader
        title={r.proposedName}
        actions={
          <StatusBadge tone={TONE[r.status as keyof typeof TONE] ?? "neutral"}>
            {LABEL[r.status as keyof typeof LABEL] ?? r.status}
          </StatusBadge>
        }
      >
        <p className="inline-flex items-center gap-1.5 text-sm text-ink-soft">
          <Store size={13} className="text-ink-faint" />
          <Link href={`/admin/sellers/${r.sellerId}`} className="hover:underline">
            {r.sellerName}
          </Link>
        </p>
      </PageHeader>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-4">
          {/* SELLER INFORMATION */}
          <Card>
            <h2 className="mb-3 text-sm font-semibold">Seller information</h2>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-ink-faint">Seller</dt>
                <dd>
                  {r.sellerName} <span className="text-ink-faint">· {r.sellerSupportEmail}</span>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-ink-faint">{r.submittedAt ? "Submitted" : "Created"}</dt>
                <dd>{new Date(submitted).toLocaleString()}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs text-ink-faint">Seller&rsquo;s note</dt>
                <dd className="whitespace-pre-wrap">{r.sellerNote || "—"}</dd>
              </div>
            </dl>
          </Card>

          {/* PROPOSED PRODUCT */}
          <Card>
            <h2 className="mb-3 text-sm font-semibold">Proposed product</h2>
            <p className="mb-3 text-xs text-ink-faint">
              Everything below is the seller&rsquo;s proposal — advisory only. You set the final
              catalog values when you create or link a product.
            </p>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <Detail label="Name">{r.proposedName}</Detail>
              <Detail label="Brand">{r.proposedBrand}</Detail>
              <Detail label="Category">{r.categoryName ?? r.categoryNote}</Detail>
              <Detail label="Barcode">{r.barcode}</Detail>
              <Detail label="Short description" full>
                {r.proposedShortDesc}
              </Detail>
              <Detail label="Description" full>
                {r.proposedDescription}
              </Detail>
              <Detail label="Options" full>
                {r.options.length
                  ? r.options.map((o) => (
                      <span key={o.name} className="block">
                        <strong>{o.name}:</strong> {o.values.join(", ")}
                      </span>
                    ))
                  : null}
              </Detail>
            </dl>

            {r.variants.length > 0 && (
              <div className="mt-4 overflow-x-auto rounded-sm border border-line">
                <table className="w-full min-w-[32rem] border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-line bg-surface-sunken/60 text-[10px] uppercase tracking-wide text-ink-faint">
                      <th className="px-3 py-2 text-left">Label</th>
                      <th className="px-3 py-2 text-left">Options</th>
                      <th className="px-3 py-2 text-left">Proposed SKU</th>
                      <th className="px-3 py-2 text-left">Barcode</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.variants.map((v, i) => (
                      <tr key={i} className="border-b border-line/60 last:border-0">
                        <td className="px-3 py-2 font-medium text-ink">{v.label}</td>
                        <td className="px-3 py-2 text-ink-soft">
                          {v.optionValues && Object.keys(v.optionValues).length
                            ? Object.entries(v.optionValues)
                                .map(([k, val]) => `${k}: ${val}`)
                                .join(", ")
                            : "—"}
                        </td>
                        <td className="px-3 py-2 font-mono text-ink-soft">{v.proposedSku ?? "—"}</td>
                        <td className="px-3 py-2 text-ink-soft">{v.barcode ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* IMAGES */}
          <Card>
            <h2 className="mb-3 text-sm font-semibold">Seller images ({r.images.length})</h2>
            {r.images.length === 0 ? (
              <p className="text-sm text-ink-faint">The seller attached no reference images.</p>
            ) : r.status === "APPROVED" && r.resultProduct && canImages ? (
              <PromoteImagesPanel
                requestId={r.id}
                images={r.images}
                colourChoices={colourChoices}
                productName={r.resultProduct.name}
              />
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {r.images.map((img) => (
                  <figure key={img.id} className="overflow-hidden rounded-sm border border-line">
                    <div className="relative aspect-square bg-surface-sunken">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={img.url} alt={img.filename} className="h-full w-full object-contain" />
                    </div>
                    <figcaption className="truncate px-2 py-1 text-[11px] text-ink-faint">
                      {img.role} · {img.filename}
                      {img.alreadyPromoted ? " · promoted" : ""}
                    </figcaption>
                  </figure>
                ))}
              </div>
            )}
          </Card>

          {/* DUPLICATE REVIEW */}
          <Card>
            <h2 className="mb-3 text-sm font-semibold">Duplicate review</h2>
            {r.duplicates.blocks.length === 0 && r.duplicates.warnings.length === 0 ? (
              <p className="text-sm text-ink-faint">
                No exact SKU conflicts, barcode matches or name/brand/category matches.
              </p>
            ) : (
              <ul className="space-y-2 text-sm">
                {r.duplicates.blocks.map((b, i) => (
                  <li key={`b${i}`} className="flex gap-2 rounded-sm bg-danger-50 px-3 py-2 text-danger">
                    <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                    <span>
                      <strong>SKU conflict.</strong> {b.message}
                      {b.productSlug && (
                        <Link href={`/p/${b.productSlug}`} target="_blank" className="ml-1 underline">
                          view
                        </Link>
                      )}
                    </span>
                  </li>
                ))}
                {r.duplicates.warnings.map((w, i) => (
                  <li key={`w${i}`} className="flex gap-2 rounded-sm bg-warning-50 px-3 py-2 text-warning">
                    <Info size={15} className="mt-0.5 shrink-0" />
                    <span>
                      {w.message}
                      {w.productSlug && (
                        <Link href={`/p/${w.productSlug}`} target="_blank" className="ml-1 underline">
                          view
                        </Link>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-ink-faint">
              These are advisory. You make the final call — link to an existing product rather than
              creating a near-duplicate where one already fits.
            </p>
          </Card>

          {/* ACTIVITY */}
          <Card>
            <h2 className="mb-2 text-sm font-semibold">Activity</h2>
            {r.audit.length === 0 ? (
              <p className="text-sm text-ink-faint">No review activity yet.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {r.audit.map((a, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="shrink-0 text-xs text-ink-faint">{new Date(a.at).toLocaleString()}</span>
                    <span className="text-ink-soft">{a.summary ?? a.action}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        {/* ADMIN ACTIONS */}
        <div className="space-y-4">
          {r.status === "PENDING" ? (
            <>
              <Card>
                <h2 className="mb-1 text-sm font-semibold">Approve</h2>
                <p className="mb-3 text-xs text-ink-faint">
                  Choose an outcome — link to an existing catalog product, or create a new one. The
                  seller&rsquo;s proposal never becomes the catalog entry automatically.
                </p>
                {canReview ? (
                  <LinkExistingPanel requestId={r.id} matches={linkMatches} query={linkq ?? ""} />
                ) : (
                  <p className="text-sm text-ink-soft">Linking to an existing product needs the content permission.</p>
                )}
              </Card>

              <Card>
                <h2 className="mb-1 text-sm font-semibold">Create a new product</h2>
                {canCreate ? (
                  <CreateProductPanel
                    requestId={r.id}
                    categories={categories}
                    proposal={{
                      name: r.proposedName,
                      brand: r.proposedBrand,
                      shortDescription: r.proposedShortDesc,
                      description: r.proposedDescription,
                      categoryId: r.proposedCategoryId,
                      options: r.options,
                    }}
                  />
                ) : (
                  <p className="text-sm text-ink-soft">Creating a product needs the products permission.</p>
                )}
              </Card>

              {canReview && (
                <Card>
                  <h2 className="mb-1 text-sm font-semibold">Send back or reject</h2>
                  <RequestReviewActions requestId={r.id} />
                </Card>
              )}
            </>
          ) : (
            <Card>
              <h2 className="mb-2 text-sm font-semibold">Outcome</h2>
              {r.status === "APPROVED" ? (
                <div className="text-sm">
                  {r.resultProduct ? (
                    <p>
                      Linked to{" "}
                      <Link href={`/admin/products/${r.resultProduct.id}`} className="font-medium text-ink hover:underline">
                        {r.resultProduct.name}
                      </Link>{" "}
                      <StatusBadge tone={r.resultProduct.status === "ACTIVE" ? "success" : "neutral"}>
                        {r.resultProduct.status}
                      </StatusBadge>
                    </p>
                  ) : (
                    <p className="text-ink-soft">Approved — the canonical product is still being prepared.</p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-ink-soft">This request was rejected. It is terminal.</p>
              )}
              {r.reviewNote && (
                <div className="mt-3 rounded-sm bg-surface-sunken px-3 py-2 text-xs text-ink-soft">
                  <p className="font-medium">
                    Review note{r.reviewedByEmail ? ` · ${r.reviewedByEmail}` : ""}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap">{r.reviewNote}</p>
                </div>
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Detail({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return (
    <div className={full ? "sm:col-span-2" : undefined}>
      <dt className="text-xs text-ink-faint">{label}</dt>
      {children ? (
        <dd className="mt-0.5 whitespace-pre-wrap text-ink">{children}</dd>
      ) : (
        <dd className="mt-0.5 text-ink-faint">—</dd>
      )}
    </div>
  );
}
