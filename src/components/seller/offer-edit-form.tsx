"use client";

import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import { updateOfferAction, type SellerActionState } from "@/lib/seller/offer-actions";
import { FormField, Select, notify, usePersistentAction } from "@/components/seller/ui";

import { conditionLabel } from "@/lib/seller/format";
import { CONDITION_OPTIONS as CONDITIONS } from "@/lib/marketplace/conditions";

export function OfferEditForm({
  offerId,
  price,
  compareAtPrice,
  sellerSku,
  condition,
  status,
  handlingTimeDays,
}: {
  offerId: string;
  price: number;
  compareAtPrice: number | null;
  sellerSku: string | null;
  condition: string;
  /** 9F-22: an ACTIVE listing's condition is locked — the seller must set it
   *  inactive first. Undefined (older callers) keeps the field editable. */
  status?: string;
  handlingTimeDays: number;
}) {
  const conditionLocked = status === "ACTIVE";
  const { state, onSubmit, pending } = usePersistentAction<SellerActionState>(updateOfferAction, {});
  const fe = state.fieldErrors ?? {};

  useEffect(() => {
    if (state.ok && state.message) notify.success(state.message);
  }, [state]);

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <input type="hidden" name="offerId" value={offerId} />

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Price (₱)" htmlFor="price" required error={fe.price}>
          <input
            id="price"
            name="price"
            inputMode="decimal"
            required
            defaultValue={(price / 100).toString()}
            className="field text-sm"
          />
        </FormField>
        <FormField label="Compare-at (₱)" htmlFor="compareAtPrice" error={fe.compareAtPrice} hint="Blank to clear">
          <input
            id="compareAtPrice"
            name="compareAtPrice"
            inputMode="decimal"
            defaultValue={compareAtPrice ? (compareAtPrice / 100).toString() : ""}
            className="field text-sm"
          />
        </FormField>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <FormField
          label="Condition"
          htmlFor="condition"
          error={fe.condition}
          hint={conditionLocked ? "Set this listing inactive to change the condition." : undefined}
        >
          {conditionLocked ? (
            <>
              <input type="hidden" name="condition" value={condition} />
              <p className="field flex items-center text-sm text-ink-soft">{conditionLabel(condition)}</p>
            </>
          ) : (
            <Select id="condition" name="condition" defaultValue={condition}>
              {CONDITIONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField label="Your SKU" htmlFor="sellerSku" error={fe.sellerSku}>
          <input id="sellerSku" name="sellerSku" maxLength={64} defaultValue={sellerSku ?? ""} className="field text-sm" />
        </FormField>
        <FormField label="Handling days" htmlFor="handlingTimeDays" error={fe.handlingTimeDays}>
          <input
            id="handlingTimeDays"
            name="handlingTimeDays"
            type="number"
            min={0}
            max={30}
            defaultValue={handlingTimeDays}
            className="field text-sm"
          />
        </FormField>
      </div>

      {state.error && <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>}

      <div className="border-t border-line pt-4">
        <button type="submit" disabled={pending} className="btn btn-primary py-2 text-sm">
          {pending && <Loader2 size={14} className="animate-spin" />}
          Save changes
        </button>
      </div>
    </form>
  );
}
