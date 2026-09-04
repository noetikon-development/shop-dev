import type { Metadata } from "next";
import Link from "next/link";
import { Undo2 } from "lucide-react";
import { requireSellerSessionPermission } from "@/lib/seller/session";
import { listSellerReturnsPage } from "@/lib/seller/returns";
import {
  PageHeader,
  FilterBar,
  SearchInput,
  FilterSelect,
  Pagination,
  EmptyState,
  StatusBadge,
} from "@/components/seller/ui";
import { returnStatusLabel, returnStatusTone, returnReasonLabel } from "@/lib/returns/status";

export const metadata: Metadata = { title: "Returns" };

export default async function SellerReturnsPage({ searchParams }: PageProps<"/seller/returns">) {
  const { ctx } = await requireSellerSessionPermission("manage_seller_returns");
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const status = typeof sp.status === "string" ? sp.status : undefined;
  const page = Number(sp.page ?? 1) || 1;

  const { rows, total, page: current, pageCount } = await listSellerReturnsPage(ctx, { q, status, page });

  return (
    <div>
      <PageHeader
        title="Returns"
        description="Returns that include your items. Axiaro approves or rejects each one; you confirm physical receipt and set the condition and restock quantity for your lines."
      />

      <FilterBar>
        <SearchInput placeholder="Search return or order number…" />
        <FilterSelect
          label="Status"
          paramKey="status"
          options={[
            { value: "REQUESTED", label: "Requested" },
            { value: "APPROVED", label: "Approved — awaiting receipt" },
            { value: "RECEIVED", label: "Received" },
            { value: "REFUND_INITIATED", label: "Refund initiated" },
            { value: "REFUND_COMPLETED", label: "Refund completed" },
            { value: "REJECTED", label: "Rejected" },
            { value: "CANCELLED", label: "Cancelled" },
          ]}
        />
      </FilterBar>

      <p className="mb-3 text-xs text-ink-faint">
        {total} return{total === 1 ? "" : "s"}
      </p>

      {rows.length === 0 ? (
        <EmptyState
          icon={<Undo2 size={18} />}
          title="No returns"
          description={
            q || status
              ? "Try clearing the filters."
              : "Returns that include your items will appear here."
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-md border border-line">
          <table className="w-full min-w-[40rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-sunken/60 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                <th className="px-4 py-2.5 text-left">Return</th>
                <th className="px-4 py-2.5 text-left">Order</th>
                <th className="px-4 py-2.5 text-left">Reason</th>
                <th className="px-4 py-2.5 text-right">Your units</th>
                <th className="px-4 py-2.5 text-left">Requested</th>
                <th className="px-4 py-2.5 text-left">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-line/60 last:border-0 hover:bg-surface-sunken/40">
                  <td className="px-4 py-3">
                    <Link href={`/seller/returns/${r.id}`} className="font-mono text-xs font-medium text-ink hover:underline">
                      {r.returnNumber}
                    </Link>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-ink-soft">{r.orderNumber}</td>
                  <td className="px-4 py-3 text-ink-soft">{returnReasonLabel(r.reason)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-ink-soft">{r.unitCount}</td>
                  <td className="px-4 py-3 text-ink-soft">{r.createdAt.toISOString().slice(0, 10)}</td>
                  <td className="px-4 py-3">
                    <StatusBadge tone={returnStatusTone(r.status)}>{returnStatusLabel(r.status)}</StatusBadge>
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
