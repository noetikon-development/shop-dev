import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight, Package } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getUserOrders } from "@/lib/data";
import { ProductImage } from "@/components/product-image";
import { ORDER_STATUS_META } from "@/lib/constants";
import { orderStatusTone } from "@/lib/orders/status";
import { formatPrice, formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export const metadata: Metadata = { title: "Orders" };

export default async function OrdersPage() {
  const user = await requireUser("/account/orders");
  const orders = await getUserOrders(user.id);

  if (orders.length === 0) {
    return (
      <EmptyState
        icon={<Package size={24} />}
        title="No orders yet"
        message="Your orders will appear here once you check out."
        action={
          <Link href="/c/all" className={buttonClasses()}>
            Start shopping
          </Link>
        }
      />
    );
  }

  return (
    <div className="space-y-5">
      <h2 className="text-subtitle">Orders</h2>
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
                <Badge tone={orderStatusTone(o.status)}>{meta.label}</Badge>
              </div>
              <div className="flex items-center gap-4 px-5 py-4">
                <div className="flex -space-x-3">
                  {o.items.slice(0, 3).map((it) => (
                    <div
                      key={it.id}
                      className="h-12 w-10 overflow-hidden rounded-sm border border-line bg-surface-sunken"
                    >
                      <ProductImage src={it.imageUrl ?? "art:accessory:o"} alt={it.name} compact sizes="40px" />
                    </div>
                  ))}
                </div>
                <p className="min-w-0 flex-1 truncate text-meta text-ink-soft">
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
