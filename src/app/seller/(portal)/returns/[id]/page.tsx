import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireSellerSessionPermission } from "@/lib/seller/session";
import { getSellerReturnDetail } from "@/lib/seller/returns";
import { PageHeader, Card, StatusBadge } from "@/components/seller/ui";
import { pesos } from "@/lib/seller/format";
import { returnStatusLabel, returnStatusTone, returnReasonLabel } from "@/lib/returns/status";
import { ReturnReceiptPanel } from "@/components/seller/return-receipt-panel";

export const metadata: Metadata = { title: "Return" };

export default async function SellerReturnDetailPage({ params }: PageProps<"/seller/returns/[id]">) {
  const { ctx } = await requireSellerSessionPermission("manage_seller_returns");
  const { id } = await params;
  const ret = await getSellerReturnDetail(ctx, id);
  if (!ret) notFound();

  const received = ret.status === "RECEIVED" || ret.restockedAt !== null;

  return (
    <div>
      <PageHeader
        title={ret.returnNumber}
        description={`Order ${ret.orderNumber} · ${returnReasonLabel(ret.reason)}`}
        actions={<StatusBadge tone={returnStatusTone(ret.status)}>{returnStatusLabel(ret.status)}</StatusBadge>}
      />
      <Link
        href="/seller/returns"
        className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink"
      >
        <ArrowLeft size={14} /> Back to Returns
      </Link>

      <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        <div className="space-y-6">
          <Card padded={false}>
            <div className="border-b border-line px-5 py-3">
              <h2 className="text-sm font-semibold">Your lines ({ret.lines.length})</h2>
            </div>
            <ul className="divide-y divide-line-soft">
              {ret.lines.map((l) => (
                <li key={l.id} className="px-5 py-3 text-sm">
                  <div className="flex items-center gap-3">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-ink">{l.name}</span>
                      <span className="block truncate text-xs text-ink-faint">
                        {[l.variantLabel, l.sku].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <span className="tabular-nums text-ink-faint">
                      {pesos(l.unitPrice)} · returning {l.quantity}
                    </span>
                  </div>
                  {received && (
                    <p className="mt-1 text-xs text-ink-soft">
                      Recorded: {l.condition ?? "—"} · restocked {l.restockQuantity}
                    </p>
                  )}
                  {!l.offerBound && (
                    <p className="mt-1 text-xs text-clay">Not bound to one of your offers — can’t restock this line.</p>
                  )}
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <h2 className="mb-3 text-sm font-semibold">Return details</h2>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <Row label="Reason">{returnReasonLabel(ret.reason)}</Row>
              <Row label="Requested">{ret.createdAt.toISOString().slice(0, 10)}</Row>
              {ret.deliveredAt && <Row label="Delivered">{ret.deliveredAt.toISOString().slice(0, 10)}</Row>}
              <Row label="Order status">{ret.orderStatus}</Row>
            </dl>
            {ret.customerNote && (
              <div className="mt-4 border-t border-line pt-3">
                <p className="text-xs uppercase tracking-wide text-ink-faint">Customer note</p>
                <p className="mt-1 text-sm text-ink-soft">{ret.customerNote}</p>
              </div>
            )}
            {ret.resolutionNote && (
              <div className="mt-3 border-t border-line pt-3">
                <p className="text-xs uppercase tracking-wide text-ink-faint">Axiaro note</p>
                <p className="mt-1 text-sm text-ink-soft">{ret.resolutionNote}</p>
              </div>
            )}
          </Card>

          <Card>
            <h2 className="mb-3 text-sm font-semibold">Ship-from (customer)</h2>
            {ret.ship ? (
              <address className="not-italic text-sm text-ink-soft">
                <span className="font-medium text-ink">{ret.ship.recipient}</span>
                {ret.ship.phone && <span className="block">{ret.ship.phone}</span>}
                {ret.ship.lines.map((s, i) => (
                  <span key={i} className="block">
                    {s}
                  </span>
                ))}
              </address>
            ) : (
              <p className="text-sm text-ink-faint">No address on file.</p>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <h2 className="mb-3 text-sm font-semibold">Receipt &amp; inspection</h2>
            {ret.canReceive ? (
              <ReturnReceiptPanel
                returnId={ret.id}
                lines={ret.lines.map((l) => ({
                  id: l.id,
                  name: l.name,
                  quantity: l.quantity,
                  offerBound: l.offerBound,
                }))}
              />
            ) : ret.status === "REQUESTED" ? (
              <p className="rounded-sm bg-warning-50 px-3 py-2 text-sm text-warning">
                Awaiting an Axiaro decision. You’ll be able to confirm receipt once the return is approved.
              </p>
            ) : ["RECEIVED", "REFUND_INITIATED", "REFUND_COMPLETED"].includes(ret.status) ? (
              <p className="text-sm text-ink-faint">
                Receipt confirmed{ret.restockedAt ? ` on ${ret.restockedAt.toISOString().slice(0, 10)}` : ""}. Axiaro
                handles the refund.
              </p>
            ) : (
              <p className="text-sm text-ink-faint">
                This return is {returnStatusLabel(ret.status).toLowerCase()} — no action needed.
              </p>
            )}
          </Card>

          <Card>
            <h2 className="mb-3 text-sm font-semibold">Who does what</h2>
            <ul className="space-y-1.5 text-sm text-ink-soft">
              <li>• <strong className="text-ink">Axiaro</strong> approves / rejects, and handles the refund and customer contact.</li>
              <li>• <strong className="text-ink">You</strong> confirm the goods arrived, record their condition, and choose how many go back to stock.</li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-ink-faint">{label}</dt>
      <dd className="mt-0.5 font-medium text-ink">{children}</dd>
    </div>
  );
}
