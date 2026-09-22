import Link from "next/link";
import { ExternalLink, Truck } from "lucide-react";
import { ProductImage } from "@/components/product-image";
import { OrderTimeline } from "@/components/order/order-timeline";
import { CompletePaymentButton } from "@/components/order/complete-payment-button";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { ORDER_STATUS_META, PAYMENT_METHODS } from "@/lib/constants";
import { orderStatusTone } from "@/lib/orders/status";
import { courierLabel, isSafeTrackingUrl, isStorePickupCode } from "@/lib/orders/couriers";
import { conditionLabel, isNoteworthyCondition } from "@/lib/seller/format";
import { formatPrice, formatDate, discountPercent } from "@/lib/utils";
import { countryName } from "@/lib/countries";
import { groupOrderItemsBySeller, type CustomerOrderSellerOrder } from "@/lib/marketplace/customer-order-view";
import { sellerOrderStatusLabel, sellerOrderStatusTone } from "@/lib/marketplace/seller-order-status";
import type { OrderView } from "@/lib/data";

type OrderItemRow = NonNullable<OrderView>["items"][number];

// Store Pickup order-confirmation display (9F-49 confirmation-page step).
// Shape mirrors exactly what checkout.ts's createOrderFromCart freezes onto
// SellerOrder.pickupLocationSnapshot at order time — server-written, not
// customer input, so a light presence check (not full re-validation) is
// enough here. `recipient` exists in the stored snapshot but is deliberately
// NOT surfaced on this card — it's the store's own internal contact, not
// customer-relevant to "where do I go".
type PickupLocationSnapshot = {
  name: string;
  line1: string;
  line2: string | null;
  barangay: string | null;
  city: string;
  province: string;
  postalCode: string;
  country: string;
  phone: string;
  instructions: string | null;
};

function asPickupLocationSnapshot(v: unknown): PickupLocationSnapshot | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.name !== "string" || typeof o.line1 !== "string") return null;
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : null);
  return {
    name: o.name,
    line1: o.line1,
    line2: str("line2"),
    barangay: str("barangay"),
    city: str("city") ?? "",
    province: str("province") ?? "",
    postalCode: str("postalCode") ?? "",
    country: str("country") ?? "",
    phone: str("phone") ?? "",
    instructions: str("instructions"),
  };
}

