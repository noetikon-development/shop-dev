import Link from "next/link";
import { ProductImage } from "@/components/product-image";
import { OrderTimeline } from "@/components/order/order-timeline";
import { ORDER_STATUS_META, PAYMENT_METHODS } from "@/lib/constants";
import { formatPrice, formatDate, cn } from "@/lib/utils";
import type { OrderView } from "@/lib/data";

export function OrderDetail({ order }: { order: NonNullable<OrderView> }) {
  const meta = ORDER_STATUS_META[order.status] ?? ORDER_STATUS_META.PENDING;
  const addr = order.shippingAddress;
  const billing = order.billingAddress;
  const payment = PAYMENT_METHODS.find((p) => p.id === order.paymentMethod);
  const paymentLabel =
    order.paymentStatus === "PAID"
      ? "Paid"
      : order.paymentStatus === "REFUNDED"
        ? "Refunded"
        : order.paymentStatus === "PENDING"
          ? "Awaiting payment"
          : "Unpaid";

  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_340px]">
      <div className="space-y-8">
        <div className="card-surface p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs text-ink-faint">Order {order.orderNumber}</p>
              <p className="mt-0.5 text-sm text-ink-soft">
                Placed {formatDate(order.placedAt)}
              </p>
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
            <OrderTimeline status={order.status} events={order.events} />
          </div>
        </div>

        <div className="card-surface p-5">
          <h2 className="text-lg">Items</h2>
          <ul className="mt-4 divide-y divide-line">
            {order.items.map((it) => (
              <li key={it.id} className="flex gap-4 py-4">
                <div className="h-20 w-16 shrink-0 overflow-hidden rounded-sm bg-surface-sunken">
                  <ProductImage src={it.imageUrl ?? "art:accessory:order"} alt={it.name} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{it.name}</p>
                  {it.variantLabel && (
                    <p className="mt-0.5 text-xs text-ink-faint">{it.variantLabel}</p>
                  )}
                  <p className="mt-1 text-xs text-ink-faint">Qty {it.quantity}</p>
                </div>
                <span className="text-sm font-medium tabular-nums">{formatPrice(it.lineTotal)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <aside className="space-y-6">
        <div className="card-surface p-5">
          <h2 className="text-lg">Summary</h2>
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
              <dt className="text-ink-soft">Shipping</dt>
              <dd className="tabular-nums">
                {order.shippingFee === 0 ? "Free" : formatPrice(order.shippingFee)}
              </dd>
            </div>
            <div className="flex justify-between border-t border-line pt-2.5 font-medium">
              <dt>Total</dt>
              <dd className="font-display text-lg">{formatPrice(order.grandTotal)}</dd>
            </div>
          </dl>
        </div>

        <div className="card-surface p-5 text-sm">
          <h3 className="font-medium">Delivery address</h3>
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
        </div>

        <Link href="/c/all" className="btn btn-outline w-full">
          Continue shopping
        </Link>
      </aside>
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
