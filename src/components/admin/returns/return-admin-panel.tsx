"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Card, Select, notify } from "@/components/admin/ui";
import { formatPrice } from "@/lib/utils";
import {
  RETURN_ITEM_CONDITIONS,
  RETURN_ITEM_CONDITION_LABEL,
  returnStatusLabel,
} from "@/lib/returns/status";
import {
  approveReturnAction,
  rejectReturnAction,
  receiveReturnAction,
  initiateRefundAction,
  completeRefundAction,
  cancelReturnAdminAction,
} from "@/lib/admin/returns-actions";

type PanelItem = {
  id: string;
  name: string;
  quantity: number;
  variantHasInventory: boolean;
  hasVariant: boolean;
};

export function ReturnAdminPanel({
  returnId,
  status,
  items,
  itemRefundSum,
  orderGrandTotal,
  orderPaymentMethod,
  existingRefundAmount,
  existingRefundMethod,
}: {
  returnId: string;
  status: string;
  items: PanelItem[];
  itemRefundSum: number;
  orderGrandTotal: number;
  orderPaymentMethod: string;
  existingRefundAmount: number | null;
  existingRefundMethod: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const run = (fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) =>
    start(async () => {
      const res = await fn();
      if (res.ok) {
        notify.success(res.message ?? "Done.");
        router.refresh();
      } else {
        notify.error(res.error ?? "That didn't work.");
      }
    });

  const terminal = ["REJECTED", "CANCELLED", "REFUND_COMPLETED"].includes(status);

  return (
    <Card>
      <h2 className="text-sm font-semibold text-ink">Manage return</h2>
      <p className="mt-1 text-xs text-ink-faint">
        Current status: {returnStatusLabel(status)}
      </p>

      <div className="mt-4 space-y-4">
        {status === "REQUESTED" && <ReviewForms returnId={returnId} pending={pending} run={run} />}

        {status === "APPROVED" && (
          <ReceiveForm returnId={returnId} items={items} pending={pending} run={run} />
        )}

        {status === "RECEIVED" && (
          <InitiateRefundForm
            returnId={returnId}
            defaultAmount={itemRefundSum}
            maxAmount={orderGrandTotal}
            defaultMethod={methodLabel(orderPaymentMethod)}
            pending={pending}
            run={run}
          />
        )}

        {status === "REFUND_INITIATED" && (
          <CompleteRefundForm
            returnId={returnId}
            amount={existingRefundAmount}
            method={existingRefundMethod}
            pending={pending}
            run={run}
          />
        )}

        {terminal && (
          <p className="text-sm text-ink-soft">
            This return is {returnStatusLabel(status).toLowerCase()}. No further action is available.
          </p>
        )}

        {!terminal && (
          <CancelForm returnId={returnId} status={status} pending={pending} run={run} />
        )}
      </div>
    </Card>
  );
}

function methodLabel(paymentMethod: string): string {
  switch (paymentMethod) {
    case "COD":
      return "Store credit / manual refund";
    case "CARD":
      return "Original card";
    case "GCASH":
      return "Original GCash account";
    default:
      return "Original payment method";
  }
}

type RunFn = (
  fn: () => Promise<{ ok: boolean; message?: string; error?: string }>,
) => void;

// --- REQUESTED: approve / reject -------------------------------------------

function ReviewForms({
  returnId,
  pending,
  run,
}: {
  returnId: string;
  pending: boolean;
  run: RunFn;
}) {
  const [resolutionNote, setResolutionNote] = useState("");
  const [staffNote, setStaffNote] = useState("");

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-ink-soft">
          Note to the customer <span className="text-ink-faint">(shown in the email)</span>
        </label>
        <textarea
          value={resolutionNote}
          onChange={(e) => setResolutionNote(e.target.value)}
          maxLength={2000}
          rows={2}
          className="field text-sm"
          placeholder="Required to reject; optional to approve"
          disabled={pending}
        />
      </div>
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-ink-soft">
          Internal note <span className="text-ink-faint">(never emailed)</span>
        </label>
        <input
          value={staffNote}
          onChange={(e) => setStaffNote(e.target.value)}
          maxLength={2000}
          className="field text-sm"
          disabled={pending}
        />
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            run(() =>
              approveReturnAction({
                returnId,
                resolutionNote: resolutionNote.trim() || undefined,
                staffNote: staffNote.trim() || undefined,
              }),
            )
          }
          className="btn btn-primary flex-1 py-2 text-sm"
        >
          {pending && <Loader2 size={14} className="animate-spin" />}
          Approve
        </button>
        <button
          type="button"
          disabled={pending || !resolutionNote.trim()}
          onClick={() =>
            run(() =>
              rejectReturnAction({
                returnId,
                resolutionNote: resolutionNote.trim(),
                staffNote: staffNote.trim() || undefined,
              }),
            )
          }
          className="btn btn-outline flex-1 py-2 text-sm text-clay"
        >
          Reject
        </button>
      </div>
      <p className="text-xs text-ink-faint">A reason is required to reject.</p>
    </div>
  );
}

