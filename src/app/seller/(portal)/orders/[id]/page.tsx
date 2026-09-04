import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireSellerSession } from "@/lib/seller/session";
import { sellerCan } from "@/lib/marketplace/seller-context";
import { getSellerOrderDetail } from "@/lib/seller/orders";
import { PageHeader, Card, StatusBadge } from "@/components/seller/ui";
import { pesos } from "@/lib/seller/format";
import { sellerOrderStatusLabel, sellerOrderStatusTone } from "@/lib/marketplace/seller-order-status";
import { OrderFulfillmentPanel } from "@/components/seller/order-fulfillment-panel";

export const metadata: Metadata = { title: "Order" };

export default async function SellerOrderDetailPage({ params }: PageProps<"/seller/orders/[id]">) {
  const { ctx } = await requireSellerSession("/seller/orders");
  const { id } = await params;
  const order = await getSellerOrderDetail(ctx, id);
  if (!order) notFound();

  const canFulfil = sellerCan(ctx, "manage_seller_fulfillment");

  return (
    <div>
      <PageHeader
        title={order.orderNumber}
        description={`Placed ${order.placedAt.toISOString().slice(0, 10)} · ${order.shippingMethodName ?? "Standard"}`}
        actions={
          <StatusBadge tone={sellerOrderStatusTone(order.status)}>
            {sellerOrderStatusLabel(order.status)}
          </StatusBadge>
        }
      />
      <Link
        href="/seller/orders"
        className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink"
      >
        <ArrowLeft size={14} /> Back to Orders
      </Link>

      <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        <div className="space-y-6">
          <Card padded={false}>
            <div className="border-b border-line px-5 py-3">
              <h2 className="text-sm font-semibold">Items ({order.items.length})</h2>
            </div>
            <ul className="divide-y divide-line-soft">
              {order.items.map((it) => (
                <li key={it.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-ink">{it.name}</span>
                    <span className="block truncate text-xs text-ink-faint">
                      {[it.variantLabel, it.sku].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  <span className="tabular-nums text-ink-faint">
                    {pesos(it.unitPrice)} × {it.quantity}
                  </span>
                  <span className="w-20 text-right tabular-nums font-medium text-ink">{pesos(it.lineTotal)}</span>
                </li>
              ))}
            </ul>
            <dl className="space-y-1.5 border-t border-line px-5 py-4 text-sm">
              <Line label="Merchandise" value={pesos(order.merchandiseSubtotal)} />
              {order.discountAllocated > 0 && (
                <Line label="Discount" value={`− ${pesos(order.discountAllocated)}`} />
              )}
              <Line label="Shipping" value={order.shippingFee === 0 ? "Free" : pesos(order.shippingFee)} />
              <Line label="Your payout basis" value={pesos(order.total)} strong />
            </dl>
          </Card>

          <Card>
            <h2 className="mb-3 text-sm font-semibold">Ship to</h2>
            {order.ship ? (
              <address className="not-italic text-sm text-ink-soft">
                <span className="font-medium text-ink">{order.ship.recipient}</span>
                {order.ship.phone && <span className="block">{order.ship.phone}</span>}
                {order.ship.lines.map((l, i) => (
                  <span key={i} className="block">
                    {l}
                  </span>
                ))}
              </address>
            ) : (
              <p className="text-sm text-ink-faint">No address on file.</p>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <h2 className="mb-3 text-sm font-semibold">Fulfilment</h2>
            {order.parentCancelled ? (
              <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">
                This order was cancelled. No fulfilment actions are available.
              </p>
            ) : !order.parentFulfillable ? (
              <p className="rounded-sm bg-warning-50 px-3 py-2 text-sm text-warning">
                Waiting for the order to be confirmed. You’ll be able to start once payment is cleared.
              </p>
            ) : canFulfil ? (
              <OrderFulfillmentPanel
                sellerOrderId={order.id}
                status={order.status}
                allowedMoves={order.allowedMoves}
                shipment={order.shipment}
              />
            ) : (
              <p className="text-sm text-ink-faint">
                You have view-only access. Ask an owner or manager to fulfil this order.
              </p>
            )}
          </Card>

          <Card>
            <h2 className="mb-3 text-sm font-semibold">Parent order</h2>
            <p className="text-sm text-ink-soft">
              Axiaro order status: <strong className="text-ink">{order.parentStatus}</strong>. Your
              fulfilment status is tracked separately and does not change the customer-facing order.
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between">
      <dt className={strong ? "font-medium text-ink" : "text-ink-faint"}>{label}</dt>
      <dd className={strong ? "font-medium text-ink tabular-nums" : "text-ink-soft tabular-nums"}>{value}</dd>
    </div>
  );
}
