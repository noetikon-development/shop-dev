"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Minus, Plus, Equal } from "lucide-react";
import {
  Modal,
  ConfirmDialog,
  FormField,
  Select,
  StatusBadge,
  notify,
} from "@/components/admin/ui";
import {
  ADJUSTMENT_REASONS,
  ADJUSTMENT_REASON_LABEL,
  stockStatusFromAvailable,
  STOCK_STATUS_LABEL,
} from "@/lib/inventory-status";
import {
  adjustStockAction,
  updateThresholdAction,
  type InventoryActionState,
} from "@/lib/admin/inventory-actions";

export type InventoryItem = {
  variantId: string;
  sku: string;
  productName: string;
  optionLabel: string;
  quantity: number;
  reserved: number;
  available: number;
  reorderPoint: number;
};

const STATUS_TONE = {
  IN_STOCK: "success",
  LOW_STOCK: "warning",
  OUT_OF_STOCK: "danger",
} as const;

export function AdjustStockModal({
  item,
  onClose,
}: {
  item: InventoryItem | null;
  onClose: () => void;
}) {
  const router = useRouter();

  const [mode, setMode] = useState<"increase" | "decrease" | "set">("increase");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState<string>("RESTOCK");
  const [note, setNote] = useState("");
  const [threshold, setThreshold] = useState(String(item?.reorderPoint ?? ""));
  const [confirm, setConfirm] = useState(false);

  const [adjState, adjustAction, adjusting] = useActionState<InventoryActionState, FormData>(
    adjustStockAction,
    {},
  );
  const [thrState, thresholdAction, savingThreshold] = useActionState<InventoryActionState, FormData>(
    updateThresholdAction,
    {},
  );

  useEffect(() => {
    if (adjState.ok) {
      notify.success(adjState.message ?? "Stock updated");
      router.refresh();
      onClose();
    }
    if (adjState.error) notify.error(adjState.error);
  }, [adjState, router, onClose]);

  useEffect(() => {
    if (thrState.ok) {
      notify.success(thrState.message ?? "Threshold updated");
      router.refresh();
    }
    if (thrState.error) notify.error(thrState.error);
  }, [thrState, router]);

  const n = Number(amount);
  const validAmount = amount !== "" && Number.isInteger(n) && n >= 0;

  const projectedQuantity = useMemo(() => {
    if (!item || !validAmount) return item?.quantity ?? 0;
    if (mode === "set") return n;
    return mode === "increase" ? item.quantity + n : item.quantity - n;
  }, [item, mode, n, validAmount]);

  const projectedAvailable = item ? Math.max(0, projectedQuantity - item.reserved) : 0;
  const belowReserved = item ? projectedQuantity < item.reserved : false;
  const negative = projectedQuantity < 0;
  const noChange = item ? projectedQuantity === item.quantity : true;

  const projectedStatus = stockStatusFromAvailable(
    projectedAvailable,
    Number(threshold) || 0,
  );

  const canApply = validAmount && !belowReserved && !negative && !noChange && Boolean(reason);

  if (!item) return null;

  const fe = adjState.fieldErrors ?? {};

  return (
    <>
      <Modal
        open={item !== null}
        onClose={onClose}
        size="md"
        title={`Adjust stock — ${item.productName}`}
        description={`${item.optionLabel} · ${item.sku}`}
      >
        {/* Current numbers */}
        <div className="grid grid-cols-3 gap-3 rounded-md border border-line bg-surface-sunken/50 p-3 text-center">
          <div>
            <p className="text-xs text-ink-faint">On hand</p>
            <p className="font-display text-xl">{item.quantity}</p>
          </div>
          <div>
            <p className="text-xs text-ink-faint">Reserved</p>
            <p className="font-display text-xl">{item.reserved}</p>
          </div>
          <div>
            <p className="text-xs text-ink-faint">Available</p>
            <p className="font-display text-xl">{item.available}</p>
          </div>
        </div>

        {/* Adjustment form */}
        <div className="mt-4 space-y-4">
          <div className="inline-flex overflow-hidden rounded-sm border border-line-strong text-sm">
            {(
              [
                ["increase", "Add", Plus],
                ["decrease", "Remove", Minus],
                ["set", "Set exact", Equal],
              ] as const
            ).map(([m, label, Icon]) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`flex items-center gap-1.5 px-3 py-1.5 transition-colors ${
                  mode === m ? "bg-ink text-paper" : "text-ink-soft hover:bg-surface-sunken"
                }`}
              >
                <Icon size={13} />
                {label}
              </button>
            ))}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label={mode === "set" ? "New quantity" : "Quantity"}
              htmlFor="adj-amount"
              error={fe.amount}
            >
              <input
                id="adj-amount"
                inputMode="numeric"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))}
                className="field text-sm"
                placeholder="0"
              />
            </FormField>
            <FormField label="Reason" htmlFor="adj-reason" error={fe.reason}>
              <Select
                id="adj-reason"
                value={mode === "set" ? "CORRECTION" : reason}
                onChange={(e) => setReason(e.target.value)}
                disabled={mode === "set"}
              >
                {mode === "set" ? (
                  <option value="CORRECTION">Correction</option>
                ) : (
                  ADJUSTMENT_REASONS.filter((r) => r !== "CORRECTION").map((r) => (
                    <option key={r} value={r}>
                      {ADJUSTMENT_REASON_LABEL[r] ?? r}
                    </option>
                  ))
                )}
              </Select>
            </FormField>
          </div>

          <FormField label="Note (optional)" htmlFor="adj-note">
            <input
              id="adj-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={300}
              className="field text-sm"
              placeholder="e.g. PO #1024, supplier delivery"
            />
          </FormField>

          {/* Projection */}
          <div className="rounded-md border border-line bg-surface p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-ink-soft">New on-hand</span>
              <span className={`font-medium ${negative || belowReserved ? "text-clay" : "text-ink"}`}>
                {projectedQuantity}
              </span>
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-ink-soft">New available</span>
              <span className="font-medium text-ink">{projectedAvailable}</span>
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-ink-soft">Status</span>
              <StatusBadge tone={STATUS_TONE[projectedStatus]}>
                {STOCK_STATUS_LABEL[projectedStatus]}
              </StatusBadge>
            </div>
            {belowReserved && (
              <p className="mt-2 text-xs text-clay">
                Can’t go below the {item.reserved} unit(s) currently reserved.
              </p>
            )}
            {negative && <p className="mt-2 text-xs text-clay">Stock can’t be negative.</p>}
          </div>

          <div className="flex justify-end gap-2 border-t border-line pt-3">
            <button type="button" onClick={onClose} className="btn btn-outline py-2 text-sm">
              Cancel
            </button>
            <button
              type="button"
              disabled={!canApply || adjusting}
              onClick={() => setConfirm(true)}
              className="btn btn-primary py-2 text-sm"
            >
              {adjusting && <Loader2 size={14} className="animate-spin" />}
              Review &amp; apply
            </button>
          </div>
        </div>

        {/* Threshold */}
        <form action={thresholdAction} className="mt-5 border-t border-line pt-4">
          <input type="hidden" name="variantId" value={item.variantId} />
          <p className="text-sm font-semibold text-ink">Low-stock threshold</p>
          <p className="text-xs text-ink-faint">
            Available at or below this triggers the LOW_STOCK status.
          </p>
          <div className="mt-2 flex items-end gap-2">
            <FormField label="Reorder point" htmlFor="adj-threshold">
              <input
                id="adj-threshold"
                name="reorderPoint"
                inputMode="numeric"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value.replace(/[^\d]/g, ""))}
                className="field w-28 text-sm"
              />
            </FormField>
            <button
              type="submit"
              disabled={savingThreshold || threshold === String(item.reorderPoint)}
              className="btn btn-outline py-2 text-sm disabled:opacity-40"
            >
              {savingThreshold && <Loader2 size={14} className="animate-spin" />}
              Save threshold
            </button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => {
          const fd = new FormData();
          fd.set("variantId", item.variantId);
          fd.set("mode", mode);
          fd.set("amount", String(n));
          fd.set("reason", mode === "set" ? "CORRECTION" : reason);
          fd.set("note", note);
          adjustAction(fd);
          setConfirm(false);
        }}
        tone="default"
        title="Apply this adjustment?"
        message={
          <>
            <strong>{item.productName}</strong> ({item.sku}) will change from{" "}
            <strong>{item.quantity}</strong> to <strong>{projectedQuantity}</strong> on hand
            {" "}({mode === "set" ? "correction" : (ADJUSTMENT_REASON_LABEL[reason] ?? reason).toLowerCase()}).
            This is recorded in the inventory history.
          </>
        }
        confirmLabel="Apply"
        pending={adjusting}
      />
    </>
  );
}
