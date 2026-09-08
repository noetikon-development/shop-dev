import type { Metadata } from "next";
import Link from "next/link";
import { requireAnyPermission } from "@/lib/admin/rbac";
import {
  listAllOffersForAdmin,
  listSellersForOfferFilter,
  adminOfferStatusCounts,
  type AdminOfferRow,
} from "@/lib/admin/offers";
import { offerStatusTone, conditionLabel, pesos } from "@/lib/seller/format";
import { PageHeader, DataTable, StatusBadge, type Column } from "@/components/admin/ui";

export const metadata: Metadata = { title: "Offers" };

const STATUS_FILTERS = [
  { key: "all", label: "All", status: undefined as string | undefined },
  { key: "draft", label: "Draft", status: "DRAFT" },
  { key: "active", label: "Active", status: "ACTIVE" },
  { key: "inactive", label: "Inactive", status: "INACTIVE" },
  { key: "archived", label: "Archived", status: "ARCHIVED" },
];

function buildHref(status?: string, sellerId?: string) {
  const sp = new URLSearchParams();
  if (status) sp.set("status", status);
  if (sellerId) sp.set("seller", sellerId);
  const qs = sp.toString();
  return qs ? `/admin/offers?${qs}` : "/admin/offers";
}

export default async function AdminOffersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; seller?: string; page?: string }>;
}) {
  await requireAnyPermission(["manage_settings", "manage_content"]);

  const sp = await searchParams;
  const activeFilter = STATUS_FILTERS.find((f) => f.key === sp.status) ?? STATUS_FILTERS[0];
  const sellerId = sp.seller || undefined;
  const page = Math.max(1, Number(sp.page) || 1);

  const [{ rows, total, pageCount }, sellers, counts] = await Promise.all([
    listAllOffersForAdmin({ status: activeFilter.status, sellerId, page }),
    listSellersForOfferFilter(),
    adminOfferStatusCounts(sellerId),
  ]);

  const columns: Column<AdminOfferRow>[] = [
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
      key: "product",
      header: "Product",
      cell: (r) => (
        <Link href={`/admin/offers/${r.id}`} className="text-ink hover:underline">
          {r.productName}
        </Link>
      ),
    },
    { key: "sku", header: "SKU / variant", cell: (r) => <span className="font-mono">{r.sellerSku ?? r.variantSku}</span> },
    { key: "condition", header: "Condition", cell: (r) => conditionLabel(r.condition) },
    { key: "price", header: "Price", align: "right", cell: (r) => pesos(r.price) },
    { key: "available", header: "Stock", align: "right", cell: (r) => r.available },
    {
      key: "status",
      header: "Status",
      cell: (r) => <StatusBadge tone={offerStatusTone(r.status)}>{r.status}</StatusBadge>,
    },
    {
      key: "manage",
      header: "",
      cell: (r) => (
        <Link href={`/admin/offers/${r.id}`} className="text-xs text-clay hover:underline">
          Manage
        </Link>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Offers"
        description="Every seller's catalog listings, across every seller. Open a listing to change its status — publish a seller's ready draft, or pull a live one — without touching their price, condition or stock."
      />

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
              {f.status && <span className="ml-1.5 text-xs opacity-70">{counts[f.status] ?? 0}</span>}
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
        empty={{ title: "No offers", description: "No offers match the current filters." }}
      />

      {pageCount > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-ink-faint">
          <span>
            Page {page} of {pageCount} · {total} offer{total === 1 ? "" : "s"}
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