export function OrderDetail({
  order,
  // When true (only the account order-detail page passes this, after
  // `canResumeOnlinePayment`), the Payment section reads "Payment pending" and
  // offers a persistent "Pay now" that runs the same beginOnlinePayment flow.
  onlinePayable = false,
}: {
  order: NonNullable<OrderView>;
  onlinePayable?: boolean;
}) {
  const meta = ORDER_STATUS_META[order.status] ?? ORDER_STATUS_META.PENDING;
  const addr = order.shippingAddress;
  const billing = order.billingAddress;
  const pickup = isStorePickupCode(order.shippingMethodCode);
  const trackingLink =
    order.trackingUrl && isSafeTrackingUrl(order.trackingUrl) ? order.trackingUrl : null;
  const showFulfilment =
    Boolean(order.courier || order.trackingNumber || order.shippedAt || order.deliveredAt) &&
    order.status !== "CANCELLED";
  const payment = PAYMENT_METHODS.find((p) => p.id === order.paymentMethod);
  const paymentLabel =
    order.paymentStatus === "PAID"
      ? "Paid"
      : order.paymentStatus === "REFUNDED"
        ? "Refunded"
        : order.paymentStatus === "PENDING"
          ? onlinePayable
            ? "Payment pending"
            : pickup
              ? "Pay in cash when you collect your order."
              : "Pay on delivery"
          : "Unpaid";

  // Store Pickup order-confirmation display (9F-49). Single-seller placement
  // only (exactly one SellerOrder) — the multi-seller path below renders its
  // own per-SellerOrder snapshot inside SellerItemGroup instead, so two
  // different sellers' snapshots (once seller-owned pickup locations exist)
  // can never be merged into one card.
  const singleSellerPickupSnapshot =
    order.sellerOrders.length === 1
      ? asPickupLocationSnapshot(order.sellerOrders[0]?.pickupLocationSnapshot)
      : null;

  // Multi-seller presentation (customer order UI phase): a genuinely
  // multi-seller order (more than one SellerOrder) is grouped so each
  // seller's own status and shipment are visible — a single-seller or legacy
  // (zero-SellerOrder) order keeps the exact flat list it always had.
  const isMultiSeller = order.sellerOrders.length > 1;
  const { groups: sellerGroups, ungrouped: ungroupedItems } = isMultiSeller
    ? groupOrderItemsBySeller(order.items, order.sellerOrders)
    : { groups: [], ungrouped: order.items };

  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_340px]">
      <div className="space-y-8">
        <div className="card-surface p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-meta text-ink-faint">Order {order.orderNumber}</p>
              <p className="mt-0.5 text-sm text-ink-soft">
                Placed {formatDate(order.placedAt)}
              </p>
            </div>
            <Badge tone={orderStatusTone(order.status)}>{meta.label}</Badge>
          </div>

          <div className="mt-6">
            <OrderTimeline
              status={order.status}
              events={order.events}
              pickup={pickup}
              sellerOrders={order.sellerOrders}
              paymentStatus={order.paymentStatus}
            />
          </div>
        </div>

        {isMultiSeller ? (
          <>
            {sellerGroups.map((g) => (
              <SellerItemGroup key={g.sellerOrder.id} sellerOrder={g.sellerOrder} items={g.items} />
            ))}
            {ungroupedItems.length > 0 && (
              <div className="card-surface p-5">
                <h2 className="text-subtitle">Other items</h2>
                <ul className="mt-4 divide-y divide-line">
                  {ungroupedItems.map((it) => (
                    <ItemRow key={it.id} it={it} />
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : (
          <div className="card-surface p-5">
            <h2 className="text-subtitle">Items</h2>
            <ul className="mt-4 divide-y divide-line">
              {order.items.map((it) => (
                <ItemRow key={it.id} it={it} />
              ))}
            </ul>
          </div>
        )}
      </div>

      <aside className="space-y-6">
        <div className="card-surface p-5">
          <h2 className="text-subtitle">Summary</h2>
          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-ink-soft">Subtotal</dt>
              <dd className="tabular-nums">{formatPrice(order.subtotal)}</dd>
            </div>
            {order.discountTotal > 0 && (
              <div className="flex justify-between text-success">
                <dt>Discount{order.couponCode ? ` · ${order.couponCode}` : ""}</dt>
                <dd className="tabular-nums">−{formatPrice(order.discountTotal)}</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-ink-soft">
                Shipping
                {order.shippingMethodName ? ` · ${order.shippingMethodName}` : ""}
              </dt>
              <dd className="tabular-nums">
                {order.shippingFee === 0 ? "Free" : formatPrice(order.shippingFee)}
              </dd>
            </div>
            <div className="flex justify-between border-t border-line pt-2.5 font-medium">
              <dt>Total</dt>
              <dd className="font-display text-subtitle">{formatPrice(order.grandTotal)}</dd>
            </div>
          </dl>
        </div>

        {/* Multi-seller: each SellerOrder's own shipment card (below, per
            group) replaces this aggregate one — the aggregate Order fields
            describe at most one seller's shipment once the rollup fires, which
            is misleading once there's more than one seller on the order. */}
        {!isMultiSeller && showFulfilment && (
          <div className="card-surface p-5 text-sm">
            <h3 className="flex items-center gap-1.5 font-medium">
              <Truck size={15} className="text-ink-soft" /> {pickup ? "Pickup" : "Delivery"}
            </h3>
            <dl className="mt-3 space-y-2">
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
                className={buttonClasses({ variant: "outline", size: "sm", className: "mt-4 w-full" })}
              >
                Track parcel <ExternalLink size={13} />
              </a>
            )}
          </div>
        )}

        {pickup && singleSellerPickupSnapshot && (
          <PickupLocationCard snapshot={singleSellerPickupSnapshot} />
        )}

        <div className="card-surface p-5 text-sm">
          <h3 className="font-medium">{pickup ? "Your details" : "Delivery address"}</h3>
          <SnapshotAddress a={addr} />

          {billing && (
            <>
              <h3 className="mt-4 font-medium">Billing address</h3>
              <SnapshotAddress a={billing} />
            </>
          )}

          <h3 className="mt-4 font-medium">Payment</h3>
          <p className="mt-1 text-ink-soft">
            {order.paymentMethod && order.paymentMethod !== "NONE"
              ? `${payment?.label ?? order.paymentMethod} · `
              : ""}
            <span className={order.paymentStatus === "PAID" ? "text-success" : "text-ink-soft"}>
              {paymentLabel}
            </span>
          </p>
          {onlinePayable && (
            <div className="mt-3">
              <CompletePaymentButton orderNumber={order.orderNumber} label="Pay now" />
              <p className="mt-2 text-meta text-ink-faint">
                You’ll be taken to our secure payment page. Or pay cash on delivery — either way
                your order is saved.
              </p>
            </div>
          )}
        </div>

        <Link href="/c/all" className={buttonClasses({ variant: "outline", className: "w-full" })}>
          Continue shopping
        </Link>
      </aside>
    </div>
  );
}

/** One order line — extracted so the single-seller flat list and each
 *  multi-seller group render identical item rows. */
function ItemRow({ it }: { it: OrderItemRow }) {
  // 9F-38B: show the historical markdown ONLY from the frozen snapshot
  // (`originalUnitPrice`) — never the current Offer. NULL / <= unitPrice
  // (pre-9F-38B lines, or no compare-at at purchase) → display exactly
  // as before. The percentage is DERIVED via discountPercent().
  const hadMarkdown = it.originalUnitPrice != null && it.originalUnitPrice > it.unitPrice;
  const wasLineTotal = hadMarkdown ? it.originalUnitPrice! * it.quantity : 0;
  const offPercent = hadMarkdown ? discountPercent(it.unitPrice, it.originalUnitPrice) : 0;
  return (
    <li className="flex gap-4 py-4">
      <div className="h-20 w-16 shrink-0 overflow-hidden rounded-sm bg-surface-sunken">
        <ProductImage src={it.imageUrl ?? "art:accessory:order"} alt={it.name} compact sizes="64px" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{it.name}</p>
        {it.variantLabel && <p className="mt-0.5 text-meta text-ink-faint">{it.variantLabel}</p>}
        {isNoteworthyCondition(it.condition) && (
          <p className="mt-0.5 text-meta text-ink-soft">Condition: {conditionLabel(it.condition!)}</p>
        )}
        <p className="mt-1 text-meta text-ink-faint">Qty {it.quantity}</p>
      </div>
      <div className="shrink-0 text-right">
        <span className="text-sm font-medium tabular-nums">{formatPrice(it.lineTotal)}</span>
        {hadMarkdown && offPercent > 0 && (
          <p className="mt-0.5 text-meta text-ink-faint tabular-nums">
            <s>{formatPrice(wasLineTotal)}</s> <span className="text-success">−{offPercent}%</span>
          </p>
        )}
      </div>
    </li>
  );
}

/** One seller's card on a multi-seller order: its own status, its own items,
 *  and its own shipment (never the aggregate Order.courier/trackingNumber —
 *  those describe at most one seller once every seller has finished). Only
 *  shipment fields that actually exist are shown; nothing is fabricated. */
function SellerItemGroup({
  sellerOrder,
  items,
}: {
  sellerOrder: CustomerOrderSellerOrder;
  items: OrderItemRow[];
}) {
  const ship = sellerOrder.shipments[0];
  const hasShipmentInfo = Boolean(ship?.carrier || ship?.trackingNumber || ship?.shippedAt || ship?.deliveredAt);
  const trackingLink = ship?.trackingUrl && isSafeTrackingUrl(ship.trackingUrl) ? ship.trackingUrl : null;
  // Multi-seller Store Pickup (9F-49): THIS seller's own frozen snapshot only
  // — never another SellerOrder's. Deliberately per-group, not hoisted to the
  // page level, so two sellers' pickup locations (once seller-owned pickup
  // locations exist) can never be merged into one shared display.
  const pickupSnapshot = asPickupLocationSnapshot(sellerOrder.pickupLocationSnapshot);

  return (
    <div className="card-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-subtitle">{sellerOrder.sellerName}</h2>
          {/* Clarify who fulfils this seller's items: the platform (FIRST_PARTY)
              or an independent marketplace seller (THIRD_PARTY). Uses the
              already-fetched sellerType/sellerName — no new data. */}
          <p className="mt-0.5 text-xs text-ink-faint">
            {sellerOrder.sellerType === "FIRST_PARTY"
              ? "Sold by Axiaro"
              : `Sold by ${sellerOrder.sellerName}`}
          </p>
        </div>
        <Badge tone={sellerOrderStatusTone(sellerOrder.status)}>{sellerOrderStatusLabel(sellerOrder.status)}</Badge>
      </div>
      <ul className="mt-4 divide-y divide-line">
        {items.map((it) => (
          <ItemRow key={it.id} it={it} />
        ))}
      </ul>
      {pickupSnapshot && (
        <div className="mt-4 rounded-sm border border-line p-3 text-sm">
          <h3 className="font-medium text-ink-soft">Pickup location</h3>
          <address className="mt-1 not-italic text-ink-soft">
            {pickupSnapshot.name}
            <br />
            {pickupSnapshot.line1}
            {pickupSnapshot.line2 ? (
              <>
                <br />
                {pickupSnapshot.line2}
              </>
            ) : null}
            <br />
            {[pickupSnapshot.barangay, pickupSnapshot.city, pickupSnapshot.province, pickupSnapshot.postalCode]
              .filter(Boolean)
              .join(", ")}
            <br />
            {countryName(pickupSnapshot.country)}
            <br />
            {pickupSnapshot.phone}
          </address>
          {pickupSnapshot.instructions && (
            <p className="mt-2 text-ink-faint">{pickupSnapshot.instructions}</p>
          )}
        </div>
      )}
      {hasShipmentInfo && (
        <div className="mt-4 rounded-sm border border-line p-3 text-sm">
          <h3 className="flex items-center gap-1.5 font-medium text-ink-soft">
            <Truck size={14} /> Shipment
          </h3>
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
              className={buttonClasses({ variant: "outline", size: "sm", className: "mt-3 w-full" })}
            >
              Track parcel <ExternalLink size={13} />
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function SnapshotAddress({ a }: { a: Record<string, string> }) {
  const name = [a.firstName, a.lastName].filter(Boolean).join(" ") || a.recipient;
  return (
    <address className="mt-2 not-italic text-ink-soft">
      {name}
      {a.company ? (
        <>
          <br />
          {a.company}
        </>
      ) : null}
      <br />
      {a.line1}
      {a.line2 ? (
        <>
          <br />
          {a.line2}
        </>
      ) : null}
      <br />
      {[a.barangay, a.city, a.province, a.postalCode].filter(Boolean).join(", ")}
      <br />
      {a.phone}
    </address>
  );
}

/** Store Pickup order-confirmation card (9F-49). Renders the FROZEN
 *  `SellerOrder.pickupLocationSnapshot` — never the live `PickupLocation` row
 *  — so a later CMS edit or deactivation of the location never changes what
 *  an already-placed order shows the customer. No internal id is displayed;
 *  `recipient` is intentionally omitted (the store's own contact, not
 *  customer-relevant here). Mirrors `SnapshotAddress`'s exact address layout. */
function PickupLocationCard({ snapshot }: { snapshot: PickupLocationSnapshot }) {
  return (
    <div className="card-surface p-5 text-sm">
      <h3 className="font-medium">Pickup location</h3>
      <address className="mt-2 not-italic text-ink-soft">
        {snapshot.name}
        <br />
        {snapshot.line1}
        {snapshot.line2 ? (
          <>
            <br />
            {snapshot.line2}
          </>
        ) : null}
        <br />
        {[snapshot.barangay, snapshot.city, snapshot.province, snapshot.postalCode].filter(Boolean).join(", ")}
        <br />
        {countryName(snapshot.country)}
        <br />
        {snapshot.phone}
      </address>
      {snapshot.instructions && (
        <p className="mt-3 text-ink-faint">{snapshot.instructions}</p>
      )}
    </div>
  );
}
