import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireAnyPermission } from "@/lib/admin/rbac";
import { getAdminSellerOrder } from "@/lib/admin/seller-orders";
import { sellerOrderStatusLabel, sellerOrderStatusTone } from "@/lib/marketplace/seller-order-status";
import { pesos } from "@/lib/seller/format";
import { Card, PageHeader, StatusBadge } from "@/components/admin/ui";

export async function generateMetadata({
  params,
}: PageProps<"/admin/seller-orders/[id]">): Promise<Metadata> {
  const { id } = await params;
  const so = await getAdminSellerOrder(id);
  return { title: so ? `Seller order · ${so.sellerName} · ${so.order.orderNumber}` : "Seller order" };
}

export default async function AdminSellerOrderDetailPage({ params }: PageProps<"/admin/seller-orders/[id]">) {
  await requireAnyPermission(["view_orders", "manage_orders"]);
  const { id } = await params;

  const so = await getAdminSellerOrder(id);
  if (!so) notFound();

  return (
    <div>
      <Link
        href="/admin/seller-orders"
        className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink"
      >
        <ChevronLeft size={15} /> All seller orders
      </Link>

      <PageHeader
        title={`${so.sellerName} — ${so.order.orderNumber}`}
        description={`Parent order placed by ${so.order.customerName ?? so.order.email} on ${new Date(so.order.placedAt).toLocaleString()}`}
        actions={<StatusBadge tone={sellerOrderStatusTone(so.status)}>{sellerOrderStatusLabel(so.status)}</StatusBadge>}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <Card padded={false}>
            <div className="border-b border-line px-5 py-3">
              <h2 className="text-sm font-semibold">Items</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface-sunken/60 text-xs uppercase tracking-wide text-ink-faint">
                    <th className="px-4 py-2 text-left">Item</th>
                    <th className="px-4 py-2 text-left">SKU</th>
                    <th className="px-4 py-2 text-right">Unit price</th>
                    <th className="px-4 py-2 text-right">Qty</th>
                    <th className="px-4 py-2 text-right">Line total</th>
                  </tr>
                </thead>
                <tbody>
                  {so.items.map((it) => (
                    <tr key={it.id} className="border-b border-line/60 last:border-0">
                      <td className="px-4 py-2.5">
                        <span className="text-ink">{it.name}</span>
                        {it.variantLabel && <span className="block text-xs text-ink-faint">{it.variantLabel}</span>}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-ink-soft">{it.sku ?? "—"}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-ink-soft">{pesos(it.unitPrice)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-ink-soft">{it.quantity}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-ink-soft">{pesos(it.lineTotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card>
            <h2 className="mb-3 text-sm font-semibold">Parent order</h2>
            <dl className="grid gap-3 sm:grid-cols-2 text-sm">
              <div>
                <dt className="text-xs text-ink-faint">Order</dt>
                <dd>
                  <Link href={`/admin/orders/${so.order.id}`} className="text-clay hover:underline">
                    {so.order.orderNumber}
                  </Link>
                </dd>
              </div>
              <div><dt className="text-xs text-ink-faint">Order status</dt><dd>{so.order.status}</dd></div>
              <div><dt className="text-xs text-ink-faint">Customer</dt><dd>{so.order.customerName ?? "—"}</dd></div>
              <div><dt className="text-xs text-ink-faint">Email</dt><dd>{so.order.email}</dd></div>
            </dl>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <h2 className="mb-3 text-sm font-semibold">Seller</h2>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-xs text-ink-faint">Seller</dt>
                <dd>
                  <Link href={`/admin/sellers/${so.sellerId}`} className="text-clay hover:underline">
                    {so.sellerName}
                  </Link>
                  <span className="ml-2 text-xs text-ink-faint">{so.sellerType === "FIRST_PARTY" ? "1P" : "3P"}</span>
                </dd>
              </div>
              <div><dt className="text-xs text-ink-faint">Support email</dt><dd>{so.supportEmail}</dd></div>
            </dl>
          </Card>

          <Card>
            <h2 className="mb-3 text-sm font-semibold">Money</h2>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-ink-faint">Merchandise subtotal</dt><dd className="tabular-nums">{pesos(so.merchandiseSubtotal)}</dd></div>
              <div className="flex justify-between"><dt className="text-ink-faint">Discount allocated</dt><dd className="tabular-nums">−{pesos(so.discountAllocated)}</dd></div>
              <div className="flex justify-between"><dt className="text-ink-faint">Shipping fee{so.freeShippingApplied ? " (waived)" : ""}</dt><dd className="tabular-nums">{pesos(so.shippingFee)}</dd></div>
              <div className="flex justify-between border-t border-line pt-2 font-medium"><dt>Total</dt><dd className="tabular-nums">{pesos(so.total)}</dd></div>
            </dl>
          </Card>

          <Card>
            <h2 className="mb-3 text-sm font-semibold">Commission</h2>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-ink-faint">Rate</dt><dd className="tabular-nums">{(so.commissionRate / 100).toFixed(2)}%</dd></div>
              <div className="flex justify-between font-medium"><dt>Amount</dt><dd className="tabular-nums">{pesos(so.commissionAmount)}</dd></div>
            </dl>
            <p className="mt-3 text-xs text-ink-faint">
              Calculated, stored value — corrected for cancellation/return (9F-8c/9F-8c.1). Not a settlement or payout
              figure; settlement status is <span className="font-medium text-ink-soft">{so.settlementStatus}</span>.
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}
