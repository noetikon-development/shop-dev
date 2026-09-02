import Link from "next/link";
import { ArrowRight, Package } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { getUserOrders } from "@/lib/data";
import { ORDER_STATUS_META } from "@/lib/constants";
import { orderStatusTone } from "@/lib/orders/status";
import { formatPrice, formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export default async function AccountOverview() {
  const { id: userId } = await requireUser("/account");

  const [orders, addressCount, user] = await Promise.all([
    getUserOrders(userId),
    prisma.address.count({ where: { userId } }),
    prisma.user.findUnique({ where: { id: userId }, select: { email: true, createdAt: true } }),
  ]);

  const activeOrder = orders.find((o) => !["DELIVERED", "CANCELLED"].includes(o.status));
  const recent = orders.slice(0, 3);

  return (
    <div className="space-y-8">
      {activeOrder && (
        <div className="card-surface p-5">
          <p className="eyebrow">In progress</p>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
                Order {activeOrder.orderNumber}
                <Badge tone={orderStatusTone(activeOrder.status)}>
                  {ORDER_STATUS_META[activeOrder.status]?.label}
                </Badge>
              </p>
              <p className="mt-1 text-meta text-ink-soft">
                {activeOrder.items.length} item{activeOrder.items.length > 1 ? "s" : ""} ·{" "}
                {formatPrice(activeOrder.grandTotal)}
              </p>
            </div>
            <Link
              href={`/account/orders/${activeOrder.orderNumber}`}
              className={buttonClasses({ variant: "outline", size: "sm" })}
            >
              Track order
            </Link>
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Orders" value={String(orders.length)} href="/account/orders" />
        <Stat label="Saved addresses" value={String(addressCount)} href="/account/addresses" />
        <Stat
          label="Member since"
          value={user ? formatDate(user.createdAt, { month: "short", year: "numeric" }) : "—"}
        />
      </div>

      <section>
        <div className="flex items-center justify-between">
          <h2 className="text-subtitle">Recent orders</h2>
          <Link href="/account/orders" className="text-meta font-medium text-ink-soft hover:text-ink">
            View all
          </Link>
        </div>

        {recent.length === 0 ? (
          <EmptyState
            className="mt-4"
            icon={<Package size={22} />}
            title="No orders yet"
            message="You haven't placed any orders yet."
            action={
              <Link href="/c/all" className={buttonClasses()}>
                Browse products
              </Link>
            }
          />
        ) : (
          <ul className="mt-4 divide-y divide-line border-y border-line">
            {recent.map((o) => (
              <li key={o.id}>
                <Link
                  href={`/account/orders/${o.orderNumber}`}
                  className="flex items-center justify-between gap-4 py-4 transition-colors hover:bg-surface"
                >
                  <div>
                    <p className="text-sm font-medium">{o.orderNumber}</p>
                    <p className="mt-0.5 text-meta text-ink-faint">
                      {formatDate(o.placedAt)} · {ORDER_STATUS_META[o.status]?.label}
                    </p>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-sm tabular-nums">{formatPrice(o.grandTotal)}</span>
                    <ArrowRight size={15} className="text-ink-faint" />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, href }: { label: string; value: string; href?: string }) {
  const body = (
    <div className="card-surface p-4">
      <p className="text-meta text-ink-faint">{label}</p>
      <p className="mt-1 font-display text-title">{value}</p>
    </div>
  );
  return href ? (
    <Link href={href} className="transition-opacity hover:opacity-80">
      {body}
    </Link>
  ) : (
    body
  );
}
