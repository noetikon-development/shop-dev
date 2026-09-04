"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import {
  createProductFromRequestAction,
  type RequestReviewState,
} from "@/lib/admin/seller-product-requests/actions";
import { FormField, Select, notify, usePersistentAction } from "@/components/admin/ui";

type CategoryOption = { id: string; label: string; active: boolean };
type Proposal = {
  name: string;
  brand: string | null;
  shortDescription: string | null;
  description: string | null;
  categoryId: string | null;
  options: { name: string; values: string[] }[];
};

const MAX_OPTIONS = 3;

export function CreateProductPanel({
  requestId,
  categories,
  proposal,
}: {
  requestId: string;
  categories: CategoryOption[];
  proposal: Proposal;
}) {
  const { state, onSubmit, pending } = usePersistentAction<RequestReviewState>(
    createProductFromRequestAction,
    {},
  );
  const fe = state.fieldErrors ?? {};

  const [options, setOptions] = useState<{ name: string; values: string }[]>(
    proposal.options.map((o) => ({ name: o.name, values: o.values.join(", ") })),
  );

  useEffect(() => {
    if (state.ok && state.message) notify.success(state.message);
    if (state.error) notify.error(state.error);
  }, [state]);

  const optionsJson = useMemo(
    () =>
      JSON.stringify(
        options
          .map((o) => ({
            name: o.name.trim(),
            values: [...new Set(o.values.split(/[\n,]/).map((v) => v.trim()).filter(Boolean))],
          }))
          .filter((o) => o.name && o.values.length),
      ),
    [options],
  );

  const setOption = (i: number, patch: Partial<{ name: string; values: string }>) =>
    setOptions((o) => o.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="optionsJson" value={optionsJson} />
      <p className="text-xs text-ink-faint">
        Curate these into Axiaro house style — the seller&rsquo;s wording is only a starting point.
        The product is created as a <strong>draft</strong> and put on no storefront until you
        activate it.
      </p>

      <FormField label="Product name" htmlFor="cpr-name" required error={fe.name}>
        <input id="cpr-name" name="name" required defaultValue={proposal.name} maxLength={160} className="field text-sm" />
      </FormField>

      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Brand" htmlFor="cpr-brand" required error={fe.brand}>
          <input id="cpr-brand" name="brand" required defaultValue={proposal.brand || "Axiaro"} maxLength={80} className="field text-sm" />
        </FormField>
        <FormField label="Slug" htmlFor="cpr-slug" hint="Leave blank to auto-generate." error={fe.slug}>
          <input id="cpr-slug" name="slug" maxLength={120} className="field text-sm" placeholder="auto" />
        </FormField>
      </div>

      <FormField label="Short description" htmlFor="cpr-short" required error={fe.shortDescription}>
        <input
          id="cpr-short"
          name="shortDescription"
          required
          defaultValue={proposal.shortDescription ?? ""}
          maxLength={300}
          className="field text-sm"
        />
      </FormField>

      <FormField label="Description" htmlFor="cpr-desc" required error={fe.description}>
        <textarea
          id="cpr-desc"
          name="description"
          required
          rows={4}
          defaultValue={proposal.description ?? ""}
          maxLength={8000}
          className="field text-sm"
        />
      </FormField>

      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Category" htmlFor="cpr-cat" required error={fe.categoryId}>
          <Select id="cpr-cat" name="categoryId" required defaultValue={proposal.categoryId ?? ""}>
            <option value="">— choose —</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id} disabled={!c.active}>
                {c.label}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Status" htmlFor="cpr-status">
          <Select id="cpr-status" name="status" defaultValue="DRAFT">
            <option value="DRAFT">Draft (not on storefront)</option>
            <option value="ACTIVE">Active</option>
          </Select>
        </FormField>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <FormField label="Price (₱)" htmlFor="cpr-price" required error={fe.price}>
          <input id="cpr-price" name="price" required inputMode="decimal" className="field text-sm" placeholder="0.00" />
        </FormField>
        <FormField label="Compare-at (₱)" htmlFor="cpr-compare">
          <input id="cpr-compare" name="compareAtPrice" inputMode="decimal" className="field text-sm" placeholder="—" />
        </FormField>
        <FormField label="Weight (g)" htmlFor="cpr-weight">
          <input id="cpr-weight" name="weightGrams" inputMode="numeric" className="field text-sm" placeholder="500" />
        </FormField>
      </div>

      <FormField label="Default SKU" htmlFor="cpr-sku" hint="Leave blank to auto-generate." error={fe.sku}>
        <input id="cpr-sku" name="sku" maxLength={64} className="field text-sm" placeholder="auto" />
      </FormField>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink">Options</legend>
        <p className="text-xs text-ink-faint">
          Up to {MAX_OPTIONS}. Variants are generated from the value combinations. Leave empty for a
          single-variant product.
        </p>
        {options.map((opt, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
            <input
              value={opt.name}
              onChange={(e) => setOption(i, { name: e.target.value })}
              placeholder="Colour"
              maxLength={40}
              className="field text-sm"
            />
            <input
              value={opt.values}
              onChange={(e) => setOption(i, { values: e.target.value })}
              placeholder="Black, Navy, Sand"
              className="field text-sm"
            />
            <button
              type="button"
              onClick={() => setOptions((o) => o.filter((_, idx) => idx !== i))}
              aria-label="Remove option"
              className="btn btn-ghost px-2 py-2 text-ink-faint"
            >
              <X size={14} />
            </button>
          </div>
        ))}
        {options.length < MAX_OPTIONS && (
          <button
            type="button"
            onClick={() => setOptions((o) => [...o, { name: "", values: "" }])}
            className="btn btn-outline py-1.5 text-xs"
          >
            <Plus size={13} /> Add option
          </button>
        )}
      </fieldset>

      <FormField label="Note for the seller" htmlFor="cpr-note">
        <textarea id="cpr-note" name="note" rows={2} maxLength={2000} className="field text-sm" placeholder="Optional" />
      </FormField>

      {state.error && <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>}

      <button type="submit" disabled={pending} className="btn btn-primary py-2 text-sm">
        {pending && <Loader2 size={14} className="animate-spin" />}
        Approve &amp; create product
      </button>
    </form>
  );
}
