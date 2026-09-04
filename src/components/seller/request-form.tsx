"use client";

import { useEffect, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import {
  createRequestAction,
  updateRequestAction,
  type SellerRequestActionState,
} from "@/lib/seller/product-request-actions";
import { FormField, Select, notify, usePersistentAction } from "@/components/seller/ui";

type Category = { id: string; name: string; parentName: string | null };
type Variant = { label: string; proposedSku?: string | null; barcode?: string | null; attributes?: string | null };

type Defaults = {
  proposedName: string;
  proposedBrand: string | null;
  proposedShortDesc: string | null;
  proposedDescription: string | null;
  proposedCategoryId: string | null;
  categoryNote: string | null;
  barcode: string | null;
  sellerNote: string | null;
  variants: Variant[];
};

export function RequestForm({
  mode,
  requestId,
  categories,
  defaults,
}: {
  mode: "create" | "edit";
  requestId?: string;
  categories: Category[];
  defaults?: Defaults;
}) {
  const action = mode === "create" ? createRequestAction : updateRequestAction;
  const { state, onSubmit, pending } = usePersistentAction<SellerRequestActionState>(action, {});

  const [rows, setRows] = useState<Variant[]>(
    defaults?.variants.length ? defaults.variants : [{ label: "Default" }],
  );

  useEffect(() => {
    if (state.ok && state.message) notify.success(state.message);
    if (state.error) notify.error(state.error);
  }, [state]);

  const setRow = (i: number, patch: Partial<Variant>) =>
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  const addRow = () => setRows((r) => (r.length < 12 ? [...r, { label: "" }] : r));
  const removeRow = (i: number) => setRows((r) => (r.length > 1 ? r.filter((_, idx) => idx !== i) : r));

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      {requestId && <input type="hidden" name="requestId" value={requestId} />}

      <FormField label="Product name" htmlFor="proposedName" required>
        <input
          id="proposedName"
          name="proposedName"
          required
          minLength={2}
          maxLength={160}
          defaultValue={defaults?.proposedName ?? ""}
          className="field text-sm"
          placeholder="e.g. Solid Oak Bedside Table"
        />
      </FormField>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Brand" htmlFor="proposedBrand">
          <input id="proposedBrand" name="proposedBrand" maxLength={80} defaultValue={defaults?.proposedBrand ?? ""} className="field text-sm" />
        </FormField>
        <FormField label="Barcode (GTIN / EAN / UPC)" htmlFor="barcode" hint="8–14 digits. Optional.">
          <input id="barcode" name="barcode" inputMode="numeric" maxLength={20} defaultValue={defaults?.barcode ?? ""} className="field text-sm" />
        </FormField>
      </div>

      <FormField label="Short description" htmlFor="proposedShortDesc" hint="One line for listings and search (max 300).">
        <input id="proposedShortDesc" name="proposedShortDesc" maxLength={300} defaultValue={defaults?.proposedShortDesc ?? ""} className="field text-sm" />
      </FormField>

      <FormField label="Full description" htmlFor="proposedDescription">
        <textarea
          id="proposedDescription"
          name="proposedDescription"
          rows={4}
          maxLength={8000}
          defaultValue={defaults?.proposedDescription ?? ""}
          className="field text-sm"
        />
      </FormField>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Category" htmlFor="proposedCategoryId" hint="Pick the closest existing one.">
          <Select id="proposedCategoryId" name="proposedCategoryId" defaultValue={defaults?.proposedCategoryId ?? ""}>
            <option value="">— not sure —</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.parentName ? `${c.parentName} / ` : ""}
                {c.name}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Category note" htmlFor="categoryNote" hint="If none fit, tell Axiaro where it belongs.">
          <input id="categoryNote" name="categoryNote" maxLength={500} defaultValue={defaults?.categoryNote ?? ""} className="field text-sm" />
        </FormField>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-ink">Variants</legend>
        <p className="text-xs text-ink-faint">
          One row per option you want to sell (e.g. a size or colour). Axiaro sets the final SKUs.
        </p>
        {rows.map((row, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
            <input
              name={`variant.${i}.label`}
              value={row.label}
              onChange={(e) => setRow(i, { label: e.target.value })}
              placeholder="Label (e.g. Oak / Large)"
              maxLength={60}
              className="field text-sm"
            />
            <input
              name={`variant.${i}.sku`}
              value={row.proposedSku ?? ""}
              onChange={(e) => setRow(i, { proposedSku: e.target.value })}
              placeholder="Proposed SKU (optional)"
              maxLength={64}
              className="field text-sm"
            />
            <input
              name={`variant.${i}.barcode`}
              value={row.barcode ?? ""}
              onChange={(e) => setRow(i, { barcode: e.target.value })}
              placeholder="Barcode (optional)"
              inputMode="numeric"
              maxLength={20}
              className="field text-sm"
            />
            <button
              type="button"
              onClick={() => removeRow(i)}
              disabled={rows.length <= 1}
              aria-label="Remove variant"
              className="btn btn-ghost px-2 py-2 text-ink-faint disabled:opacity-40"
            >
              <X size={14} />
            </button>
          </div>
        ))}
        <button type="button" onClick={addRow} disabled={rows.length >= 12} className="btn btn-outline py-1.5 text-xs">
          <Plus size={13} /> Add variant
        </button>
      </fieldset>

      <FormField label="Anything else for Axiaro" htmlFor="sellerNote">
        <textarea id="sellerNote" name="sellerNote" rows={2} maxLength={2000} defaultValue={defaults?.sellerNote ?? ""} className="field text-sm" />
      </FormField>

      {state.error && <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>}
      {state.blocks && state.blocks.length > 0 && (
        <ul className="space-y-1 rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">
          {state.blocks.map((b, i) => (
            <li key={i}>{b.message}</li>
          ))}
        </ul>
      )}

      <div className="border-t border-line pt-4">
        <button type="submit" disabled={pending} className="btn btn-primary py-2 text-sm">
          {pending && <Loader2 size={14} className="animate-spin" />}
          {mode === "create" ? "Create draft" : "Save draft"}
        </button>
      </div>
    </form>
  );
}
