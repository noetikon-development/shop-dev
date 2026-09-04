"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  sellerReceiveReturnAction,
  type SellerReturnActionState,
} from "@/lib/seller/return-actions";
import { Select, ConfirmDialog, notify, usePersistentAction } from "@/components/seller/ui";

type Line = { id: string; name: string; quantity: number; offerBound: boolean };

const CONDITIONS = [
  { value: "RESELLABLE", label: "Resellable" },
  { value: "OPENED", label: "Opened" },
  { value: "DAMAGED", label: "Damaged" },
];

type LineState = { received: number; restock: number; condition: string };

export function ReturnReceiptPanel({ returnId, lines }: { returnId: string; lines: Line[] }) {
  const { state, dispatch, pending } = usePersistentAction<SellerReturnActionState>(
    sellerReceiveReturnAction,
    {},
  );
  const [rows, setRows] = useState<Record<string, LineState>>(
    () =>
      Object.fromEntries(
        lines.map((l) => [l.id, { received: l.quantity, restock: l.offerBound ? l.quantity : 0, condition: "RESELLABLE" }]),
      ) as Record<string, LineState>,
  );
  const [confirm, setConfirm] = useState(false);
  const byId = Object.fromEntries(lines.map((l) => [l.id, l]));

  useEffect(() => {
    if (state.ok && state.message) notify.success(state.message);
    if (state.error) notify.error(state.error);
  }, [state]);

  const setRow = (id: string, patch: Partial<LineState>) =>
    setRows((r) => {
      const next = { ...r[id], ...patch };
      // keep the numbers coherent
      next.received = clamp(next.received, 0, byId[id].quantity);
      const maxRestock = next.condition === "RESELLABLE" && byId[id].offerBound ? next.received : 0;
      next.restock = clamp(next.restock, 0, maxRestock);
      return { ...r, [id]: next };
    });

  const submit = () => {
    const fd = new FormData();
    fd.set("returnId", returnId);
    for (const l of lines) {
      const s = rows[l.id];
      fd.set(`recv:${l.id}`, String(s.received));
      fd.set(`restock:${l.id}`, String(s.restock));
      fd.set(`condition:${l.id}`, s.condition);
    }
    dispatch(fd);
  };

  const totalRestock = lines.reduce((n, l) => n + rows[l.id].restock, 0);

  return (
    <div className="space-y-4">
      <p className="text-xs text-ink-faint">
        Marking this received advances the return and returns any resellable units to your stock. Axiaro then handles the
        refund.
      </p>

      <div className="space-y-3">
        {lines.map((l) => {
          const s = rows[l.id];
          const restockDisabled = s.condition !== "RESELLABLE" || !l.offerBound;
          return (
            <div key={l.id} className="rounded-sm border border-line p-3">
              <p className="text-sm font-medium text-ink">{l.name}</p>
              <p className="text-xs text-ink-faint">Customer is returning {l.quantity}</p>
              <div className="mt-2 grid grid-cols-3 gap-2">
                <label className="text-xs">
                  <span className="mb-1 block text-ink-faint">Received</span>
                  <input
                    type="number"
                    min={0}
                    max={l.quantity}
                    value={s.received}
                    onChange={(e) => setRow(l.id, { received: Number(e.target.value) })}
                    className="field py-1.5 text-sm"
                  />
                </label>
                <label className="text-xs">
                  <span className="mb-1 block text-ink-faint">Condition</span>
                  <Select
                    value={s.condition}
                    onChange={(e) => setRow(l.id, { condition: e.target.value })}
                    className="py-1.5"
                  >
                    {CONDITIONS.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="text-xs">
                  <span className="mb-1 block text-ink-faint">Restock</span>
                  <input
                    type="number"
                    min={0}
                    max={s.received}
                    value={s.restock}
                    disabled={restockDisabled}
                    onChange={(e) => setRow(l.id, { restock: Number(e.target.value) })}
                    className="field py-1.5 text-sm disabled:opacity-50"
                  />
                </label>
              </div>
              {!l.offerBound && (
                <p className="mt-1 text-xs text-clay">Not one of your offers — can’t restock.</p>
              )}
            </div>
          );
        })}
      </div>

      {state.error && <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>}

      <button
        type="button"
        disabled={pending}
        onClick={() => setConfirm(true)}
        className="btn btn-primary w-full py-2 text-sm"
      >
        {pending && <Loader2 size={13} className="animate-spin" />}
        Confirm receipt
      </button>

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          submit();
        }}
        title="Confirm receipt?"
        message={
          totalRestock > 0
            ? `This marks the return received and puts ${totalRestock} unit(s) back into your stock. It can't be undone.`
            : "This marks the return received. No units will be restocked. It can't be undone."
        }
        confirmLabel="Confirm receipt"
        pending={pending}
      />
    </div>
  );
}

function clamp(n: number, lo: number, hi: number) {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
