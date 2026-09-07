import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requirePermission } from "@/lib/admin/rbac";
import { getAdminSettlement } from "@/lib/admin/settlements";
import { pesos } from "@/lib/seller/format";
import { Card, PageHeader, StatusBadge } from "@/components/admin/ui";

export async function generateMetadata({
  params,
}: PageProps<"/admin/settlements/[id]">): Promise<Metadata> {
  const { id } = await params;
  const s = await getAdminSettlement(id);
  return { title: s ? `Settlement · ${s.sellerName}` : "Settlement" };
}

export default async function AdminSettlementDetailPage({ params }: PageProps<"/admin/settlements/[id]">) {
  await requirePermission("manage_payments");
  const { id } = await params;

  const s = await getAdminSettlement(id);
  if (!s) notFound();

  return (
    <div>
      <Link href="/admin/settlements" className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink">
        <ChevronLeft size={15} /> All settlements
      </Link>

      <PageHeader
        title={`${s.sellerName} — settlement`}
        description={`Recorded ${new Date(s.createdAt).toLocaleString()} · paid ${new Date(s.paidAt).toLocaleDateString()}`}
        actions={<StatusBadge tone="success">{s.status}</StatusBadge>}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card padded={false}>
          <div className="border-b border-line px-5 py-3">
            <h2 className="text-sm font-semibold">Orders in this settlement</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-line bg-surface-sunken/60 text-xs uppercase tracking-wide text-ink-faint">
                  <th className="px-4 py-2 text-left">Order</th>
                  <th className="px-4 py-2 text-left">State</th>
                  <th className="px-4 py-2 text-right">Total</th>
                  <th className="px-4 py-2 text-right">Commission</th>
                  <th className="px-4 py-2 text-right">Clawback held</th>
                </tr>
              </thead>
              <tbody>
                {s.sellerOrders.map((so) => (
                  <tr key={so.id} className="border-b border-line/60 last:border-0">
                    <td className="px-4 py-2.5">
                      <Link href={`/admin/seller-orders/${so.id}`} className="text-ink hover:underline">
                        {so.order.orderNumber}
                      </Link>
                      <span className="block text-xs text-ink-faint">{so.order.email}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusBadge tone={so.settlementStatus === "CLAWED_BACK" ? "danger" : "success"}>
                        {so.settlementStatus}
                      </StatusBadge>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink-soft">{pesos(so.total)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink-soft">−{pesos(so.commissionAmount)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink-soft">
                      {so.settlementClawbackAmount ? `−${pesos(so.settlementClawbackAmount)}` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="space-y-4">
          <Card>
            <h2 className="mb-3 text-sm font-semibold">Amounts</h2>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-ink-faint">Gross receivable</dt><dd className="tabular-nums">{pesos(s.grossReceivable)}</dd></div>
              <div className="flex justify-between"><dt className="text-ink-faint">Commission</dt><dd className="tabular-nums">−{pesos(s.commissionAmount)}</dd></div>
              <div className="flex justify-between"><dt className="text-ink-faint">Clawbacks reconciled</dt><dd className="tabular-nums">−{pesos(s.clawbackAmount)}</dd></div>
              <div className="flex justify-between border-t border-line pt-2 font-medium"><dt>Net paid</dt><dd className="tabular-nums">{pesos(s.netAmount)}</dd></div>
            </dl>
            <p className="mt-3 text-xs text-ink-faint">
              {s.orderCount} order{s.orderCount === 1 ? "" : "s"} settled · {s.clawbackCount} clawback{s.clawbackCount === 1 ? "" : "s"} reconciled.
              Bookkeeping record only — no automatic transfer.
            </p>
          </Card>

          <Card>
            <h2 className="mb-3 text-sm font-semibold">Payment</h2>
            <dl className="space-y-2 text-sm">
              <div><dt className="text-xs text-ink-faint">Paid on</dt><dd>{new Date(s.paidAt).toLocaleDateString()}</dd></div>
              <div><dt className="text-xs text-ink-faint">Method</dt><dd>{s.paymentMethod ?? "—"}</dd></div>
              <div><dt className="text-xs text-ink-faint">Reference</dt><dd>{s.paymentReference ?? "—"}</dd></div>
              {s.note && <div><dt className="text-xs text-ink-faint">Note</dt><dd className="whitespace-pre-wrap">{s.note}</dd></div>}
            </dl>
          </Card>
        </div>
      </div>
    </div>
  );
}
