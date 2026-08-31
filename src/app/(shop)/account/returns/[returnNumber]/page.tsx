import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getCustomerReturn } from "@/lib/returns";
import {
  returnStatusLabel,
  returnStatusTone,
  returnReasonLabel,
} from "@/lib/returns/status";
import { ReturnTimeline } from "@/components/returns/return-timeline";
import { WithdrawReturnButton } from "@/components/returns/withdraw-return-button";
import { formatPrice, formatDate, cn } from "@/lib/utils";

export async function generateMetadata({
  params,
}: PageProps<"/account/returns/[returnNumber]">): Promise<Metadata> {
  const { returnNumber } = await params;
  return { title: `Return ${returnNumber}` };
}

const TONE_CLASS: Record<string, string> = {
  success: "bg-sage-50 text-sage",
  info: "bg-clay-50 text-clay",
  warning: "bg-surface-sunken text-ink-soft",
  danger: "bg-clay-50 text-sale",
  neutral: "bg-surface-sunken text-ink-soft",
};

export default async function CustomerReturnDetailPage({
  params,
}: PageProps<"/account/returns/[returnNumber]">) {
  const { returnNumber } = await params;
  const user = await requireUser(`/account/returns/${returnNumber}`);
  const ret = await getCustomerReturn(user.id, returnNumber);
  if (!ret) notFound();

  const terminalOffPath = ret.status === "REJECTED" || ret.status === "CANCELLED";
  const refundKnown = ret.refundAmount != null;

  return (
    <div className="space-y-6">
      <Link
        href="/account/returns"
        className="inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink"
      >
        <ChevronLeft size={15} /> All returns
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl">Return {ret.returnNumber}</h2>
          <p className="mt-1 text-sm text-ink-soft">
            For order{" "}
            <Link href={`/account/orders/${ret.order.orderNumber}`} className="underline hover:text-ink">
              {ret.order.orderNumber}
            </Link>{" "}
            · requested {formatDate(ret.createdAt)}
          </p>
        </div>
        <span
          className={cn(
            "rounded-full px-3 py-1 text-xs font-semibold",
            TONE_CLASS[returnStatusTone(ret.status)],
          )}
        >
          {returnStatusLabel(ret.status)}
        </span>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
        <div className="space-y-6">
          <div className="card-surface p-5">
            <h3 className="text-sm font-medium">Items</h3>
            <ul className="mt-3 divide-y divide-line">
              {ret.items.map((it) => (
                <li key={it.id} className="flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{it.name}</p>
                    {it.variantLabel && (
                      <p className="text-xs text-ink-faint">{it.variantLabel}</p>
                    )}
                    <p className="mt-0.5 text-xs text-ink-faint">Qty {it.quantity}</p>
                  </div>
                  <span className="text-sm tabular-nums text-ink-soft">
                    {formatPrice(it.refundAmount)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-ink-faint">
              Reason: {returnReasonLabel(ret.reason)}
            </p>
            {ret.customerNote && (
              <p className="mt-2 whitespace-pre-wrap text-sm text-ink-soft">
                “{ret.customerNote}”
              </p>
            )}
          </div>

          {ret.resolutionNote && (
            <div className="card-surface p-5">
              <h3 className="text-sm font-medium">A note from our team</h3>
              <p className="mt-2 whitespace-pre-wrap text-sm text-ink-soft">{ret.resolutionNote}</p>
            </div>
          )}

          {(ret.status === "REFUND_INITIATED" || ret.status === "REFUND_COMPLETED") && refundKnown && (
            <div className="card-surface p-5">
              <h3 className="text-sm font-medium">Refund</h3>
              <dl className="mt-3 space-y-1.5 text-sm">
                <div className="flex justify-between">
                  <dt className="text-ink-soft">Amount recorded</dt>
                  <dd className="tabular-nums">{formatPrice(ret.refundAmount!)}</dd>
                </div>
                {ret.refundMethod && (
                  <div className="flex justify-between">
                    <dt className="text-ink-soft">Method</dt>
                    <dd>{ret.refundMethod}</dd>
                  </div>
                )}
                {ret.refundCompletedAt ? (
                  <div className="flex justify-between">
                    <dt className="text-ink-soft">Completed</dt>
                    <dd>{formatDate(ret.refundCompletedAt)}</dd>
                  </div>
                ) : ret.refundInitiatedAt ? (
                  <div className="flex justify-between">
                    <dt className="text-ink-soft">Started</dt>
                    <dd>{formatDate(ret.refundInitiatedAt)}</dd>
                  </div>
                ) : null}
              </dl>
              <p className="mt-3 text-xs text-ink-faint">
                Depending on the original payment method, a completed refund can take a few business
                days to reach you.
              </p>
            </div>
          )}

          {ret.status === "REQUESTED" && (
            <div className="card-surface p-5">
              <p className="text-sm text-ink-soft">
                Changed your mind? You can withdraw this request while it&apos;s still being reviewed.
              </p>
              <div className="mt-3">
                <WithdrawReturnButton returnNumber={ret.returnNumber} />
              </div>
            </div>
          )}
        </div>

        <aside className="card-surface h-fit p-5">
          <h3 className="text-sm font-medium">Progress</h3>
          <div className="mt-4">
            {terminalOffPath ? (
              <p className="text-sm text-ink-soft">
                This return was {returnStatusLabel(ret.status).toLowerCase()}
                {ret.status === "REJECTED"
                  ? ". See the note from our team above."
                  : "."}
              </p>
            ) : (
              <ReturnTimeline status={ret.status} />
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
