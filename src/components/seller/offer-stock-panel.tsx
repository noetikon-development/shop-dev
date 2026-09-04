"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  adjustOfferStockAction,
  setOfferReorderPointAction,
  type SellerActionState,
} from "@/lib/seller/offer-actions";
import { FormField, Select, notify, usePersistentAction } from "@/components/seller/ui";

const REASONS = [
  { value: "RESTOCK", label: "Restock" },
  { value: "MANUAL_ADJUSTMENT", label: "Manual adjustment" },
  { value: "DAMAGE", label: "Damage" },
  { value: "LOSS", label: "Loss" },
  { value: "CORRECTION", label: "Correction" },
];

export function OfferStockPanel({
  offerId,
  quantity,
  reserved,
  available,
  reorderPoint,
  readOnly,
}: {
  offerId: string;
  quantity: number;
  reserved: number;
  available: number;
  reorderPoint: number;
  readOnly?: boolean;
}) {
  const adjust = usePersistentAction<SellerActionState>(adjustOfferStockAction, {});
  const reorder = usePersistentAction<SellerActionState>(setOfferReorderPointAction, {});
  const [mode, setMode] = useState<"increase" | "decrease" | "set">("increase");

  useEffect(() => {
    if (adjust.state.ok && adjust.state.message) notify.success(adjust.state.message);
    if (adjust.state.error) notify.error(adjust.state.error);
  }, [adjust.state]);
  useEffect(() => {
    if (reorder.state.ok && reorder.state.message) notify.success(reorder.state.message);
    if (reorder.state.error) notify.error(reorder.state.error);
  }, [reorder.state]);

  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-3 gap-3 text-sm">
        <Stat label="On hand" value={quantity} />
        <Stat label="Reserved" value={reserved} />
        <Stat label="Available" value={available} />
      </dl>

      {readOnly ? (
        <p className="text-sm text-ink-faint">Archived — stock is read-only.</p>
      ) : (
        <>
          <form onSubmit={adjust.onSubmit} className="space-y-3 border-t border-line pt-4">
            <input type="hidden" name="offerId" value={offerId} />
            <input type="hidden" name="currentQuantity" value={quantity} />
            <div className="grid gap-3 sm:grid-cols-[auto_1fr]">
              <FormField label="Change" htmlFor="mode">
                <Select
                  id="mode"
                  name="mode"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as typeof mode)}
                >
                  <option value="increase">Add</option>
                  <option value="decrease">Remove</option>
                  <option value="set">Set to</option>
                </Select>
              </FormField>
              <FormField
                label={mode === "set" ? "New on-hand" : "Quantity"}
                htmlFor="amount"
                error={adjust.state.fieldErrors?.amount}
              >
                <input id="amount" name="amount" type="number" min={0} required className="field text-sm" />
              </FormField>
            </div>
            <FormField label="Reason" htmlFor="reason" error={adjust.state.fieldErrors?.reason}>
              <Select id="reason" name="reason" defaultValue="RESTOCK">
                {REASONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Note" htmlFor="note" hint="Optional">
              <input id="note" name="note" maxLength={300} className="field text-sm" />
            </FormField>
            {adjust.state.error && (
              <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{adjust.state.error}</p>
            )}
            <button type="submit" disabled={adjust.pending} className="btn btn-primary py-2 text-sm">
              {adjust.pending && <Loader2 size={13} className="animate-spin" />}
              Apply
            </button>
          </form>

          <form onSubmit={reorder.onSubmit} className="flex items-end gap-2 border-t border-line pt-4">
            <input type="hidden" name="offerId" value={offerId} />
            <FormField label="Reorder point" htmlFor="reorderPoint" error={reorder.state.fieldErrors?.reorderPoint}>
              <input
                id="reorderPoint"
                name="reorderPoint"
                type="number"
                min={0}
                defaultValue={reorderPoint}
                className="field w-28 text-sm"
              />
            </FormField>
            <button type="submit" disabled={reorder.pending} className="btn btn-outline py-2 text-sm">
              {reorder.pending && <Loader2 size={13} className="animate-spin" />}
              Save
            </button>
          </form>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-sm bg-surface-sunken px-3 py-2">
      <dt className="text-xs uppercase tracking-wide text-ink-faint">{label}</dt>
      <dd className="mt-0.5 font-display text-lg text-ink">{value}</dd>
    </div>
  );
}
