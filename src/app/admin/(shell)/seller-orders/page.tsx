import type { Metadata } from "next";
import Link from "next/link";
import { requireAnyPermission } from "@/lib/admin/rbac";
import {
  listAdminSellerOrders,
  listSellersForSellerOrderFilter,
  adminCommissionTotal,
  type AdminSellerOrderRow,
} from "@/lib/admin/seller-orders";
import { sellerOrderStatusLabel, sellerOrderStatusTone } from "@/lib/marketplace/seller-order-status";
import { pesos } from "@/lib/seller/format";
import { PageHeader, DataTable, StatusBadge, StatCard, type Column } from "@/components/admin/ui";

export const metadata: Metadata = { title: "Seller orders" };

const STATUS_FILTERS = [
  { key: "all", label: "All", status: undefined as string | undefined },
  { key: "pending_payment", label: "Awaiting confirmation", status: "PENDING_PAYMENT" },
  { key: "processing", label: "Preparing", status: "PROCESSING" },
  { key: "ready_to_ship", label: "Ready to ship", status: "READY_TO_SHIP" },
  { key: "shipped", label: "Shipped", status: "SHIPPED" },
  { key: "delivered", label: "Delivered", status: "DELIVERED" },
  { key: "cancelled", label: "Cancelled", status: "CANCELLED" },
];

function buildHref(status?: string, sellerId?: string) {
  const sp = new URLSearchParams();
  if (status) sp.set("status", status);
  if (sellerId) sp.set("seller", sellerId);
  const qs = sp.toString();
  return qs ? `/admin/seller-orders?${qs}` : "/admin/seller-orders";
}

export default async function AdminSellerOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; seller?: string; page?: string }>;
}) {
  await requireAnyPermission(["view_orders", "manage_orders"]);

  const sp = await searchParams;
  const activeFilter = STATUS_FILTERS.find((f) => f.key === sp.status) ?? STATUS_FILTERS[0];
  const sellerId = sp.seller || undefined;
  const page = Math.max(1, Number(sp.page) || 1);

  const [{ rows, total, pageCount }, sellers, commissionTotal] = await Promise.all([
    listAdminSellerOrders({ status: activeFilter.status, sellerId, page }),
    listSellersForSellerOrderFilter(),
    adminCommissionTotal(sellerId),
  ]);

  const columns: Column<AdminSellerOrderRow>[] = [
    {
      key: "seller",
      header: "Seller",
      cell: (r) => (
        <Link href={`/admin/sellers/${r.sellerId}`} className="font-medium text-ink hover:underline">
          {r.sellerName}
        </Link>
      ),
    },
    {
      key: "order",
      header: "Order",
      cell: (r) => (
        <Link href={`/admin/orders/${r.orderId}`} className="text-ink hover:underline">
          {r.orderNumber}
        </Link>
      ),
    },
    { key: "customer", header: "Customer", cell: (r) => r.customerEmail },
    {
      key: "status",
      header: "Status",
      cell: (r) => <StatusBadge tone={sellerOrderStatusTone(r.status)}>{sellerOrderStatusLabel(r.status)}</StatusBadge>,
    },
    { key: "merchandiseSubtotal", header: "Merchandise", align: "right", cell: (r) => pesos(r.merchandiseSubtotal) },
    { key: "shippingFee", header: "Shipping", align: "right", cell: (r) => pesos(r.shippingFee) },
    { key: "total", header: "Total", align: "right", cell: (r) => pesos(r.total) },
    {
      key: "commissionAmount",
      header: "Commission",
      align: "right",
      cell: (r) => (
        <Link href={`/admin/seller-orders/${r.id}`} className="tabular-nums text-ink hover:underline">
          {pesos(r.commissionAmount)}
        </Link>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Seller orders"
        description="Every marketplace order line, grouped by seller. Read-only — commission shown here is the stored, already-corrected figure (9F-8c/9F-8c.1), not a settlement or payout amount."
      />

      {sellerId && (
        <div className="mb-4 max-w-xs">
          <StatCard
            label={`Commission — ${sellers.find((s) => s.id === sellerId)?.displayName ?? "this seller"}`}
            value={pesos(commissionTotal)}
            hint="Calculated total, current filter · not a settlement figure"
          />
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {STATUS_FILTERS.map((f) => (
            <Link
              key={f.key}
              href={buildHref(f.status, sellerId)}
              className={`rounded-sm border px-3 py-1 ${
                f.key === activeFilter.key
                  ? "border-ink bg-ink text-paper"
                  : "border-line text-ink-soft hover:bg-surface-sunken"
              }`}
            >
              {f.label}
            </Link>
          ))}
        </div>

        <form method="get" className="ml-auto flex items-center gap-2 text-sm">
          {activeFilter.status && <input type="hidden" name="status" value={activeFilter.status} />}
          <label htmlFor="seller-filter" className="text-xs text-ink-faint">
            Seller
          </label>
          <select
            id="seller-filter"
            name="seller"
            defaultValue={sellerId ?? ""}
            className="rounded-sm border border-line bg-surface px-2 py-1 text-sm"
          >
            <option value="">All sellers</option>
            {sellers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.displayName}
              </option>
            ))}
          </select>
          <button type="submit" className="btn btn-secondary py-1 text-xs">
            Apply
          </button>
        </form>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.id}
        empty={{ title: "No seller orders", description: "No seller orders match the current filters." }}
      />

      {pageCount > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-ink-faint">
          <span>
            Page {page} of {pageCount} · {total} seller order{total === 1 ? "" : "s"}
          </span>
          <div className="flex gap-2">
            {page > 1 && (
              <Link
                href={`${buildHref(activeFilter.status, sellerId)}${activeFilter.status || sellerId ? "&" : "?"}page=${page - 1}`}
                className="rounded-sm border border-line px-3 py-1 hover:bg-surface-sunken"
              >
                Previous
              </Link>
            )}
            {page < pageCount && (
              <Link
                href={`${buildHref(activeFilter.status, sellerId)}${activeFilter.status || sellerId ? "&" : "?"}page=${page + 1}`}
                className="rounded-sm border border-line px-3 py-1 hover:bg-surface-sunken"
              >
                Next
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
