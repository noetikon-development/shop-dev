"use client";

import { Loader2 } from "lucide-react";
import { createOfferAction, type SellerActionState } from "@/lib/seller/offer-actions";
import { FormField, Select, usePersistentAction } from "@/components/seller/ui";

const CONDITIONS = [
  { value: "NEW", label: "New" },
  { value: "REFURBISHED", label: "Refurbished" },
  { value: "USED_LIKE_NEW", label: "Used — like new" },
  { value: "USED_GOOD", label: "Used — good" },
];

export function OfferCreateForm({
  variantId,
  catalogPrice,
  catalogCompareAt,
  takenConditions = [],
}: {
  variantId: string;
  catalogPrice: number;
  catalogCompareAt: number | null;
  /** conditions the seller already lists for this variant — shown disabled */
  takenConditions?: string[];
}) {
  const { state, onSubmit, pending } = usePersistentAction<SellerActionState>(createOfferAction, {});
  const fe = state.fieldErrors ?? {};
  const taken = new Set(takenConditions);
  const firstFree = CONDITIONS.find((c) => !taken.has(c.value))?.value ?? "NEW";

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <input type="hidden" name="variantId" value={variantId} />

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Your price (₱)" htmlFor="price" required error={fe.price} hint={`Catalog price is ₱${(catalogPrice / 100).toLocaleString()}`}>
          <input
            id="price"
            name="price"
            inputMode="decimal"
            required
            defaultValue={(catalogPrice / 100).toString()}
            className="field text-sm"
          />
        </FormField>
        <FormField
          label="Compare-at (₱)"
          htmlFor="compareAtPrice"
          error={fe.compareAtPrice}
          hint="Optional — must exceed your price"
        >
          <input
            id="compareAtPrice"
            name="compareAtPrice"
            inputMode="decimal"
            defaultValue={catalogCompareAt ? (catalogCompareAt / 100).toString() : ""}
            className="field text-sm"
          />
        </FormField>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          label="Condition"
          htmlFor="condition"
          error={fe.condition}
          hint={taken.size > 0 ? "Greyed-out conditions are already listed." : undefined}
        >
          <Select id="condition" name="condition" defaultValue={firstFree}>
            {CONDITIONS.map((c) => (
              <option key={c.value} value={c.value} disabled={taken.has(c.value)}>
                {c.label}
                {taken.has(c.value) ? " — already listed" : ""}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Your SKU" htmlFor="sellerSku" error={fe.sellerSku} hint="Optional">
          <input id="sellerSku" name="sellerSku" maxLength={64} className="field text-sm" />
        </FormField>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <FormField label="Opening stock" htmlFor="openingQuantity" error={fe.openingQuantity}>
          <input
            id="openingQuantity"
            name="openingQuantity"
            type="number"
            min={0}
            defaultValue={0}
            className="field text-sm"
          />
        </FormField>
        <FormField label="Reorder point" htmlFor="reorderPoint" error={fe.reorderPoint}>
          <input id="reorderPoint" name="reorderPoint" type="number" min={0} defaultValue={3} className="field text-sm" />
        </FormField>
        <FormField label="Handling days" htmlFor="handlingTimeDays" error={fe.handlingTimeDays}>
          <input
            id="handlingTimeDays"
            name="handlingTimeDays"
            type="number"
            min={0}
            max={30}
            defaultValue={2}
            className="field text-sm"
          />
        </FormField>
      </div>

      {state.error && (
        <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>
      )}

      <div className="flex items-center gap-2 border-t border-line pt-4">
        <button type="submit" disabled={pending} className="btn btn-primary py-2 text-sm">
          {pending && <Loader2 size={14} className="animate-spin" />}
          Create listing
        </button>
        <span className="text-xs text-ink-faint">
          New listings are saved as a draft — publishing to buyers opens later.
        </span>
      </div>
    </form>
  );
}
