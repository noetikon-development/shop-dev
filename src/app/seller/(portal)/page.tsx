import type { Metadata } from "next";
import Link from "next/link";
import { Plus, Package, AlertTriangle } from "lucide-react";
import { requireSellerSession } from "@/lib/seller/session";
import { sellerCan } from "@/lib/marketplace/seller-context";
import { getSellerDashboard } from "@/lib/seller/offers";
import { countOpenSellerReturns } from "@/lib/seller/returns";
import { PageHeader, StatCard, Card, EmptyState, StatusBadge } from "@/components/seller/ui";
import { pesos, offerStatusTone } from "@/lib/seller/format";

export const metadata: Metadata = { title: "Dashboard" };

export default async function SellerDashboardPage() {
  const { ctx } = await requireSellerSession("/seller");
  const canReturns = sellerCan(ctx, "manage_seller_returns");
  const [{ statusCounts, lowStock, totalOffers, recent }, openReturns] = await Promise.all([
    getSellerDashboard(ctx),
    canReturns ? countOpenSellerReturns(ctx) : Promise.resolve(0),
  ]);

  return (
    <div>
      <PageHeader
        title={`Welcome, ${ctx.sellerName}`}
        description="Manage the offers you list on the Axiaro catalog, and the stock behind them."
        actions={
          <Link href="/seller/offers/new" className="btn btn-primary py-2 text-sm">
            <Plus size={14} /> New offer
          </Link>
        }
      />

      <section className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total offers" value={totalOffers} hint="Across all statuses" />
        <StatCard label="Draft" value={statusCounts.DRAFT} hint="Not yet published" />
        <StatCard label="Low stock" value={lowStock} hint="At or below reorder point" />
        {canReturns ? (
          <StatCard label="Returns to receive" value={openReturns} hint="Approved — awaiting your receipt" />
        ) : (
          <StatCard label="Inactive" value={statusCounts.INACTIVE} hint="Paused by you" />
        )}
      </section>

      <Card padded={false}>
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="text-sm font-semibold">Recent offers</h2>
          <Link href="/seller/offers" className="text-xs text-ink-soft hover:text-ink">
            View all
          </Link>
        </div>
        {recent.length === 0 ? (
          <div className="p-5">
            <EmptyState
              icon={<Package size={18} />}
              title="No offers yet"
              description="Create your first offer against a catalog product to get started."
              action={
                <Link href="/seller/offers/new" className="btn btn-primary py-2 text-sm">
                  <Plus size={14} /> New offer
                </Link>
              }
              compact
            />
          </div>
        ) : (
          <ul className="divide-y divide-line-soft">
            {recent.map((o) => (
              <li key={o.id}>
                <Link
                  href={`/seller/offers/${o.id}`}
                  className="flex items-center gap-3 px-5 py-3 text-sm hover:bg-surface-sunken"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-ink">{o.productName}</span>
                    <span className="block truncate text-xs text-ink-faint">
                      {o.optionLabel} · {o.variantSku}
                    </span>
                  </span>
                  <span className="tabular-nums text-ink-soft">{pesos(o.price)}</span>
                  <span className="w-16 text-right tabular-nums text-ink-soft">
                    {o.available} left
                    {o.lowStock && (
                      <AlertTriangle size={11} className="ml-1 inline text-clay" aria-label="Low stock" />
                    )}
                  </span>
                  <StatusBadge tone={offerStatusTone(o.status)}>{o.status}</StatusBadge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
