import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireSellerSession } from "@/lib/seller/session";
import { sellerCan } from "@/lib/marketplace/seller-context";
import { getSellerOfferDetail } from "@/lib/seller/offers";
import { PageHeader, Card, StatusBadge } from "@/components/seller/ui";
import { pesos, offerStatusTone, conditionLabel } from "@/lib/seller/format";
import { OfferEditForm } from "@/components/seller/offer-edit-form";
import { OfferStatusControls } from "@/components/seller/offer-status-controls";
import { OfferStockPanel } from "@/components/seller/offer-stock-panel";

export const metadata: Metadata = { title: "Offer" };

export default async function SellerOfferDetailPage({ params }: PageProps<"/seller/offers/[id]">) {
  const { ctx } = await requireSellerSession("/seller/offers");
  const { id } = await params;
  const offer = await getSellerOfferDetail(ctx, id);
  if (!offer) notFound();

  const canManageOffers = sellerCan(ctx, "manage_offers");
  const canManageInventory = sellerCan(ctx, "manage_offer_inventory");
  const editable = offer.status !== "ARCHIVED";

  return (
    <div>
      <PageHeader
        title={offer.productName}
        description={`${offer.optionLabel} · ${offer.variantSku}`}
        actions={<StatusBadge tone={offerStatusTone(offer.status)}>{offer.status}</StatusBadge>}
      />
      <Link
        href="/seller/offers"
        className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink"
      >
        <ArrowLeft size={14} /> Back to My Offers
      </Link>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-6">
          <Card>
            <h2 className="mb-4 text-sm font-semibold">Commercial terms</h2>
            {canManageOffers && editable ? (
              <OfferEditForm
                offerId={offer.id}
                price={offer.price}
                compareAtPrice={offer.compareAtPrice}
                sellerSku={offer.sellerSku}
                condition={offer.condition}
                handlingTimeDays={offer.handlingTimeDays}
              />
            ) : (
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                <Row label="Price">{pesos(offer.price)}</Row>
                <Row label="Compare-at">{offer.compareAtPrice ? pesos(offer.compareAtPrice) : "—"}</Row>
                <Row label="Condition">{conditionLabel(offer.condition)}</Row>
                <Row label="Your SKU">{offer.sellerSku ?? "—"}</Row>
                <Row label="Handling">{offer.handlingTimeDays} day(s)</Row>
              </dl>
            )}
          </Card>

          {canManageInventory && (
            <Card>
              <h2 className="mb-4 text-sm font-semibold">Stock</h2>
              <OfferStockPanel
                offerId={offer.id}
                quantity={offer.quantity}
                reserved={offer.reserved}
                available={offer.available}
                reorderPoint={offer.reorderPoint}
                readOnly={offer.status === "ARCHIVED"}
              />
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card>
            <h2 className="mb-3 text-sm font-semibold">Availability</h2>
            <p className="text-sm text-ink-soft">
              This offer is <strong className="text-ink">{offer.status.toLowerCase()}</strong> and is{" "}
              <strong className="text-ink">not visible to buyers</strong>. Publishing offers to the
              storefront opens in a later marketplace phase.
            </p>
          </Card>

          {canManageOffers && (
            <Card>
              <h2 className="mb-3 text-sm font-semibold">Status</h2>
              <OfferStatusControls offerId={offer.id} status={offer.status} />
            </Card>
          )}

          <Card padded={false}>
            <div className="border-b border-line px-5 py-3">
              <h2 className="text-sm font-semibold">Catalog</h2>
            </div>
            <div className="px-5 py-4 text-sm">
              <p className="text-ink-soft">
                Product data (name, images, description, specs) is owned by Axiaro.
              </p>
              <Link
                href={`/p/${offer.productSlug}`}
                target="_blank"
                className="mt-2 inline-block text-xs text-clay hover:underline"
              >
                View storefront page ↗
              </Link>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-ink-faint">{label}</dt>
      <dd className="mt-0.5 font-medium text-ink">{children}</dd>
    </div>
  );
}
