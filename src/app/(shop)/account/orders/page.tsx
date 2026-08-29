import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight, Package } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getUserOrders } from "@/lib/data";
import { ProductImage } from "@/components/product-image";
import { ORDER_STATUS_META } from "@/lib/constants";
import { formatPrice, formatDate, cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Orders" };

export default async function OrdersPage() {
  const user = await requireUser("/account/orders");
  const orders = await getUserOrders(user.id);

  if (orders.length === 0) {
    return (
      <div className="flex flex-col items-center rounded-lg border border-dashed border-line-strong py-20 text-center">
        <Package size={24} className="text-ink-faint" />
        <h2 className="mt-4 text-lg">No orders yet</h2>
        <p className="mt-1.5 text-sm text-ink-soft">Your orders will appear here once you check out.</p>
        <Link href="/c/all" className="btn btn-primary mt-5">
          Start shopping
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <h2 className="text-lg">Orders</h2>
      <ul className="space-y-4">
        {orders.map((o) => {
          const meta = ORDER_STATUS_META[o.status] ?? ORDER_STATUS_META.PENDING;
          return (
            <li key={o.id} className="card-surface overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface px-5 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
                  <span className="font-medium">{o.orderNumber}</span>
                  <span className="text-ink-faint">{formatDate(o.placedAt)}</span>
                  <span className="text-ink-faint">{formatPrice(o.grandTotal)}</span>
                </div>
                <span
                  className={cn(
                    "rounded-full px-2.5 py-1 text-xs font-semibold",
                    meta.tone === "positive" && "bg-sage-50 text-sage",
                    meta.tone === "progress" && "bg-clay-50 text-clay",
                    meta.tone === "neutral" && "bg-surface-sunken text-ink-soft",
                    meta.tone === "negative" && "bg-clay-50 text-sale",
                  )}
                >
                  {meta.label}
                </span>
              </div>
              <div className="flex items-center gap-4 px-5 py-4">
                <div className="flex -space-x-3">
                  {o.items.slice(0, 3).map((it) => (
                    <div
                      key={it.id}
                      className="h-12 w-10 overflow-hidden rounded-sm border border-line bg-surface-sunken"
                    >
                      <ProductImage src={it.imageUrl ?? "art:accessory:o"} alt={it.name} />
                    </div>
                  ))}
                </div>
                <p className="min-w-0 flex-1 truncate text-sm text-ink-soft">
                  {o.items.map((it) => it.name).join(", ")}
                </p>
                <Link
                  href={`/account/orders/${o.orderNumber}`}
                  className="inline-flex shrink-0 items-center gap-1.5 text-sm font-medium hover:text-ink-soft"
                >
                  Details <ArrowRight size={14} />
                </Link>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
