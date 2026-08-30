import type { Metadata } from "next";
import { requirePermission } from "@/lib/admin/rbac";
import { listAdminOrders, orderPaymentStatuses } from "@/lib/admin/orders";
import {
  PageHeader,
  FilterBar,
  SearchInput,
  FilterSelect,
  Pagination,
} from "@/components/admin/ui";
import { OrdersTable } from "@/components/admin/orders/orders-table";
import { ORDER_STATUSES, orderStatusLabel, PAYMENT_STATUS_LABEL } from "@/lib/orders/status";

export const metadata: Metadata = { title: "Orders" };

const SORT_OPTIONS = [
  { value: "oldest", label: "Oldest first" },
  { value: "total_desc", label: "Total: high to low" },
  { value: "total_asc", label: "Total: low to high" },
  { value: "updated", label: "Recently updated" },
];

const RANGE_OPTIONS = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
];

export default async function AdminOrdersPage({ searchParams }: PageProps<"/admin/orders">) {
  await requirePermission("view_orders");
  const sp = await searchParams;

  const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const q = str(sp.q);
  const status = str(sp.status);
  const paymentStatus = str(sp.payment);
  const range = str(sp.range);
  const sort = str(sp.sort) as
    | "newest"
    | "oldest"
    | "total_desc"
    | "total_asc"
    | "updated"
    | undefined;
  const page = Number(sp.page ?? 1) || 1;

  const [{ rows, total, pageCount, page: current }, paymentStatusValues] = await Promise.all([
    listAdminOrders({ q, status, paymentStatus, range, sort, page }),
    orderPaymentStatuses(),
  ]);

  const searching = Boolean(q || status || paymentStatus || range);

  return (
    <div>
      <PageHeader
        title="Orders"
        description="Every order placed through checkout. Totals, prices and addresses shown here are the immutable snapshot taken when each order was placed."
      />

      <FilterBar>
        <SearchInput placeholder="Order number, customer name or email…" />
        <FilterSelect
          label="Status"
          paramKey="status"
          options={ORDER_STATUSES.map((s) => ({ value: s, label: orderStatusLabel(s) }))}
        />
        <FilterSelect
          label="Payment"
          paramKey="payment"
          options={paymentStatusValues.map((s) => ({
            value: s,
            label: PAYMENT_STATUS_LABEL[s] ?? s,
          }))}
        />
        <FilterSelect label="Placed" paramKey="range" options={RANGE_OPTIONS} allLabel="Any time" />
        <FilterSelect label="Sort" paramKey="sort" options={SORT_OPTIONS} allLabel="Newest first" />
      </FilterBar>

      <p className="mb-3 mt-4 text-xs text-ink-faint">
        {total} order{total === 1 ? "" : "s"}
        {searching && " match this filter"}
      </p>

      <OrdersTable rows={rows} searching={searching} />

      <div className="mt-4">
        <Pagination page={current} totalPages={pageCount} />
      </div>
    </div>
  );
}
