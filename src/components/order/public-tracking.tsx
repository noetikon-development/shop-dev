import { ExternalLink, Truck } from "lucide-react";
import { OrderTimeline } from "@/components/order/order-timeline";
import { ORDER_STATUS_META } from "@/lib/constants";
import { courierLabel, isSafeTrackingUrl, isStorePickupCode } from "@/lib/orders/couriers";
import { formatDate, cn } from "@/lib/utils";
import type { PublicTracking } from "@/lib/data";

/**
 * Public /track view. Deliberately narrow: order number, status, fulfilment
 * (courier / tracking / dates), a short item list and the timeline. No customer
 * email, phone, address, billing, prices or internal notes are rendered here.
 */
export function PublicOrderTracking({ order }: { order: PublicTracking }) {
  const meta = ORDER_STATUS_META[order.status] ?? ORDER_STATUS_META.PENDING;
  const pickup = isStorePickupCode(order.shippingMethodCode);
  const trackingLink =
    order.trackingUrl && isSafeTrackingUrl(order.trackingUrl) ? order.trackingUrl : null;
  const hasFulfilment = Boolean(
    order.courier || order.trackingNumber || order.shippedAt || order.deliveredAt,
  );

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
          <OrderTimeline status={order.status} events={order.events} pickup={pickup} />
        </div>
      </div>

      {hasFulfilment && order.status !== "CANCELLED" && (
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

      <div className="card-surface p-5">
        <h2 className="text-lg">Items</h2>
        <ul className="mt-3 divide-y divide-line text-sm">
          {order.items.map((it, i) => (
            <li key={i} className="flex justify-between gap-4 py-2.5">
              <span>
                {it.name}
                {it.variantLabel ? ` · ${it.variantLabel}` : ""}
              </span>
              <span className="shrink-0 text-ink-faint">Qty {it.quantity}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
