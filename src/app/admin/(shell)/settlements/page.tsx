import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/admin/rbac";
import {
  listAdminSettlements,
  listThirdPartySellersForSettlement,
  type AdminSettlementRow,
} from "@/lib/admin/settlements";
import { getSellerSettlementPreview } from "@/lib/marketplace/settlement";
import { pesos } from "@/lib/seller/format";
import { PageHeader, DataTable, Card, StatusBadge, type Column } from "@/components/admin/ui";
import { RecordSettlementForm } from "@/components/admin/settlements/record-settlement-form";

export const metadata: Metadata = { title: "Settlements" };

export default async function AdminSettlementsPage({
  searchParams,
}: {
  searchParams: Promise<{ seller?: string; page?: string }>;
}) {
  await requirePermission("manage_payments");

  const sp = await searchParams;
  const sellerId = sp.seller || undefined;
  const page = Math.max(1, Number(sp.page) || 1);

  const [{ rows, total, pageCount }, sellers, preview] = await Promise.all([
    listAdminSettlements({ sellerId, page }),
    listThirdPartySellersForSettlement(),
    sellerId ? getSellerSettlementPreview(sellerId) : Promise.resolve(null),
  ]);

  const columns: Column<AdminSettlementRow>[] = [
    {
      key: "seller",
      header: "Seller",
      cell: (r) => (
        <Link href={`/admin/settlements?seller=${r.sellerId}`} className="font-medium text-ink hover:underline">
          {r.sellerName}
        </Link>
      ),
    },
    { key: "paidAt", header: "Paid", cell: (r) => new Date(r.paidAt).toLocaleDateString() },
    { key: "gross", header: "Gross", align: "right", cell: (r) => pesos(r.grossReceivable) },
    { key: "commission", header: "Commission", align: "right", cell: (r) => `−${pesos(r.commissionAmount)}` },
    { key: "clawback", header: "Clawback", align: "right", cell: (r) => (r.clawbackAmount ? `−${pesos(r.clawbackAmount)}` : "—") },
    {
      key: "net",
      header: "Net",
      align: "right",
      cell: (r) => (
        <Link href={`/admin/settlements/${r.id}`} className="tabular-nums font-medium text-ink hover:underline">
          {pesos(r.netAmount)}
        </Link>
      ),
    },
    { key: "reference", header: "Reference", cell: (r) => r.paymentReference ?? "—" },
  ];

  return (
    <div>
      <PageHeader
        title="Settlements"
        description="Bookkeeping-only payout records for third-party sellers. Recording a settlement does not move money — it logs a payment you made outside the system (bank / GCash / cash)."
      />

      <form method="get" className="mb-6 flex flex-wrap items-end gap-3 text-sm">
        <label>
          <span className="block text-xs text-ink-faint">Third-party seller</span>
          <select
            name="seller"
            defaultValue={sellerId ?? ""}
            className="mt-1 rounded-sm border border-line bg-surface px-2 py-1.5 text-sm"
          >
            <option value="">— select to prepare a settlement —</option>
            {sellers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.displayName}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn btn-secondary py-1.5 text-xs">
          Show
        </button>
      </form>

      {preview && (
        <div className="mb-8 grid gap-6 lg:grid-cols-[1fr_360px]">
          <Card padded={false}>
            <div className="border-b border-line px-5 py-3">
              <h2 className="text-sm font-semibold">
                {preview.sellerName ?? "Seller"} — eligible now
              </h2>
            </div>
            {preview.eligibleOrders.length === 0 && preview.outstandingClawbacks.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-faint">
                Nothing to settle for this seller right now — no delivered orders past the return window, and no
                outstanding clawbacks.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[34rem] border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-line bg-surface-sunken/60 text-[10px] uppercase tracking-wide text-ink-faint">
                      <th className="px-4 py-2 text-left">Order</th>
                      <th className="px-4 py-2 text-left">Kind</th>
                      <th className="px-4 py-2 text-right">Total</th>
                      <th className="px-4 py-2 text-right">Commission</th>
                      <th className="px-4 py-2 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.eligibleOrders.map((o) => (
                      <tr key={o.id} className="border-b border-line/60">
                        <td className="px-4 py-2">
                          <Link href={`/admin/seller-orders/${o.id}`} className="text-ink hover:underline">
                            {o.orderNumber}
                          </Link>
                          {o.returnedValueDeducted > 0 && (
                            <span className="block text-[10px] text-clay">
                              less {pesos(o.returnedValueDeducted)} returned before settlement
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-ink-soft">Receivable</td>
                        <td className="px-4 py-2 text-right tabular-nums text-ink-soft">{pesos(o.total)}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-ink-soft">−{pesos(o.commissionAmount)}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-ink">{pesos(o.receivable)}</td>
                      </tr>
                    ))}
                    {preview.outstandingClawbacks.map((o) => (
                      <tr key={o.id} className="border-b border-line/60">
                        <td className="px-4 py-2">
                          <Link href={`/admin/seller-orders/${o.id}`} className="text-ink hover:underline">
                            {o.orderNumber}
                          </Link>
                        </td>
                        <td className="px-4 py-2">
                          <StatusBadge tone="danger">Clawback</StatusBadge>
                        </td>
                        <td className="px-4 py-2 text-right text-ink-faint">—</td>
                        <td className="px-4 py-2 text-right text-ink-faint">—</td>
                        <td className="px-4 py-2 text-right tabular-nums text-clay">−{pesos(o.clawbackAmount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <dl className="space-y-1.5 border-t border-line px-5 py-4 text-sm">
              <div className="flex justify-between"><dt className="text-ink-faint">Gross receivable</dt><dd className="tabular-nums">{pesos(preview.grossReceivable)}</dd></div>
              <div className="flex justify-between"><dt className="text-ink-faint">Commission</dt><dd className="tabular-nums">−{pesos(preview.commissionAmount)}</dd></div>
              {preview.preSettlementReturnDeduction > 0 && (
                <div className="flex justify-between"><dt className="text-ink-faint">Returned before settlement</dt><dd className="tabular-nums">−{pesos(preview.preSettlementReturnDeduction)}</dd></div>
              )}
              <div className="flex justify-between"><dt className="text-ink-faint">Outstanding clawbacks</dt><dd className="tabular-nums">−{pesos(preview.clawbackAmount)}</dd></div>
              {preview.carryForwardPrior > 0 && (
                <div className="flex justify-between"><dt className="text-ink-faint">Balance carried over</dt><dd className="tabular-nums">−{pesos(preview.carryForwardPrior)}</dd></div>
              )}
              <div className="flex justify-between border-t border-line pt-1.5 font-medium"><dt>Net to pay</dt><dd className="tabular-nums">{pesos(preview.netAmount)}</dd></div>
              {preview.carryForwardAmount > 0 && (
                <div className="flex justify-between text-clay"><dt>Carries forward to next settlement</dt><dd className="tabular-nums">{pesos(preview.carryForwardAmount)}</dd></div>
              )}
            </dl>
            {preview.carryForwardAmount > 0 && (
              <p className="border-t border-line px-5 pb-4 text-xs text-ink-faint">
                Clawbacks and the carried-over balance exceed the receivable. Net is floored at zero — the remaining{" "}
                {pesos(preview.carryForwardAmount)} carries to this seller&apos;s next settlement. No negative payout is recorded.
              </p>
            )}
          </Card>

          <Card>
            <h2 className="mb-3 text-sm font-semibold">Record a payout</h2>
            <RecordSettlementForm
              sellerId={preview.sellerId}
              netAmountLabel={pesos(preview.netAmount)}
              disabled={preview.eligibleOrders.length === 0 && preview.outstandingClawbacks.length === 0}
            />
          </Card>
        </div>
      )}

      <h2 className="mb-3 text-sm font-semibold text-ink">Recorded settlements</h2>
      <DataTable
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.id}
        empty={{ title: "No settlements recorded", description: "Prepare one for a seller above." }}
      />

      {pageCount > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-ink-faint">
          <span>Page {page} of {pageCount} · {total} settlement{total === 1 ? "" : "s"}</span>
          <div className="flex gap-2">
            {page > 1 && (
              <Link href={`/admin/settlements?${sellerId ? `seller=${sellerId}&` : ""}page=${page - 1}`} className="rounded-sm border border-line px-3 py-1 hover:bg-surface-sunken">
                Previous
              </Link>
            )}
            {page < pageCount && (
              <Link href={`/admin/settlements?${sellerId ? `seller=${sellerId}&` : ""}page=${page + 1}`} className="rounded-sm border border-line px-3 py-1 hover:bg-surface-sunken">
                Next
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