// --- APPROVED: mark received (+ restock) ----------------------------------

function ReceiveForm({
  returnId,
  items,
  pending,
  run,
}: {
  returnId: string;
  items: PanelItem[];
  pending: boolean;
  run: RunFn;
}) {
  const [restock, setRestock] = useState<Record<string, number>>(
    Object.fromEntries(items.map((i) => [i.id, 0])),
  );
  const [condition, setCondition] = useState<Record<string, string>>(
    Object.fromEntries(items.map((i) => [i.id, ""])),
  );
  const [staffNote, setStaffNote] = useState("");

  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-faint">
        Set how many units of each line go back into sellable stock. Damaged or opened items should
        be 0.
      </p>
      {items.map((it) => {
        const canRestock = it.hasVariant && it.variantHasInventory;
        return (
          <div key={it.id} className="rounded-sm border border-line p-3">
            <p className="text-sm font-medium">{it.name}</p>
            <p className="text-xs text-ink-faint">Returned qty {it.quantity}</p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm">
                <span className="text-ink-soft">Restock</span>
                <input
                  type="number"
                  min={0}
                  max={it.quantity}
                  value={restock[it.id] ?? 0}
                  disabled={pending || !canRestock}
                  onChange={(e) =>
                    setRestock((r) => ({
                      ...r,
                      [it.id]: Math.max(0, Math.min(it.quantity, Number(e.target.value) || 0)),
                    }))
                  }
                  className="field w-20"
                />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <span className="text-ink-soft">Condition</span>
                <Select
                  value={condition[it.id] ?? ""}
                  disabled={pending}
                  onChange={(e) => setCondition((c) => ({ ...c, [it.id]: e.target.value }))}
                >
                  <option value="">—</option>
                  {RETURN_ITEM_CONDITIONS.map((c) => (
                    <option key={c} value={c}>
                      {RETURN_ITEM_CONDITION_LABEL[c]}
                    </option>
                  ))}
                </Select>
              </label>
            </div>
            {!canRestock && (
              <p className="mt-1 text-xs text-clay">
                Not stock-tracked — restock unavailable for this line.
              </p>
            )}
          </div>
        );
      })}
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-ink-soft">Internal note</label>
        <input
          value={staffNote}
          onChange={(e) => setStaffNote(e.target.value)}
          maxLength={2000}
          className="field text-sm"
          disabled={pending}
        />
      </div>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          run(() =>
            receiveReturnAction({
              returnId,
              lines: items.map((it) => ({
                returnItemId: it.id,
                restockQuantity: restock[it.id] ?? 0,
                condition: condition[it.id] || undefined,
              })),
              staffNote: staffNote.trim() || undefined,
            }),
          )
        }
        className="btn btn-primary w-full py-2 text-sm"
      >
        {pending && <Loader2 size={14} className="animate-spin" />}
        Mark received &amp; restock
      </button>
    </div>
  );
}

// --- RECEIVED: initiate refund (bookkeeping) ------------------------------

