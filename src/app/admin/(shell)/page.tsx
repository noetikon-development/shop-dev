import type { Metadata } from "next";
import Link from "next/link";
import {
  ShoppingBag,
  Users,
  Package,
  TriangleAlert,
  Receipt,
  ArrowUpRight,
} from "lucide-react";
import { requirePermission } from "@/lib/admin/rbac";
import { prisma } from "@/lib/prisma";
import { getAdminRoute, routeAllowed, ADMIN_ROUTES } from "@/lib/admin/navigation";
import {
  PageHeader,
  Card,
  CardHeader,
  StatCard,
  EmptyState,
} from "@/components/admin/ui";

export const metadata: Metadata = { title: "Dashboard" };

export default async function AdminDashboard() {
  const admin = await requirePermission("view_dashboard");
  const can = (perm: string) => admin.isSuperAdmin || admin.permissions.has(perm);

  // Honest, non-analytics counts only. Revenue/sales metrics stay as
  // placeholders until analytics is built.
  const [productCount, categoryCount, customerCount, orderCount, lowStockCount] =
    await Promise.all([
      can("view_products") ? prisma.product.count() : Promise.resolve(null),
      can("view_categories") ? prisma.category.count() : Promise.resolve(null),
      can("view_customers") ? prisma.user.count({ where: { role: "CUSTOMER" } }) : Promise.resolve(null),
      can("view_orders") ? prisma.order.count() : Promise.resolve(null),
      can("view_inventory")
        ? prisma.$queryRaw<{ count: bigint }[]>`
            SELECT COUNT(*)::bigint AS count FROM "Inventory"
            WHERE "quantity" - "reserved" <= "reorderPoint"`.then((r) => Number(r[0]?.count ?? 0))
        : Promise.resolve(null),
    ]);

  const recentOrders = can("view_orders")
    ? await prisma.order.findMany({
        orderBy: { placedAt: "desc" },
        take: 5,
        select: { id: true, orderNumber: true, email: true, status: true, grandTotal: true, placedAt: true },
      })
    : [];

  const quickActions = ADMIN_ROUTES.filter(
    (r) => r.path !== "/admin" && !r.hideInNav && (admin.isSuperAdmin || routeAllowed(r, admin.permissions)),
  ).slice(0, 6);

  const dash = getAdminRoute("/admin")!;

  return (
    <div>
      <PageHeader title="Dashboard" description={dash.description} />

      {/* Stat cards */}
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard
          label="Total sales"
          icon={<Receipt size={16} />}
          placeholder="Connected when analytics ships"
        />
        <StatCard
          label="Orders"
          value={orderCount ?? undefined}
          hint="All time"
          icon={<ShoppingBag size={16} />}
          placeholder={orderCount === null ? "No access" : undefined}
        />
        <StatCard
          label="Customers"
          value={customerCount ?? undefined}
          hint="Registered accounts"
          icon={<Users size={16} />}
          placeholder={customerCount === null ? "No access" : undefined}
        />
        <StatCard
          label="Products"
          value={productCount ?? undefined}
          hint={categoryCount != null ? `${categoryCount} categories` : "In the catalog"}
          icon={<Package size={16} />}
          placeholder={productCount === null ? "No access" : undefined}
        />
        <StatCard
          label="Low stock"
          value={lowStockCount ?? undefined}
          hint="At or below reorder point"
          icon={<TriangleAlert size={16} />}
          placeholder={lowStockCount === null ? "No access" : undefined}
        />
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        {/* Sales overview — placeholder */}
        <Card className="lg:col-span-2">
          <CardHeader title="Sales overview" />
          <EmptyState
            compact
            title="No sales data to chart yet"
            description="The sales trend will appear here once order analytics is connected in a later step."
          />
        </Card>

        {/* Quick actions */}
        <Card>
          <CardHeader title="Quick actions" />
          {quickActions.length === 0 ? (
            <EmptyState compact title="No sections available" />
          ) : (
            <ul className="space-y-1">
              {quickActions.map((r) => (
                <li key={r.path}>
                  <Link
                    href={r.path}
                    className="flex items-center justify-between rounded-sm px-2.5 py-2 text-sm text-ink-soft transition-colors hover:bg-surface-sunken hover:text-ink"
                  >
                    {r.label}
                    <ArrowUpRight size={14} className="text-ink-faint" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* Recent orders */}
      {can("view_orders") && (
        <Card className="mt-6">
          <CardHeader
            title="Recent orders"
            action={
              <Link href="/admin/orders" className="text-xs text-ink-faint hover:text-ink">
                View all
              </Link>
            }
          />
          {recentOrders.length === 0 ? (
            <EmptyState compact title="No orders yet" description="New orders will show up here." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[32rem] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
                    <th className="py-2 pr-4 font-medium">Order</th>
                    <th className="py-2 pr-4 font-medium">Customer</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 pr-4 text-right font-medium">Total</th>
                    <th className="py-2 font-medium">Placed</th>
                  </tr>
                </thead>
                <tbody>
                  {recentOrders.map((o) => (
                    <tr key={o.id} className="border-b border-line/60 last:border-0">
                      <td className="py-2.5 pr-4 font-medium text-ink">
                        <Link href={`/admin/orders/${o.id}`} className="hover:underline">
                          {o.orderNumber}
                        </Link>
                      </td>
                      <td className="py-2.5 pr-4 text-ink-soft">{o.email}</td>
                      <td className="py-2.5 pr-4 text-ink-soft">{o.status}</td>
                      <td className="py-2.5 pr-4 text-right text-ink-soft">
                        ₱{(o.grandTotal / 100).toLocaleString()}
                      </td>
                      <td className="py-2.5 text-ink-faint">
                        {o.placedAt.toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
