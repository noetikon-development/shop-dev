import Link from "next/link";
import { Card, StatusBadge } from "@/components/admin/ui";
import { ProductImage } from "@/components/product-image";
import { formatPrice, formatDate } from "@/lib/utils";
import { PAYMENT_METHODS } from "@/lib/constants";
import {
  orderStatusLabel,
  orderStatusTone,
  paymentStatusTone,
  PAYMENT_STATUS_LABEL,
} from "@/lib/orders/status";
import type { AdminOrderDetail } from "@/lib/admin/orders";
import { OrderAdminActions } from "./order-admin-actions";
import { FulfillmentPanel } from "./fulfillment-panel";

type Order = NonNullable<AdminOrderDetail>;

function dt(iso: string) {
  return formatDate(iso, { hour: "numeric", minute: "2-digit" });
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-ink-faint">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{children}</dd>
    </div>
  );
}

function SnapshotAddress({ a }: { a: Record<string, string> | null }) {
  if (!a) return <p className="mt-1 text-sm text-ink-faint">No address on file.</p>;
  const name = [a.firstName, a.lastName].filter(Boolean).join(" ") || a.recipient || "";
  const cityLine = [a.barangay, a.city, a.province, a.postalCode].filter(Boolean).join(", ");
  return (
    <address className="mt-1 not-italic text-sm leading-relaxed text-ink-soft">
      {name && <div className="text-ink">{name}</div>}
      {a.company && <div>{a.company}</div>}
      {a.line1 && <div>{a.line1}</div>}
      {a.line2 && <div>{a.line2}</div>}
      {cityLine && <div>{cityLine}</div>}
      {a.country && <div>{a.country}</div>}
      {a.phone && <div className="text-ink-faint">{a.phone}</div>}
    </address>
  );
}

