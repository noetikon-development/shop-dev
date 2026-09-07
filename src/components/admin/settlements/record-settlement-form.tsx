"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { recordSettlementAction, type RecordSettlementState } from "@/lib/admin/settlement-actions";
import { notify, usePersistentAction } from "@/components/admin/ui";

/**
 * Bookkeeping settlement — record that a payment was made to a seller OUTSIDE
 * the system. No amounts are entered here; the server recomputes gross /
 * commission / clawback / net from the eligible orders. The admin only supplies
 * the payment date and free-text reference / method / note.
 */
export function RecordSettlementForm({
  sellerId,
  netAmountLabel,
  disabled,
}: {
  sellerId: string;
  netAmountLabel: string;
  disabled: boolean;
}) {
  const router = useRouter();
  const { state, onSubmit, pending } = usePersistentAction<RecordSettlementState>(recordSettlementAction, {});

  useEffect(() => {
    if (state.ok && state.settlementId) {
      notify.success(state.message ?? "Settlement recorded.");
      router.push(`/admin/settlements/${state.settlementId}`);
    }
    if (state.error) notify.error(state.error);
  }, [state, router]);

  const today = new Date().toISOString().slice(0, 10);

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <input type="hidden" name="sellerId" value={sellerId} />

      <p className="rounded-sm bg-surface-sunken px-3 py-2 text-sm">
        Recording this creates a bookkeeping settlement for a <strong>net of {netAmountLabel}</strong>. It does not move
        any money — it records that you have already paid the seller outside the system.
      </p>

      <label className="block text-sm">
        <span className="text-xs text-ink-faint">Payment date</span>
        <input type="date" name="paidAt" required defaultValue={today} max={today} className="field mt-1 text-sm" />
      </label>
      <label className="block text-sm">
        <span className="text-xs text-ink-faint">Payment reference (bank ref, GCash ref, “cash”…)</span>
        <input type="text" name="paymentReference" maxLength={200} className="field mt-1 text-sm" />
      </label>
      <label className="block text-sm">
        <span className="text-xs text-ink-faint">Payment method</span>
        <input type="text" name="paymentMethod" maxLength={120} placeholder="Bank transfer / GCash / Cash" className="field mt-1 text-sm" />
      </label>
      <label className="block text-sm">
        <span className="text-xs text-ink-faint">Internal note (optional)</span>
        <textarea name="note" rows={2} maxLength={2000} className="field mt-1 text-sm" />
      </label>

      {state.error && <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>}

      <button type="submit" disabled={pending || disabled} className="btn btn-primary py-2 text-sm">
        {pending && <Loader2 size={14} className="animate-spin" />}
        Record settlement
      </button>
    </form>
  );
}
