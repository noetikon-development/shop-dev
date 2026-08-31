import { Card, StatusBadge } from "@/components/admin/ui";
import { formatPrice, formatDate } from "@/lib/utils";
import {
  paymentStatusLabel,
  paymentStatusTone,
  PAYMENT_REFUND_STATUS_LABEL,
} from "@/lib/payments/status";
import type { getOrderPayments } from "@/lib/admin/payments";
import { ReconcilePaymentButton } from "./reconcile-payment-button";

type Payments = Awaited<ReturnType<typeof getOrderPayments>>;

/**
 * Payment panel on the admin order detail page (Step 21 P4). Read-only view of
 * the order's Payment record(s) + their refunds. There is NO "mark as paid"
 * control — order payment state is advanced only by the verified webhook.
 *
 * Phase 4-A: every order has zero Payment rows, so this renders the "settled
 * outside PayMongo" note.
 */
export function PaymentPanel({
  payments,
  canManage,
  onlinePaymentEnabled,
}: {
  payments: Payments;
  canManage: boolean;
  onlinePaymentEnabled: boolean;
}) {
  if (payments.length === 0) {
    return (
      <Card>
        <h2 className="text-sm font-semibold text-ink">Payment</h2>
        <p className="mt-2 text-sm text-ink-soft">
          No PayMongo payment record for this order. Cash-on-delivery orders, and orders placed while
          online payment is disabled, are settled outside PayMongo — any refund for those is recorded
          as bookkeeping on the return.
        </p>
        {!onlinePaymentEnabled && (
          <p className="mt-2 text-xs text-ink-faint">
            Online payment is currently disabled (<code>payments.onlinePaymentEnabled = false</code>).
          </p>
        )}
      </Card>
    );
  }

  return (
    <Card padded={false}>
      <h2 className="px-5 pt-5 text-sm font-semibold text-ink">Payment</h2>
      <div className="mt-3 divide-y divide-line">
        {payments.map((p) => (
          <div key={p.id} className="px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <StatusBadge tone={paymentStatusTone(p.status)}>
                {paymentStatusLabel(p.status)}
              </StatusBadge>
              <span className="font-medium tabular-nums">{formatPrice(p.amount)}</span>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
              <dt className="text-ink-faint">Provider</dt>
              <dd className="text-ink">{p.provider}</dd>
              <dt className="text-ink-faint">Reference</dt>
              <dd className="break-all font-mono text-ink">{p.providerId}</dd>
              <dt className="text-ink-faint">Method</dt>
              <dd className="text-ink">{p.method ?? "—"}</dd>
              <dt className="text-ink-faint">Paid</dt>
              <dd className="text-ink">{p.paidAt ? formatDate(p.paidAt) : "—"}</dd>
              {p.failureReason && (
                <>
                  <dt className="text-ink-faint">Failure</dt>
                  <dd className="text-clay">{p.failureReason}</dd>
                </>
              )}
            </dl>

            {p.refunds.length > 0 && (
              <div className="mt-3 border-t border-line pt-3">
                <p className="text-xs font-medium text-ink-soft">Refunds</p>
                <ul className="mt-1.5 space-y-1 text-xs">
                  {p.refunds.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-3">
                      <span className="text-ink-soft">
                        {formatPrice(r.amount)} · {PAYMENT_REFUND_STATUS_LABEL[r.status] ?? r.status}
                        {r.returnRequest && ` · ${r.returnRequest.returnNumber}`}
                      </span>
                      {r.providerId && <code className="text-ink-faint">{r.providerId}</code>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {canManage && (p.status === "AWAITING_PAYMENT" || p.status === "PENDING") && (
              <div className="mt-3">
                <ReconcilePaymentButton paymentId={p.id} />
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
