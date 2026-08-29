import type { Metadata } from "next";
import Link from "next/link";
import { History } from "lucide-react";
import { requirePermission } from "@/lib/admin/rbac";
import { listInventory } from "@/lib/admin/inventory";
import {
  PageHeader,
  SearchInput,
  FilterBar,
  FilterSelect,
  Pagination,
  StatCard,
} from "@/components/admin/ui";
import { InventoryTable } from "@/components/admin/inventory/inventory-table";

export const metadata: Metadata = { title: "Inventory" };

export default async function AdminInventoryPage({
  searchParams,
}: PageProps<"/admin/inventory">) {
  const admin = await requirePermission("view_inventory");
  const canManage = admin.isSuperAdmin || admin.permissions.has("manage_inventory");
  const sp = await searchParams;

  const q = typeof sp.q === "string" ? sp.q : undefined;
  const status = typeof sp.status === "string" ? sp.status : undefined;
  const page = Number(sp.page ?? 1) || 1;

  const { rows, total, pageCount, page: current, summary } = await listInventory({
    q,
    status,
    page,
  });

  return (
    <div>
      <PageHeader
        title="Inventory"
        description="Stock by product variant. Status is derived from available stock (on hand − reserved) and the reorder point."
        actions={
          <Link href="/admin/inventory/history" className="btn btn-outline py-2 text-sm">
            <History size={14} /> History
          </Link>
        }
      />

      <section className="mb-5 grid gap-4 sm:grid-cols-3">
        <StatCard label="In stock" value={summary.inStock} hint="Variants above reorder point" />
        <StatCard label="Low stock" value={summary.lowStock} hint="At or below reorder point" />
        <StatCard label="Out of stock" value={summary.outOfStock} hint="No available units" />
      </section>

      <FilterBar>
        <SearchInput placeholder="Search product or SKU…" />
        <FilterSelect
          label="Status"
          paramKey="status"
          options={[
            { value: "IN_STOCK", label: "In stock" },
            { value: "LOW_STOCK", label: "Low stock" },
            { value: "OUT_OF_STOCK", label: "Out of stock" },
          ]}
        />
      </FilterBar>

      <p className="mb-3 mt-4 text-xs text-ink-faint">
        {total} variant{total === 1 ? "" : "s"}
        {!canManage && " · read-only (needs manage_inventory)"}
      </p>

      <InventoryTable
        canManage={canManage}
        rows={rows.map((r) => ({
          ...r,
          updatedAt: r.updatedAt.toISOString(),
        }))}
      />

      <div className="mt-4">
        <Pagination page={current} totalPages={pageCount} />
      </div>
    </div>
  );
}
