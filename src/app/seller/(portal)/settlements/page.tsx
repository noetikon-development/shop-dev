import type { Metadata } from "next";
import Link from "next/link";
import { requireSellerSession } from "@/lib/seller/session";
import {
  listSellerSettlements,
  getSellerPendingStatement,
} from "@/lib/seller/settlement-repository";
import { pesos } from "@/lib/seller/format";
import { PageHeader, Card, StatCard, DataTable, EmptyState, type Column } from "@/components/seller/ui";
import type { SellerSettlementListRow } from "@/lib/seller/settlement-repository";

export const metadata: Metadata = { title: "Settlements" };

export default async function SellerSettlementsPage() {
  const { ctx } = await requireSellerSession("/seller/settlements");

  const [rows, pending] = await Promise.all([
    listSellerSettlements(ctx),
    getSellerPendingStatement(ctx),
  ]);

  const columns: Column<SellerSettlementListRow>[] = [
    {
      key: "paidAt",
      header: "Paid",
      cell: (r) => (
        <Link href={`/seller/settlements/${r.id}`} className="font-medium text-ink hover:underline">
          {new Date(r.paidAt).toLocaleDateString()}
        </Link>
      ),
    },
    { key: "gross", header: "Gross", align: "right", cell: (r) => pesos(r.grossReceivable) },
    { key: "commission", header: "Commission", align: "right", cell: (r) => `−${pesos(r.commissionAmount)}` },
    { key: "clawback", header: "Clawback", align: "right", cell: (r) => (r.clawbackAmount ? `−${pesos(r.clawbackAmount)}` : "—") },
    { key: "net", header: "Net paid", align: "right", cell: (r) => <span className="font-medium tabular-nums">{pesos(r.netAmount)}</span> },
    { key: "reference", header: "Reference", cell: (r) => r.paymentReference ?? "—" },
  ];

  return (
    <div>
      <PageHeader
        title="Settlements"
        description="Payouts Axiaro has recorded for your orders. Each is money already paid to you outside the platform — bank transfer, GCash or cash."
      />

      <div className="mb-6 max-w-sm">
        <StatCard
          label="Pending this cycle"
          value={pesos(pending.netAmount)}
          hint={`${pending.eligibleOrders.length} eligible order${pending.eligibleOrders.length === 1 ? "" : "s"}${pending.clawbackAmount ? ` · less ${pesos(pending.clawbackAmount)} in clawbacks` : ""} · not yet paid`}
        />
      </div>

      {pending.outstandingClawbacks.length > 0 && (
        <Card className="mb-6 border-clay/40">
          <h2 className="mb-2 text-sm font-semibold text-clay">Outstanding clawbacks</h2>
          <p className="mb-2 text-xs text-ink-faint">
            These orders were cancelled or returned after they were paid out. The amounts will be deducted from your next
            settlement.
          </p>
          <ul className="space-y-1 text-sm">
            {pending.outstandingClawbacks.map((c) => (
              <li key={c.id} className="flex justify-between">
                <span className="text-ink-soft">{c.orderNumber}</span>
                <span className="tabular-nums text-clay">−{pesos(c.clawbackAmount)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {rows.length === 0 ? (
        <EmptyState title="No settlements yet" description="Once Axiaro records a payout to you, it will appear here." />
      ) : (
        <DataTable columns={columns} rows={rows} getRowKey={(r) => r.id} />
      )}
    </div>
  );
}