export function OrderDetailView({
  order,
  forwardStatuses,
  cancellable,
  canManage,
  canConfirm = false,
  storePickup,
}: {
  order: Order;
  forwardStatuses: string[];
  cancellable: boolean;
  canManage: boolean;
  /** Pay-on-delivery "Confirm order" is available (PENDING_PAYMENT, no online payment). */
  canConfirm?: boolean;
  storePickup: boolean;
}) {
  const paymentMethod = PAYMENT_METHODS.find((p) => p.id === order.paymentMethod);
  const shippingMethodName =
    order.shippingMethodName ?? (order.shippingMethod ? order.shippingMethod : "—");

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      {/* Main column */}
      <div className="space-y-6">
        {/* Order information */}
        <Card>
          <h2 className="text-sm font-semibold text-ink">Order information</h2>
          <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Field label="Order number">
              <span className="font-mono">{order.orderNumber}</span>
            </Field>
            <Field label="Created">{dt(order.placedAt)}</Field>
            <Field label="Updated">{dt(order.updatedAt)}</Field>
            <Field label="Order status">
              <StatusBadge tone={orderStatusTone(order.status)}>
                {orderStatusLabel(order.status)}
              </StatusBadge>
            </Field>
            <Field label="Payment status">
              <StatusBadge tone={paymentStatusTone(order.paymentStatus)}>
                {PAYMENT_STATUS_LABEL[order.paymentStatus] ?? order.paymentStatus}
              </StatusBadge>
            </Field>
            <Field label="Payment method">
              {order.paymentMethod && order.paymentMethod !== "NONE"
                ? (paymentMethod?.label ?? order.paymentMethod)
                : "Not set"}
            </Field>
          </dl>
          {order.note && (
            <p className="mt-4 rounded-sm bg-surface-sunken px-3 py-2 text-sm text-ink-soft">
              <span className="font-medium text-ink">Customer note:</span> {order.note}
            </p>
          )}
        </Card>

        {/* Items */}
        <Card padded={false}>
          <h2 className="px-5 pt-5 text-sm font-semibold text-ink">
            Order items ({order.items.length})
          </h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead>
                <tr className="border-y border-line bg-surface-sunken/60 text-left text-xs uppercase tracking-wide text-ink-faint">
                  <th className="px-5 py-2.5 font-semibold">Product</th>
                  <th className="px-4 py-2.5 font-semibold">SKU</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Qty</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Unit price</th>
                  <th className="px-5 py-2.5 text-right font-semibold">Line total</th>
                </tr>
              </thead>
              <tbody>
                {order.items.map((it) => (
                  <tr key={it.id} className="border-b border-line/60 last:border-0">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <div className="h-11 w-9 shrink-0 overflow-hidden rounded-sm bg-surface-sunken">
                          <ProductImage src={it.imageUrl ?? "art:accessory:order"} alt={it.name} allowArt sizes="40px" />
                        </div>
                        <div className="min-w-0">
                          {it.productId ? (
                            <Link
                              href={`/admin/products/${it.productId}`}
                              className="font-medium text-ink hover:underline"
                            >
                              {it.name}
                            </Link>
                          ) : (
                            <span className="font-medium text-ink">{it.name}</span>
                          )}
                          {it.variantLabel && (
                            <p className="text-xs text-ink-faint">{it.variantLabel}</p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <code className="text-xs text-ink-soft">{it.sku ?? "—"}</code>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{it.quantity}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatPrice(it.unitPrice)}</td>
                    <td className="px-5 py-3 text-right font-medium tabular-nums">
                      {formatPrice(it.lineTotal)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="px-5 pb-4 pt-3 text-xs text-ink-faint">
            Prices, names and SKUs above are the immutable snapshot taken when the order was placed.
          </p>
        </Card>

        {/* Timeline */}
        <Card>
          <h2 className="text-sm font-semibold text-ink">Order timeline</h2>
          {order.events.length === 0 ? (
            <p className="mt-2 text-sm text-ink-faint">No events recorded.</p>
          ) : (
            <ol className="mt-4 space-y-4">
              {order.events.map((e) => (
                <li key={e.id} className="flex gap-3">
                  <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-ink" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink">
                      {e.title}{" "}
                      <span className="text-xs font-normal text-ink-faint">
                        · {orderStatusLabel(e.status)}
                      </span>
                    </p>
                    <p className="text-xs text-ink-faint">
                      {[e.location, dt(e.createdAt)].filter(Boolean).join(" · ")}
                    </p>
                    {e.detail && <p className="mt-0.5 text-sm text-ink-soft">{e.detail}</p>}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>

      {/* Sidebar */}
      <aside className="space-y-6">
        <OrderAdminActions
          orderId={order.id}
          status={order.status}
          forwardStatuses={forwardStatuses}
          cancellable={cancellable}
          canManage={canManage}
          canConfirm={canConfirm}
        />

        <FulfillmentPanel
          canManage={canManage}
          f={{
            orderId: order.id,
            status: order.status,
            storePickup,
            courier: order.courier,
            courierName: order.courierName,
            trackingNumber: order.trackingNumber,
            trackingUrl: order.trackingUrl,
            shippedAt: order.shippedAt,
            deliveredAt: order.deliveredAt,
            fulfillmentNote: order.fulfillmentNote,
          }}
        />

        <Card>
          <h2 className="text-sm font-semibold text-ink">Totals</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-ink-soft">Subtotal</dt>
              <dd className="tabular-nums">{formatPrice(order.subtotal)}</dd>
            </div>
            {order.discountTotal > 0 && (
              <div className="flex justify-between text-sage">
                <dt>Discount{order.couponCode ? ` · ${order.couponCode}` : ""}</dt>
                <dd className="tabular-nums">−{formatPrice(order.discountTotal)}</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-ink-soft">
                Shipping{order.shippingMethodName ? ` · ${order.shippingMethodName}` : ""}
              </dt>
              <dd className="tabular-nums">
                {order.shippingFee === 0 ? "Free" : formatPrice(order.shippingFee)}
              </dd>
            </div>
            <div className="flex justify-between border-t border-line pt-2.5 font-semibold">
              <dt>Grand total</dt>
              <dd className="font-display text-lg">{formatPrice(order.grandTotal)}</dd>
            </div>
          </dl>
        </Card>

        <Card>
          <h2 className="text-sm font-semibold text-ink">Customer</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <Field label="Name">{order.customerName}</Field>
            <Field label="Email">
              {order.user?.email ?? order.email}
              {order.user ? (
                <span className="ml-1.5 text-xs text-ink-faint">(account)</span>
              ) : (
                <span className="ml-1.5 text-xs text-ink-faint">(guest / no linked account)</span>
              )}
            </Field>
            <Field label="Phone">
              {order.phone || order.user?.phone || order.shippingAddress?.phone || "—"}
            </Field>
          </dl>
        </Card>

        <Card>
          <h2 className="text-sm font-semibold text-ink">Shipping</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <Field label="Method">
              {shippingMethodName}
              {order.shippingMethodCode && (
                <span className="ml-1.5 font-mono text-xs text-ink-faint">
                  {order.shippingMethodCode}
                </span>
              )}
            </Field>
            <Field label="Shipping fee">
              {order.shippingFee === 0 ? "Free" : formatPrice(order.shippingFee)}
            </Field>
          </dl>
          <h3 className="mt-4 text-xs uppercase tracking-wide text-ink-faint">Shipping address</h3>
          <SnapshotAddress a={order.shippingAddress} />
        </Card>

        <Card>
          <h2 className="text-sm font-semibold text-ink">Billing</h2>
          {order.billingAddress ? (
            <SnapshotAddress a={order.billingAddress} />
          ) : (
            <p className="mt-1 text-sm text-ink-soft">Same as the shipping address.</p>
          )}
        </Card>
      </aside>
    </div>
  );
}
