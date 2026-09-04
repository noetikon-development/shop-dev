import type { Metadata } from "next";
import Link from "next/link";
import { Package, Truck } from "lucide-react";
import { requireSellerSession } from "@/lib/seller/session";
import { listSellerOrdersPage } from "@/lib/seller/orders";
import {
  PageHeader,
  FilterBar,
  SearchInput,
  FilterSelect,
  Pagination,
  EmptyState,
  StatusBadge,
} from "@/components/seller/ui";
import { pesos } from "@/lib/seller/format";
import { sellerOrderStatusLabel, sellerOrderStatusTone } from "@/lib/marketplace/seller-order-status";

export const metadata: Metadata = { title: "Orders" };

export default async function SellerOrdersPage({ searchParams }: PageProps<"/seller/orders">) {
  const { ctx } = await requireSellerSession("/seller/orders");
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const status = typeof sp.status === "string" ? sp.status : undefined;
  const page = Number(sp.page ?? 1) || 1;

  const { rows, total, page: current, pageCount } = await listSellerOrdersPage(ctx, { q, status, page });

  return (
    <div>
      <PageHeader
        title="Orders"
        description="Orders placed for your offers. Fulfil each one — mark it ready, add a shipment, then ship and confirm delivery."
      />

      <FilterBar>
        <SearchInput placeholder="Search order number…" />
        <FilterSelect
          label="Status"
          paramKey="status"
          options={[
            { value: "PENDING_PAYMENT", label: "Awaiting confirmation" },
            { value: "PROCESSING", label: "Preparing" },
            { value: "READY_TO_SHIP", label: "Ready to ship" },
            { value: "SHIPPED", label: "Shipped" },
            { value: "DELIVERED", label: "Delivered" },
            { value: "CANCELLED", label: "Cancelled" },
          ]}
        />
      </FilterBar>

      <p className="mb-3 text-xs text-ink-faint">
        {total} order{total === 1 ? "" : "s"}
      </p>

      {rows.length === 0 ? (
        <EmptyState
          icon={<Package size={18} />}
          title="No orders yet"
          description={
            q || status
              ? "Try clearing the filters."
              : "Orders for your offers will appear here once buyers start purchasing."
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-md border border-line">
          <table className="w-full min-w-[40rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-sunken/60 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                <th className="px-4 py-2.5 text-left">Order</th>
                <th className="px-4 py-2.5 text-left">Placed</th>
                <th className="px-4 py-2.5 text-right">Items</th>
                <th className="px-4 py-2.5 text-right">Total</th>
                <th className="px-4 py-2.5 text-left">Shipment</th>
                <th className="px-4 py-2.5 text-left">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id} className="border-b border-line/60 last:border-0 hover:bg-surface-sunken/40">
                  <td className="px-4 py-3">
                    <Link href={`/seller/orders/${o.id}`} className="font-mono text-xs font-medium text-ink hover:underline">
                      {o.orderNumber}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-ink-soft">{o.placedAt.toISOString().slice(0, 10)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-ink-soft">{o.itemCount}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-ink-soft">{pesos(o.total)}</td>
                  <td className="px-4 py-3 text-ink-soft">
                    {o.hasShipment ? (
                      <span className="inline-flex items-center gap-1 text-xs">
                        <Truck size={12} /> added
                      </span>
                    ) : (
                      <span className="text-xs text-ink-faint">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge tone={sellerOrderStatusTone(o.status)}>
                      {sellerOrderStatusLabel(o.status)}
                    </StatusBadge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4">
        <Pagination page={current} totalPages={pageCount} />
      </div>
    </div>
  );
}
