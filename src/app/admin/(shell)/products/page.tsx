import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { requirePermission } from "@/lib/admin/rbac";
import { prisma } from "@/lib/prisma";
import { listAdminProducts } from "@/lib/admin/catalog";
import { formatPrice, formatDate } from "@/lib/utils";
import {
  PageHeader,
  DataTable,
  type Column,
  StatusBadge,
  SearchInput,
  FilterBar,
  FilterSelect,
  Pagination,
} from "@/components/admin/ui";
import { ProductImage } from "@/components/product-image";

export const metadata: Metadata = { title: "Products" };

type Row = Awaited<ReturnType<typeof listAdminProducts>>["rows"][number];

const STATUS_TONE: Record<string, "success" | "neutral" | "warning"> = {
  ACTIVE: "success",
  DRAFT: "warning",
  ARCHIVED: "neutral",
};

export default async function AdminProductsPage({
  searchParams,
}: PageProps<"/admin/products">) {
  const admin = await requirePermission("view_products");
  const canCreate = admin.isSuperAdmin || admin.permissions.has("create_products");
  const sp = await searchParams;

  const q = typeof sp.q === "string" ? sp.q : undefined;
  const status = typeof sp.status === "string" ? sp.status : undefined;
  const categoryId = typeof sp.category === "string" ? sp.category : undefined;
  const featured = sp.featured === "1";
  const sort = typeof sp.sort === "string" ? sp.sort : undefined;
  const page = Number(sp.page ?? 1) || 1;

  const [{ rows, total, pageCount, page: current }, categories] = await Promise.all([
    listAdminProducts({ q, status, categoryId, featured, sort, page }),
    prisma.category.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true },
    }),
  ]);

  const columns: Column<Row>[] = [
    {
      key: "name",
      header: "Product",
      cell: (r) => (
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 shrink-0 overflow-hidden rounded-sm bg-surface-sunken">
            <ProductImage
              src={r.images[0]?.url ?? `art:accessory:${r.slug}`}
              alt={r.images[0]?.alt ?? r.name}
              seedOverride={`${r.slug}-admin`}
            />
          </div>
          <div className="min-w-0">
            <Link href={`/admin/products/${r.id}`} className="font-medium text-ink hover:underline">
              {r.name}
            </Link>
            <p className="truncate text-xs text-ink-faint">/{r.slug}</p>
          </div>
        </div>
      ),
    },
    { key: "category", header: "Category", cell: (r) => r.category.name },
    {
      key: "status",
      header: "Status",
      cell: (r) => (
        <span className="flex items-center gap-1.5">
          <StatusBadge tone={STATUS_TONE[r.status] ?? "neutral"}>{r.status}</StatusBadge>
          {r.featured && <StatusBadge tone="info">Featured</StatusBadge>}
        </span>
      ),
    },
    {
      key: "price",
      header: "Price",
      align: "right",
      cell: (r) => (
        <span>
          {formatPrice(r.price)}
          {r.compareAtPrice ? (
            <span className="ml-1 text-xs text-ink-faint line-through">
              {formatPrice(r.compareAtPrice)}
            </span>
          ) : null}
        </span>
      ),
    },
    { key: "variants", header: "Variants", align: "right", cell: (r) => r._count.variants },
    { key: "updated", header: "Updated", cell: (r) => formatDate(r.updatedAt) },
  ];

  return (
    <div>
      <PageHeader
        title="Products"
        description="Your catalog. Draft and archived products are hidden from the storefront."
        actions={
          canCreate ? (
            <Link href="/admin/products/new" className="btn btn-primary py-2 text-sm">
              <Plus size={15} /> New product
            </Link>
          ) : undefined
        }
      />

      <FilterBar>
        <SearchInput placeholder="Search name, slug or SKU…" />
        <FilterSelect
          label="Status"
          paramKey="status"
          options={[
            { value: "ACTIVE", label: "Active" },
            { value: "DRAFT", label: "Draft" },
            { value: "ARCHIVED", label: "Archived" },
          ]}
        />
        <FilterSelect
          label="Category"
          paramKey="category"
          options={categories.map((c) => ({ value: c.id, label: c.name }))}
        />
        <FilterSelect
          label="Sort"
          paramKey="sort"
          allLabel="Recently updated"
          options={[
            { value: "name", label: "Name A–Z" },
            { value: "price-asc", label: "Price low–high" },
            { value: "price-desc", label: "Price high–low" },
            { value: "oldest", label: "Oldest first" },
          ]}
        />
      </FilterBar>

      <p className="mb-3 mt-4 text-xs text-ink-faint">
        {total} product{total === 1 ? "" : "s"}
      </p>

      <DataTable
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.id}
        empty={{
          title: q || status || categoryId ? "No products match those filters." : "No products yet.",
          description: canCreate ? "Create your first product to get started." : undefined,
        }}
      />

      <div className="mt-4">
        <Pagination page={current} totalPages={pageCount} />
      </div>
    </div>
  );
}
