import type { Metadata } from "next";
import { requirePermission } from "@/lib/admin/rbac";
import { listAdminReturns } from "@/lib/admin/returns";
import { PageHeader, FilterBar, SearchInput, FilterSelect, Pagination } from "@/components/admin/ui";
import { ReturnsTable } from "@/components/admin/returns/returns-table";
import { RETURN_STATUSES, returnStatusLabel } from "@/lib/returns/status";

export const metadata: Metadata = { title: "Returns" };

const RANGE_OPTIONS = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
];

export default async function AdminReturnsPage({ searchParams }: PageProps<"/admin/returns">) {
  await requirePermission("manage_returns");
  const sp = await searchParams;
  const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

  const q = str(sp.q);
  const status = str(sp.status);
  const range = str(sp.range);
  const page = Number(sp.page ?? 1) || 1;

  const { rows, total, pageCount, page: current } = await listAdminReturns({ q, status, range, page });
  const searching = Boolean(q || status || range);

  return (
    <div>
      <PageHeader
        title="Returns"
        description="Customer return requests. Approve or reject them, receive the items back into stock, and record refunds. Refund steps are bookkeeping only — no money is moved here."
      />

      <FilterBar>
        <SearchInput placeholder="Return #, order #, customer or email…" />
        <FilterSelect
          label="Status"
          paramKey="status"
          options={RETURN_STATUSES.map((s) => ({ value: s, label: returnStatusLabel(s) }))}
        />
        <FilterSelect label="Requested" paramKey="range" options={RANGE_OPTIONS} allLabel="Any time" />
      </FilterBar>

      <p className="mb-3 mt-4 text-xs text-ink-faint">
        {total} return{total === 1 ? "" : "s"}
        {searching && " match this filter"}
      </p>

      <ReturnsTable rows={rows} searching={searching} />

      <div className="mt-4">
        <Pagination page={current} totalPages={pageCount} />
      </div>
    </div>
  );
}
