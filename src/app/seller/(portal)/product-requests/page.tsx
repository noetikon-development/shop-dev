import type { Metadata } from "next";
import Link from "next/link";
import { Plus, Lightbulb } from "lucide-react";
import { requireSellerSessionPermission } from "@/lib/seller/session";
import { listSellerRequestsPage } from "@/lib/seller/product-requests";
import {
  PageHeader,
  FilterBar,
  SearchInput,
  FilterSelect,
  Pagination,
  EmptyState,
  StatusBadge,
} from "@/components/seller/ui";
import { requestStatusTone, requestStatusLabel } from "@/lib/seller/format";

export const metadata: Metadata = { title: "Product requests" };

export default async function SellerProductRequestsPage({
  searchParams,
}: PageProps<"/seller/product-requests">) {
  const { ctx } = await requireSellerSessionPermission("manage_offers");
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const status = typeof sp.status === "string" ? sp.status : undefined;
  const page = Number(sp.page ?? 1) || 1;

  const { rows, total, page: current, pageCount } = await listSellerRequestsPage(ctx, { q, status, page });

  return (
    <div>
      <PageHeader
        title="Product requests"
        description="Ask Axiaro to add a product that isn't in the catalog yet. Once it's approved you can list against it."
        actions={
          <Link href="/seller/product-requests/new" className="btn btn-primary py-2 text-sm">
            <Plus size={14} /> Request a product
          </Link>
        }
      />

      <FilterBar>
        <SearchInput placeholder="Search by product name…" />
        <FilterSelect
          label="Status"
          paramKey="status"
          options={[
            { value: "DRAFT", label: "Draft" },
            { value: "PENDING", label: "In review" },
            { value: "APPROVED", label: "Approved" },
            { value: "REJECTED", label: "Rejected" },
          ]}
        />
      </FilterBar>

      <p className="mb-3 text-xs text-ink-faint">
        {total} request{total === 1 ? "" : "s"}
      </p>

      {rows.length === 0 ? (
        <EmptyState
          icon={<Lightbulb size={18} />}
          title="No product requests"
          description={
            q || status
              ? "Try clearing the filters."
              : "If Axiaro doesn't carry a product you want to sell, request it here."
          }
          action={
            <Link href="/seller/product-requests/new" className="btn btn-primary py-2 text-sm">
              <Plus size={14} /> Request a product
            </Link>
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-md border border-line">
          <table className="w-full min-w-[40rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-sunken/60 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                <th className="px-4 py-2.5 text-left">Product</th>
                <th className="px-4 py-2.5 text-left">Category</th>
                <th className="px-4 py-2.5 text-right">Variants</th>
                <th className="px-4 py-2.5 text-right">Images</th>
                <th className="px-4 py-2.5 text-left">Updated</th>
                <th className="px-4 py-2.5 text-left">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-line/60 last:border-0 hover:bg-surface-sunken/40">
                  <td className="px-4 py-3">
                    <Link href={`/seller/product-requests/${r.id}`} className="font-medium text-ink hover:underline">
                      {r.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-ink-soft">{r.categoryName ?? "—"}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-ink-soft">{r.variantCount}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-ink-soft">{r.imageCount}</td>
                  <td className="px-4 py-3 text-ink-soft">{new Date(r.updatedAt).toLocaleDateString()}</td>
                  <td className="px-4 py-3">
                    <StatusBadge tone={requestStatusTone(r.status)}>{requestStatusLabel(r.status)}</StatusBadge>
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
