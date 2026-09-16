import { ExternalLink, Truck } from "lucide-react";
import { OrderTimeline } from "@/components/order/order-timeline";
import { Badge } from "@/components/ui/badge";
import { ORDER_STATUS_META } from "@/lib/constants";
import { courierLabel, isSafeTrackingUrl, isStorePickupCode } from "@/lib/orders/couriers";
import { formatDate, cn } from "@/lib/utils";
import {
  groupOrderItemsBySeller,
  type CustomerOrderSellerOrder,
} from "@/lib/marketplace/customer-order-view";
import { sellerOrderStatusLabel, sellerOrderStatusTone } from "@/lib/marketplace/seller-order-status";
import type { PublicTracking } from "@/lib/data";

type PublicTrackingItem = PublicTracking["items"][number];

/**
 * Public /track view. Deliberately narrow: order number, status, fulfilment
 * (courier / tracking / dates), a short item list and the timeline. No customer
 * email, phone, address, billing, prices or internal notes are rendered here.
 *
 * Multi-seller (customer tracking-visibility phase): when the order has more
 * than one SellerOrder, each seller's OWN status/items/shipment renders in its
 * own card via `SellerTrackingGroup` — the exact same presentation split used
 * on the authenticated order-detail page (`order-detail.tsx`'s
 * `SellerItemGroup`), reusing `groupOrderItemsBySeller` so there is no second
 * grouping implementation. A single-seller (or legacy, zero-SellerOrder) order
 * keeps the original flat aggregate-fulfilment + flat item list below,
 * unchanged.
 */
export function PublicOrderTracking({ order }: { order: PublicTracking }) {
  const meta = ORDER_STATUS_META[order.status] ?? ORDER_STATUS_META.PENDING;
  const pickup = isStorePickupCode(order.shippingMethodCode);
  const trackingLink =
    order.trackingUrl && isSafeTrackingUrl(order.trackingUrl) ? order.trackingUrl : null;
  const hasFulfilment = Boolean(
    order.courier || order.trackingNumber || order.shippedAt || order.deliveredAt,
  );

  // Same threshold as order-detail.tsx: only a genuinely multi-seller order
  // splits into per-seller cards. The aggregate Order.courier/trackingNumber
  // fields describe at most one seller once every seller has finished, so they
  // must not be used as the source for multi-seller shipment display.
  const isMultiSeller = order.sellerOrders.length > 1;
  const { groups, ungrouped } = isMultiSeller
    ? groupOrderItemsBySeller(order.items, order.sellerOrders)
    : { groups: [], ungrouped: order.items };

  return (
    <div className="space-y-8">
      <div className="card-surface p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs text-ink-faint">Order {order.orderNumber}</p>
            <p className="mt-0.5 text-sm text-ink-soft">Placed {formatDate(order.placedAt)}</p>
          </div>
          <span
            className={cn(
              "rounded-full px-3 py-1 text-xs font-semibold",
              meta.tone === "positive" && "bg-sage-50 text-sage",
              meta.tone === "progress" && "bg-clay-50 text-clay",
              meta.tone === "neutral" && "bg-surface-sunken text-ink-soft",
              meta.tone === "negative" && "bg-clay-50 text-sale",
            )}
          >
            {meta.label}
          </span>
        </div>

        <div className="mt-6">
          <OrderTimeline
            status={order.status}
            events={order.events}
            pickup={pickup}
            paymentStatus={order.paymentStatus}
          />
        </div>
      </div>

      {/* Single-seller / legacy: the original aggregate fulfilment card, using
          the parent Order's own courier/trackingNumber — unchanged. */}
      {!isMultiSeller && hasFulfilment && order.status !== "CANCELLED" && (
        <div className="card-surface p-5 text-sm">
          <h2 className="flex items-center gap-1.5 text-lg">
            <Truck size={17} className="text-ink-soft" /> {pickup ? "Pickup" : "Delivery"}
          </h2>
          <dl className="mt-4 space-y-2">
            {order.courier && !pickup && (
              <div className="flex justify-between gap-4">
                <dt className="text-ink-faint">Courier</dt>
                <dd className="text-right">{courierLabel(order.courier, order.courierName)}</dd>
              </div>
            )}
            {order.trackingNumber && (
              <div className="flex justify-between gap-4">
                <dt className="text-ink-faint">Tracking number</dt>
                <dd className="text-right font-mono">{order.trackingNumber}</dd>
              </div>
            )}
            {order.shippedAt && (
              <div className="flex justify-between gap-4">
                <dt className="text-ink-faint">Shipped</dt>
                <dd className="text-right">{formatDate(order.shippedAt)}</dd>
              </div>
            )}
            {order.deliveredAt && (
              <div className="flex justify-between gap-4">
                <dt className="text-ink-faint">{pickup ? "Collected" : "Delivered"}</dt>
                <dd className="text-right">{formatDate(order.deliveredAt)}</dd>
              </div>
            )}
          </dl>
          {trackingLink && (
            <a
              href={trackingLink}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="btn btn-outline mt-4 w-full py-2 text-sm sm:w-auto"
            >
              Track parcel <ExternalLink size={13} />
            </a>
          )}
        </div>
      )}

      {isMultiSeller ? (
        <div className="space-y-4">
          {groups.map((g) => (
            <SellerTrackingGroup key={g.sellerOrder.id} sellerOrder={g.sellerOrder} items={g.items} />
          ))}
          {ungrouped.length > 0 && (
            <div className="card-surface p-5">
              <h2 className="text-lg">Other items</h2>
              <PublicItemList items={ungrouped} />
            </div>
          )}
        </div>
      ) : (
        <div className="card-surface p-5">
          <h2 className="text-lg">Items</h2>
          <PublicItemList items={ungrouped} />
        </div>
      )}
    </div>
  );
}

