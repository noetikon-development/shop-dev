import type { Metadata } from "next";
import Link from "next/link";
import { Plus, Package, AlertTriangle } from "lucide-react";
import { requireSellerSession } from "@/lib/seller/session";
import { listSellerOffersPage } from "@/lib/seller/offers";
import {
  PageHeader,
  FilterBar,
  SearchInput,
  FilterSelect,
  Pagination,
  EmptyState,
  StatusBadge,
} from "@/components/seller/ui";
import { pesos, offerStatusTone, conditionLabel } from "@/lib/seller/format";

export const metadata: Metadata = { title: "Listings" };

export default async function SellerOffersPage({
  searchParams,
}: PageProps<"/seller/offers">) {
  const { ctx } = await requireSellerSession("/seller/offers");
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const status = typeof sp.status === "string" ? sp.status : undefined;
  const page = Number(sp.page ?? 1) || 1;

  const { rows, total, page: current, pageCount } = await listSellerOffersPage(ctx, {
    q,
    status,
    page,
  });

  return (
    <div>
      <PageHeader
        title="Listings"
        description="Every product you list against the Axiaro catalog. New listings start as a draft."
        actions={
          <Link href="/seller/offers/new" className="btn btn-primary py-2 text-sm">
            <Plus size={14} /> Add listing
          </Link>
        }
      />

      <FilterBar>
        <SearchInput placeholder="Search product or SKU…" />
        <FilterSelect
          label="Status"
          paramKey="status"
          options={[
            { value: "DRAFT", label: "Draft" },
            { value: "INACTIVE", label: "Inactive" },
            { value: "ARCHIVED", label: "Archived" },
            { value: "ACTIVE", label: "Active" },
          ]}
        />
      </FilterBar>

      <p className="mb-3 text-xs text-ink-faint">
        {total} listing{total === 1 ? "" : "s"}
      </p>

      {rows.length === 0 ? (
        <EmptyState
          icon={<Package size={18} />}
          title="No listings match"
          description={
            q || status
              ? "Try clearing the filters."
              : "Create your first listing against a catalog product."
          }
          action={
            <Link href="/seller/offers/new" className="btn btn-primary py-2 text-sm">
              <Plus size={14} /> Add listing
            </Link>
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-md border border-line">
          <table className="w-full min-w-[44rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-sunken/60 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                <th className="px-4 py-2.5 text-left">Product / option</th>
                <th className="px-4 py-2.5 text-left">SKU</th>
                <th className="px-4 py-2.5 text-left">Condition</th>
                <th className="px-4 py-2.5 text-right">Price</th>
                <th className="px-4 py-2.5 text-right">Available</th>
                <th className="px-4 py-2.5 text-left">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id} className="border-b border-line/60 last:border-0 hover:bg-surface-sunken/40">
                  <td className="px-4 py-3">
                    <Link href={`/seller/offers/${o.id}`} className="font-medium text-ink hover:underline">
                      {o.productName}
                    </Link>
                    <span className="block text-xs text-ink-faint">{o.optionLabel}</span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-ink-soft">
                    {o.sellerSku ?? o.variantSku}
                  </td>
                  <td className="px-4 py-3 text-ink-soft">{conditionLabel(o.condition)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-ink-soft">{pesos(o.price)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-ink-soft">
                    {o.available}
                    {o.lowStock && (
                      <AlertTriangle size={11} className="ml-1 inline text-clay" aria-label="Low stock" />
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge tone={offerStatusTone(o.status)}>{o.status}</StatusBadge>
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
