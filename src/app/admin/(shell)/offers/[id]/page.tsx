import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireAnyPermission } from "@/lib/admin/rbac";
import { getAdminOfferDetail } from "@/lib/admin/offers";
import { conditionLabel, offerStatusTone, pesos } from "@/lib/seller/format";
import { PageHeader, Card, StatusBadge } from "@/components/admin/ui";
import { AdminOfferStatusControls } from "@/components/admin/offers/admin-offer-status-controls";

export const metadata: Metadata = { title: "Offer" };

export default async function AdminOfferDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const admin = await requireAnyPermission(["manage_settings", "manage_content"]);
  const canManage = admin.isSuperAdmin || admin.permissions.has("manage_settings");

  const { id } = await params;
  const offer = await getAdminOfferDetail(id);
  if (!offer) notFound();

  const isLive = offer.status === "ACTIVE";

  return (
    <div>
      <Link href="/admin/offers" className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink">
        <ChevronLeft size={15} /> Offers
      </Link>
      <PageHeader
        title={offer.productName}
        description={`${offer.optionLabel} · ${offer.sellerSku ?? offer.variantSku}`}
        actions={<StatusBadge tone={offerStatusTone(offer.status)}>{offer.status}</StatusBadge>}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          <Card>
            <h2 className="mb-3 text-sm font-semibold">Listing</h2>
            <dl className="grid gap-3 sm:grid-cols-2 text-sm">
              <div>
                <dt className="text-xs text-ink-faint">Seller</dt>
                <dd>
                  <Link href={`/admin/sellers/${offer.sellerId}`} className="text-ink hover:underline">
                    {offer.sellerName}
                  </Link>{" "}
                  <span className="text-ink-faint">
                    ({offer.sellerType === "FIRST_PARTY" ? "first-party" : "third-party"} · {offer.sellerStatus.toLowerCase()})
                  </span>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-ink-faint">Catalog product</dt>
                <dd>
                  <Link href={`/admin/products/${offer.productId}`} className="text-ink hover:underline">
                    {offer.productName}
                  </Link>{" "}
                  <span className="text-ink-faint">({offer.productStatus.toLowerCase()})</span>
                </dd>
              </div>
              <div><dt className="text-xs text-ink-faint">Condition</dt><dd>{conditionLabel(offer.condition)}</dd></div>
              <div><dt className="text-xs text-ink-faint">Option / variant SKU</dt><dd className="font-mono">{offer.variantSku}</dd></div>
              <div><dt className="text-xs text-ink-faint">Price</dt><dd>{pesos(offer.price)}{offer.compareAtPrice ? ` (compare-at ${pesos(offer.compareAtPrice)})` : ""}</dd></div>
              <div><dt className="text-xs text-ink-faint">Handling time</dt><dd>{offer.handlingTimeDays} day(s)</dd></div>
              <div>
                <dt className="text-xs text-ink-faint">Stock (offer-owned)</dt>
                <dd>{offer.available} available · {offer.quantity} on hand · {offer.reserved} reserved</dd>
              </div>
              <div><dt className="text-xs text-ink-faint">Last changed</dt><dd>{new Date(offer.updatedAt).toLocaleString()}</dd></div>
            </dl>
            <p className="mt-3 text-xs text-ink-faint">
              Price, condition and stock are the seller&rsquo;s to set. From here an operator changes only the
              listing&rsquo;s <strong>status</strong>.
            </p>
          </Card>

          <Card>
            <h2 className="mb-2 text-sm font-semibold">Storefront visibility</h2>
            <p className="text-sm text-ink-soft">
              This listing is <strong className="text-ink">{offer.status.toLowerCase()}</strong> and is{" "}
              <strong className="text-ink">
                {isLive ? "visible to buyers on the storefront" : "not visible to buyers"}
              </strong>
              .
            </p>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <h2 className="mb-2 text-sm font-semibold">Status</h2>
            {canManage ? (
              <AdminOfferStatusControls
                offerId={offer.id}
                status={offer.status}
                blockers={offer.publishBlockers}
              />
            ) : (
              <p className="text-sm text-ink-soft">
                Changing a listing&rsquo;s status needs the settings permission.
              </p>
            )}
          </Card>

          <Card>
            <h2 className="mb-2 text-sm font-semibold">Storefront page</h2>
            <Link
              href={`/p/${offer.productSlug}`}
              target="_blank"
              className="text-xs text-clay hover:underline"
            >
              View storefront page ↗
            </Link>
          </Card>
        </div>
      </div>
    </div>
  );
}