function PublicItemList({ items }: { items: PublicTrackingItem[] }) {
  return (
    <ul className="mt-3 divide-y divide-line text-sm">
      {items.map((it, i) => (
        <li key={i} className="flex justify-between gap-4 py-2.5">
          <span>
            {it.name}
            {it.variantLabel ? ` · ${it.variantLabel}` : ""}
          </span>
          <span className="shrink-0 text-ink-faint">Qty {it.quantity}</span>
        </li>
      ))}
    </ul>
  );
}

/** One seller's card on a multi-seller /track view: its own status, its own
 *  items, and its own shipment — the public-tracking counterpart of
 *  order-detail.tsx's `SellerItemGroup`. Only shipment fields that actually
 *  exist are shown; nothing is fabricated, and a not-yet-shipped seller says so
 *  plainly instead of rendering an empty card. */
function SellerTrackingGroup({
  sellerOrder,
  items,
}: {
  sellerOrder: CustomerOrderSellerOrder;
  items: PublicTrackingItem[];
}) {
  const ship = sellerOrder.shipments[0];
  const hasShipmentInfo = Boolean(
    ship?.carrier || ship?.trackingNumber || ship?.shippedAt || ship?.deliveredAt,
  );
  const trackingLink = ship?.trackingUrl && isSafeTrackingUrl(ship.trackingUrl) ? ship.trackingUrl : null;

  return (
    <div className="card-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-subtitle">
            {sellerOrder.sellerType === "FIRST_PARTY" ? "Sold by Axiaro" : `Sold by ${sellerOrder.sellerName}`}
          </h2>
        </div>
        <Badge tone={sellerOrderStatusTone(sellerOrder.status)}>
          {sellerOrderStatusLabel(sellerOrder.status)}
        </Badge>
      </div>

      <PublicItemList items={items} />

      <div className="mt-4 rounded-sm border border-line p-3 text-sm">
        <h3 className="flex items-center gap-1.5 font-medium text-ink-soft">
          <Truck size={14} /> Shipment
        </h3>
        {hasShipmentInfo ? (
          <>
            <dl className="mt-2 space-y-1.5">
              {ship?.carrier && (
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-faint">Courier</dt>
                  <dd className="text-right">{courierLabel(ship.carrier, ship.carrierName)}</dd>
                </div>
              )}
              {ship?.trackingNumber && (
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-faint">Tracking number</dt>
                  <dd className="text-right font-mono">{ship.trackingNumber}</dd>
                </div>
              )}
              {ship?.shippedAt && (
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-faint">Shipped</dt>
                  <dd className="text-right">{formatDate(ship.shippedAt)}</dd>
                </div>
              )}
              {ship?.deliveredAt && (
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-faint">Delivered</dt>
                  <dd className="text-right">{formatDate(ship.deliveredAt)}</dd>
                </div>
              )}
            </dl>
            {trackingLink && (
              <a
                href={trackingLink}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="btn btn-outline mt-3 w-full py-2 text-sm sm:w-auto"
              >
                Track parcel <ExternalLink size={13} />
              </a>
            )}
          </>
        ) : (
          <p className="mt-2 text-ink-faint">
            {sellerOrder.status === "CANCELLED" ? "This part of the order was cancelled." : "Not yet shipped."}
          </p>
        )}
      </div>
    </div>
  );
}
