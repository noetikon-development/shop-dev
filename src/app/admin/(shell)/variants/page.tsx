import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/admin/rbac";
import { listAdminVariants } from "@/lib/admin/catalog";
import { formatPrice } from "@/lib/utils";
import {
  PageHeader,
  DataTable,
  type Column,
  StatusBadge,
  SearchInput,
  FilterBar,
  Pagination,
} from "@/components/admin/ui";

export const metadata: Metadata = { title: "Variants" };

type Row = Awaited<ReturnType<typeof listAdminVariants>>["rows"][number];

export default async function AdminVariantsPage({
  searchParams,
}: PageProps<"/admin/variants">) {
  await requirePermission("view_products");
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const page = Number(sp.page ?? 1) || 1;

  const { rows, total, pageCount, page: current } = await listAdminVariants(q, page);

  const columns: Column<Row>[] = [
    {
      key: "product",
      header: "Product",
      cell: (r) => (
        <Link href={`/admin/products/${r.product.id}`} className="font-medium text-ink hover:underline">
          {r.product.name}
        </Link>
      ),
    },
    {
      key: "combo",
      header: "Options",
      cell: (r) =>
        r.optionValues.length
          ? r.optionValues.map((ov) => `${ov.optionValue.option.name}: ${ov.optionValue.value}`).join(" · ")
          : "Default",
    },
    { key: "sku", header: "SKU", cell: (r) => <code className="text-xs">{r.sku}</code> },
    { key: "price", header: "Price", align: "right", cell: (r) => formatPrice(r.price) },
    {
      key: "status",
      header: "Status",
      cell: (r) => (
        <StatusBadge tone={r.status === "ACTIVE" ? "success" : "neutral"}>{r.status}</StatusBadge>
      ),
    },
    {
      key: "edit",
      header: "",
      align: "right",
      cell: (r) => (
        <Link
          href={`/admin/products/${r.product.id}`}
          className="text-xs text-ink-faint hover:text-ink"
        >
          Manage
        </Link>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Variants"
        description="Every product variant across the catalog. Edit variants from their product's Variants tab."
      />
      <FilterBar>
        <SearchInput placeholder="Search SKU or product…" />
      </FilterBar>
      <p className="mb-3 mt-4 text-xs text-ink-faint">{total} variant{total === 1 ? "" : "s"}</p>
      <DataTable
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.id}
        empty={{ title: q ? "No variants match." : "No variants yet." }}
      />
      <div className="mt-4">
        <Pagination page={current} totalPages={pageCount} />
      </div>
    </div>
  );
}
