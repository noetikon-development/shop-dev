import Link from "next/link";
import { ArrowRight, Package } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { getUserOrders } from "@/lib/data";
import { ORDER_STATUS_META } from "@/lib/constants";
import { formatPrice, formatDate } from "@/lib/utils";

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
              <p className="font-medium">
                Order {activeOrder.orderNumber} ·{" "}
                <span className="text-clay">{ORDER_STATUS_META[activeOrder.status]?.label}</span>
              </p>
              <p className="mt-0.5 text-sm text-ink-soft">
                {activeOrder.items.length} item{activeOrder.items.length > 1 ? "s" : ""} ·{" "}
                {formatPrice(activeOrder.grandTotal)}
              </p>
            </div>
            <Link
              href={`/account/orders/${activeOrder.orderNumber}`}
              className="btn btn-outline !py-2 text-sm"
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
          <h2 className="text-lg">Recent orders</h2>
          <Link href="/account/orders" className="text-sm text-ink-soft hover:text-ink">
            View all
          </Link>
        </div>

        {recent.length === 0 ? (
          <div className="mt-4 flex flex-col items-center rounded-lg border border-dashed border-line-strong py-14 text-center">
            <Package size={22} className="text-ink-faint" />
            <p className="mt-3 text-sm text-ink-soft">You haven&apos;t placed any orders yet.</p>
            <Link href="/c/all" className="btn btn-primary mt-4">
              Browse products
            </Link>
          </div>
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
                    <p className="mt-0.5 text-xs text-ink-faint">
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
      <p className="text-xs text-ink-faint">{label}</p>
      <p className="mt-1 font-display text-2xl">{value}</p>
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