function InitiateRefundForm({
  returnId,
  defaultAmount,
  maxAmount,
  defaultMethod,
  pending,
  run,
}: {
  returnId: string;
  defaultAmount: number;
  maxAmount: number;
  defaultMethod: string;
  pending: boolean;
  run: RunFn;
}) {
  const [pesos, setPesos] = useState((defaultAmount / 100).toFixed(2));
  const [method, setMethod] = useState(defaultMethod);
  const [reference, setReference] = useState("");
  const [staffNote, setStaffNote] = useState("");

  const centavos = useMemo(() => Math.round((Number(pesos) || 0) * 100), [pesos]);
  const overMax = centavos > maxAmount;

  return (
    <div className="space-y-3">
      <p className="rounded-sm bg-clay-50 px-3 py-2 text-xs text-clay">
        Records the refund. Does not move money — process the actual refund in your payment
        provider/bank.
      </p>
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-ink-soft">Refund amount (₱)</label>
        <input
          type="number"
          step="0.01"
          min="0"
          value={pesos}
          onChange={(e) => setPesos(e.target.value)}
          className="field text-sm"
          disabled={pending}
        />
        <p className="text-xs text-ink-faint">
          Suggested {formatPrice(defaultAmount)} · order total {formatPrice(maxAmount)}
        </p>
        {overMax && <p className="text-xs text-clay">Can’t exceed the order total.</p>}
      </div>
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-ink-soft">Refund method</label>
        <input
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          maxLength={120}
          className="field text-sm"
          disabled={pending}
        />
      </div>
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-ink-soft">
          Reference <span className="text-ink-faint">(optional — bank/transfer ref)</span>
        </label>
        <input
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          maxLength={120}
          className="field text-sm"
          disabled={pending}
        />
      </div>
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-ink-soft">Internal note</label>
        <input
          value={staffNote}
          onChange={(e) => setStaffNote(e.target.value)}
          maxLength={2000}
          className="field text-sm"
          disabled={pending}
        />
      </div>
      <button
        type="button"
        disabled={pending || centavos < 1 || overMax || !method.trim()}
        onClick={() =>
          run(() =>
            initiateRefundAction({
              returnId,
              refundAmount: centavos,
              refundMethod: method.trim(),
              refundReference: reference.trim() || undefined,
              staffNote: staffNote.trim() || undefined,
            }),
          )
        }
        className="btn btn-primary w-full py-2 text-sm"
      >
        {pending && <Loader2 size={14} className="animate-spin" />}
        Record refund
      </button>
    </div>
  );
}

// --- REFUND_INITIATED: complete refund ----------------------------------

function CompleteRefundForm({
  returnId,
  amount,
  method,
  pending,
  run,
}: {
  returnId: string;
  amount: number | null;
  method: string | null;
  pending: boolean;
  run: RunFn;
}) {
  const [reference, setReference] = useState("");
  const [staffNote, setStaffNote] = useState("");

  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-soft">
        {amount != null ? formatPrice(amount) : "Refund"} via {method ?? "the recorded method"} —
        mark it complete once you&apos;ve processed it.
      </p>
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-ink-soft">
          Final reference <span className="text-ink-faint">(optional)</span>
        </label>
        <input
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          maxLength={120}
          className="field text-sm"
          disabled={pending}
        />
      </div>
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-ink-soft">Internal note</label>
        <input
          value={staffNote}
          onChange={(e) => setStaffNote(e.target.value)}
          maxLength={2000}
          className="field text-sm"
          disabled={pending}
        />
      </div>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          run(() =>
            completeRefundAction({
              returnId,
              refundReference: reference.trim() || undefined,
              staffNote: staffNote.trim() || undefined,
            }),
          )
        }
        className="btn btn-primary w-full py-2 text-sm"
      >
        {pending && <Loader2 size={14} className="animate-spin" />}
        Mark refund complete
      </button>
    </div>
  );
}

// --- Cancel (any non-terminal) ----------------------------------------

function CancelForm({
  returnId,
  status,
  pending,
  run,
}: {
  returnId: string;
  status: string;
  pending: boolean;
  run: RunFn;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  if (!open) {
    return (
      <div className="border-t border-line pt-4">
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={pending}
          className="btn btn-outline w-full py-2 text-sm text-clay"
        >
          Cancel this return
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2 border-t border-line pt-4">
      <label className="block text-xs font-medium text-ink-soft">
        Reason <span className="text-ink-faint">(recorded internally)</span>
      </label>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={300}
        rows={2}
        className="field text-sm"
        disabled={pending}
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={pending}
          className="btn btn-outline flex-1 py-2 text-sm"
        >
          Keep it
        </button>
        <button
          type="button"
          disabled={pending || !reason.trim()}
          onClick={() =>
            run(() => cancelReturnAdminAction({ returnId, reason: reason.trim() }))
          }
          className="btn btn-clay flex-1 py-2 text-sm text-paper"
        >
          {pending && <Loader2 size={14} className="animate-spin" />}
          Cancel return
        </button>
      </div>
      <p className="text-xs text-ink-faint">
        Cancelling from {returnStatusLabel(status)} is terminal and frees the order for a new return.
      </p>
    </div>
  );
}
