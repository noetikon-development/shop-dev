"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import {
  confirmCodPaymentFormAction,
  type ConfirmCodPaymentFormState,
} from "@/lib/admin/payment-actions";
import { notify, usePersistentAction } from "@/components/admin/ui";
import { formatPrice } from "@/lib/utils";

/**
 * 9F-43B — "Record COD payment received" control, rendered inside `PaymentPanel`
 * on the admin order detail page for a DELIVERED cash-on-delivery order that is
 * still awaiting payment. The amount is the read-only `Order.grandTotal`; the
 * operator never enters an amount. The server action re-checks every guard.
 */
export function RecordCodPayment({
  orderId,
  grandTotal,
}: {
  orderId: string;
  grandTotal: number;
}) {
  const router = useRouter();
  const { state, onSubmit, pending } = usePersistentAction<ConfirmCodPaymentFormState>(
    confirmCodPaymentFormAction,
    {},
  );

  useEffect(() => {
    if (state.ok) {
      notify.success(state.message ?? "COD payment recorded.");
      router.refresh();
    }
    if (state.error) notify.error(state.error);
  }, [state, router]);

  return (
    <form onSubmit={onSubmit} className="mt-3 space-y-3 rounded-sm border border-line bg-surface-sunken/40 p-4">
      <input type="hidden" name="orderId" value={orderId} />

      <div>
        <p className="text-sm font-medium text-ink">Record COD payment received</p>
        <p className="mt-0.5 text-xs text-ink-faint">
          Only after Axiaro has received the remitted cash for this order.
        </p>
      </div>

      <div className="text-sm">
        <span className="block text-xs text-ink-faint">Amount</span>
        <span className="font-medium tabular-nums text-ink">{formatPrice(grandTotal)}</span>
        <span className="ml-2 text-xs text-ink-faint">(order total — not editable)</span>
      </div>

      <label className="block text-sm">
        <span className="text-xs text-ink-faint">Remittance reference (optional)</span>
        <input
          type="text"
          name="remittanceReference"
          maxLength={200}
          placeholder="Courier remittance batch / bank reference"
          className="field mt-1 text-sm"
        />
      </label>

      <label className="block text-sm">
        <span className="text-xs text-ink-faint">Note (optional)</span>
        <textarea name="note" rows={2} maxLength={2000} className="field mt-1 text-sm" />
      </label>

      {state.error && <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>}

      <button type="submit" disabled={pending} className="btn btn-primary py-1.5 text-sm">
        {pending && <Loader2 size={14} className="animate-spin" />}
        Record COD payment received
      </button>
    </form>
  );
}
