import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireSellerSession } from "@/lib/seller/session";
import { getSellerSettlement } from "@/lib/seller/settlement-repository";
import { pesos } from "@/lib/seller/format";
import { Card, PageHeader, StatusBadge } from "@/components/seller/ui";

export async function generateMetadata({
  params,
}: PageProps<"/seller/settlements/[id]">): Promise<Metadata> {
  const { id } = await params;
  void id;
  return { title: "Settlement" };
}

export default async function SellerSettlementDetailPage({ params }: PageProps<"/seller/settlements/[id]">) {
  const { ctx } = await requireSellerSession("/seller/settlements");
  const { id } = await params;

  const s = await getSellerSettlement(ctx, id);
  if (!s) notFound();

  return (
    <div>
      <Link href="/seller/settlements" className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink">
        <ChevronLeft size={15} /> All settlements
      </Link>

      <PageHeader
        title={`Settlement — ${new Date(s.paidAt).toLocaleDateString()}`}
        description="A payout Axiaro has already made to you outside the platform."
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
        <Card padded={false}>
          <div className="border-b border-line px-5 py-3">
            <h2 className="text-sm font-semibold">Orders</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[30rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-line bg-surface-sunken/60 text-xs uppercase tracking-wide text-ink-faint">
                  <th className="px-4 py-2 text-left">Order</th>
                  <th className="px-4 py-2 text-left">State</th>
                  <th className="px-4 py-2 text-right">Total</th>
                  <th className="px-4 py-2 text-right">Commission</th>
                </tr>
              </thead>
              <tbody>
                {s.sellerOrders.map((so) => (
                  <tr key={so.id} className="border-b border-line/60 last:border-0">
                    <td className="px-4 py-2.5">{so.order.orderNumber}</td>
                    <td className="px-4 py-2.5">
                      <StatusBadge tone={so.settlementStatus === "CLAWED_BACK" ? "danger" : "success"}>
                        {so.settlementStatus}
                      </StatusBadge>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink-soft">{pesos(so.total)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink-soft">−{pesos(so.commissionAmount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <dl className="space-y-1.5 border-t border-line px-5 py-4 text-sm">
            <div className="flex justify-between"><dt className="text-ink-faint">Gross receivable</dt><dd className="tabular-nums">{pesos(s.grossReceivable)}</dd></div>
            <div className="flex justify-between"><dt className="text-ink-faint">Commission</dt><dd className="tabular-nums">−{pesos(s.commissionAmount)}</dd></div>
            <div className="flex justify-between"><dt className="text-ink-faint">Clawbacks</dt><dd className="tabular-nums">−{pesos(s.clawbackAmount)}</dd></div>
            <div className="flex justify-between border-t border-line pt-1.5 font-medium"><dt>Net paid to you</dt><dd className="tabular-nums">{pesos(s.netAmount)}</dd></div>
          </dl>
        </Card>

        <Card>
          <h2 className="mb-3 text-sm font-semibold">Payment</h2>
          <dl className="space-y-2 text-sm">
            <div><dt className="text-xs text-ink-faint">Paid on</dt><dd>{new Date(s.paidAt).toLocaleDateString()}</dd></div>
            <div><dt className="text-xs text-ink-faint">Method</dt><dd>{s.paymentMethod ?? "—"}</dd></div>
            <div><dt className="text-xs text-ink-faint">Reference</dt><dd>{s.paymentReference ?? "—"}</dd></div>
          </dl>
        </Card>
      </div>
    </div>
  );
}
