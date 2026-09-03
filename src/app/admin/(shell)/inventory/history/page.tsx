import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { requirePermission } from "@/lib/admin/rbac";
import { listInventoryHistory, historyReasons } from "@/lib/admin/inventory";
import { ADJUSTMENT_REASON_LABEL } from "@/lib/inventory-status";
import { formatDate } from "@/lib/utils";
import {
  PageHeader,
  DataTable,
  type Column,
  SearchInput,
  FilterBar,
  FilterSelect,
  Pagination,
  StatusBadge,
} from "@/components/admin/ui";

export const metadata: Metadata = { title: "Inventory history" };

type Row = Awaited<ReturnType<typeof listInventoryHistory>>["rows"][number];

export default async function InventoryHistoryPage({
  searchParams,
}: PageProps<"/admin/inventory/history">) {
  await requirePermission("view_inventory");
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const reason = typeof sp.reason === "string" ? sp.reason : undefined;
  const page = Number(sp.page ?? 1) || 1;

  const [{ rows, total, pageCount, page: current }, reasons] = await Promise.all([
    listInventoryHistory({ q, reason, page }),
    historyReasons(),
  ]);

  const columns: Column<Row>[] = [
    { key: "createdAt", header: "When", cell: (r) => formatDate(r.createdAt, { hour: "2-digit", minute: "2-digit" }) },
    {
      key: "product",
      header: "Product / variant",
      cell: (r) => (
        <div className="min-w-0">
          <Link href={`/admin/products/${r.productId}`} className="font-medium text-ink hover:underline">
            {r.productName}
          </Link>
          <p className="truncate text-xs text-ink-faint">{r.optionLabel}</p>
        </div>
      ),
    },
    { key: "sku", header: "SKU", cell: (r) => <code className="text-xs">{r.sku}</code> },
    { key: "previousQuantity", header: "Prev", align: "right", cell: (r) => r.previousQuantity },
    {
      key: "delta",
      header: "Change",
      align: "right",
      cell: (r) => (
        <span className={r.delta < 0 ? "text-clay" : "text-sage"}>
          {r.delta > 0 ? `+${r.delta}` : r.delta}
        </span>
      ),
    },
    { key: "newQuantity", header: "New", align: "right", cell: (r) => <span className="font-medium">{r.newQuantity}</span> },
    {
      key: "reason",
      header: "Reason",
      cell: (r) => (
        <span className="inline-flex items-center gap-1.5">
          <StatusBadge tone="neutral">{ADJUSTMENT_REASON_LABEL[r.reason] ?? r.reason}</StatusBadge>
          <span
            className="text-[10px] uppercase tracking-wide text-ink-faint"
            title={
              r.ledger === "current"
                ? "Current OfferInventory adjustment"
                : "Pre-retirement InventoryAdjustment archive"
            }
          >
            {r.ledger === "current" ? "offer" : "archived"}
          </span>
        </span>
      ),
    },
    { key: "actor", header: "Admin", cell: (r) => r.actor },
    { key: "note", header: "Note", cell: (r) => <span className="text-ink-faint">{r.note ?? "—"}</span> },
  ];

  return (
    <div>
      <PageHeader
        title="Inventory history"
        description="Every stock adjustment — who, what, when and why."
        actions={
          <Link href="/admin/inventory" className="btn btn-outline py-2 text-sm">
            <ChevronLeft size={14} /> Inventory
          </Link>
        }
      />

      <FilterBar>
        <SearchInput placeholder="Search product or SKU…" />
        {reasons.length > 0 && (
          <FilterSelect
            label="Reason"
            paramKey="reason"
            options={reasons.map((r) => ({ value: r, label: ADJUSTMENT_REASON_LABEL[r] ?? r }))}
          />
        )}
      </FilterBar>

      <p className="mb-3 mt-4 text-xs text-ink-faint">{total} adjustment{total === 1 ? "" : "s"}</p>

      <DataTable
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.id}
        empty={{ title: q || reason ? "No adjustments match." : "No stock adjustments recorded yet." }}
      />

      <div className="mt-4">
        <Pagination page={current} totalPages={pageCount} />
      </div>
    </div>
  );
}
