"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { requestReturnAction, type ReturnFormState } from "@/lib/returns-actions";
import {
  RETURN_REASONS,
  RETURN_REASON_LABEL,
  RETURN_LIMITS,
} from "@/lib/returns/status";
import { formatPrice } from "@/lib/utils";

export type ReturnFormLine = {
  orderItemId: string;
  name: string;
  variantLabel: string | null;
  sku: string | null;
  unitPrice: number;
  remaining: number;
};

export function ReturnRequestForm({
  orderNumber,
  lines,
}: {
  orderNumber: string;
  lines: ReturnFormLine[];
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<ReturnFormState, FormData>(
    requestReturnAction,
    {},
  );
  const [qty, setQty] = useState<Record<string, number>>(
    Object.fromEntries(lines.map((l) => [l.orderItemId, 0])),
  );

  useEffect(() => {
    if (state.ok && state.returnNumber) {
      toast.success("Return request submitted");
      router.push(`/account/returns/${state.returnNumber}`);
    }
  }, [state.ok, state.returnNumber, router]);

  const anySelected = Object.values(qty).some((n) => n > 0);

  return (
    <form action={formAction} className="space-y-6">
      <input type="hidden" name="orderNumber" value={orderNumber} />

      <div className="card-surface divide-y divide-line">
        {lines.map((l) => (
          <div key={l.orderItemId} className="flex flex-wrap items-center gap-4 p-4">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{l.name}</p>
              {l.variantLabel && <p className="text-xs text-ink-faint">{l.variantLabel}</p>}
              <p className="mt-0.5 text-xs text-ink-faint">
                {formatPrice(l.unitPrice)} each · up to {l.remaining} returnable
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <span className="text-ink-soft">Return qty</span>
              <input
                type="number"
                name={`qty:${l.orderItemId}`}
                min={0}
                max={l.remaining}
                value={qty[l.orderItemId] ?? 0}
                onChange={(e) => {
                  const n = Math.max(0, Math.min(l.remaining, Number(e.target.value) || 0));
                  setQty((q) => ({ ...q, [l.orderItemId]: n }));
                }}
                className="field w-20"
              />
            </label>
          </div>
        ))}
      </div>
      {state.fieldErrors?.items && (
        <p className="text-sm text-clay">{state.fieldErrors.items}</p>
      )}

      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">Reason for return</span>
        <select name="reason" required className="field" defaultValue="">
          <option value="" disabled>
            Choose a reason…
          </option>
          {RETURN_REASONS.map((r) => (
            <option key={r} value={r}>
              {RETURN_REASON_LABEL[r]}
            </option>
          ))}
        </select>
        {state.fieldErrors?.reason && (
          <span className="mt-1 block text-xs text-clay">{state.fieldErrors.reason}</span>
        )}
      </label>

      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">
          Anything else we should know? <span className="text-ink-faint">(optional)</span>
        </span>
        <textarea
          name="note"
          rows={4}
          maxLength={RETURN_LIMITS.noteMax}
          className="field resize-y"
          placeholder="e.g. which part is damaged, or which item you expected"
        />
      </label>

      {state.error && (
        <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>
      )}

      <button type="submit" disabled={pending || !anySelected} className="btn btn-primary">
        {pending && <Loader2 size={15} className="animate-spin" />}
        Submit return request
      </button>
      {!anySelected && (
        <p className="text-xs text-ink-faint">Set a quantity for at least one item to continue.</p>
      )}
    </form>
  );
}
