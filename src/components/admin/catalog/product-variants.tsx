"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Trash2, Save } from "lucide-react";
import {
  FormField,
  Select,
  ConfirmDialog,
  notify,
  usePersistentAction,
} from "@/components/admin/ui";
import {
  saveProductOptions,
  updateVariant,
  deleteVariant,
  addVariant,
  type CatalogState,
} from "@/lib/admin/catalog-actions";
import { VARIANT_STATUSES } from "@/lib/admin/catalog-schemas";

type OptionValue = { id: string; value: string };
type Option = { id: string; name: string; values: OptionValue[] };
type Variant = {
  id: string;
  sku: string;
  price: number;
  compareAtPrice: number | null;
  status: string;
  optionValueIds: string[];
  orderItemCount: number;
};

const pesos = (c: number | null) => (c == null ? "" : (c / 100).toFixed(2));
const OPTION_SUGGESTIONS = ["Colour", "Size", "Material", "Style"];

export function ProductVariants({
  productId,
  options,
  variants,
  canEdit,
  canCreate,
  canDelete,
}: {
  productId: string;
  options: Option[];
  variants: Variant[];
  canEdit: boolean;
  canCreate: boolean;
  canDelete: boolean;
}) {
  return (
    <div className="space-y-8">
      <p className="rounded-md border border-line bg-surface-sunken/40 px-3 py-2 text-xs text-ink-faint">
        <strong className="font-medium text-ink">Options</strong> (Colour, Size…) define the choices
        a customer makes. Each saved <strong className="font-medium text-ink">Variant</strong> is one
        purchasable combination and is the source of truth for its SKU, price and stock. A
        combination with no Variant row cannot be bought. Specifications live on the Details tab and
        are informational only.
      </p>
      <OptionsEditor productId={productId} options={options} canEdit={canEdit} />
      <VariantTable
        productId={productId}
        options={options}
        variants={variants}
        canEdit={canEdit}
        canCreate={canCreate}
        canDelete={canDelete}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

function OptionsEditor({
  productId,
  options,
  canEdit,
}: {
  productId: string;
  options: Option[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(
    options.map((o) => ({ name: o.name, values: o.values.map((v) => v.value).join(", ") })),
  );
  const [state, formAction, pending] = useActionState<CatalogState, FormData>(
    saveProductOptions,
    {},
  );

  useEffect(() => {
    if (state.ok) {
      notify.success(state.message ?? "Options saved");
      router.refresh();
    }
    if (state.error) notify.error(state.error);
  }, [state, router]);

  const submit = (formData: FormData) => {
    const payload = rows
      .map((r) => ({
        name: r.name.trim(),
        values: r.values.split(",").map((v) => v.trim()).filter(Boolean),
      }))
      .filter((r) => r.name && r.values.length);
    formData.set("productId", productId);
    formData.set("options", JSON.stringify(payload));
    return formAction(formData);
  };

  return (
    <section className="rounded-md border border-line bg-surface p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-ink">Option types</h3>
          <p className="text-xs text-ink-faint">
            e.g. Colour · Size · Material · Style. Saving rebuilds the variant list
            (every combination). Variants with order history are archived, not deleted.
          </p>
        </div>
      </div>

      <div className="space-y-3">
        {rows.map((row, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[160px_1fr_auto] sm:items-start">
            <input
              list="option-suggestions"
              value={row.name}
              onChange={(e) =>
                setRows((r) => r.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
              }
              placeholder="Option name"
              disabled={!canEdit}
              className="field text-sm"
            />
            <input
              value={row.values}
              onChange={(e) =>
                setRows((r) => r.map((x, j) => (j === i ? { ...x, values: e.target.value } : x)))
              }
              placeholder="Comma-separated values, e.g. Oak, Walnut, Black"
              disabled={!canEdit}
              className="field text-sm"
            />
            {canEdit && (
              <button
                type="button"
                onClick={() => setRows((r) => r.filter((_, j) => j !== i))}
                aria-label="Remove option"
                className="btn btn-ghost p-2 text-ink-faint hover:text-clay"
              >
                <Trash2 size={15} />
              </button>
            )}
          </div>
        ))}
        <datalist id="option-suggestions">
          {OPTION_SUGGESTIONS.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </div>

      {canEdit && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {rows.length < 3 && (
            <button
              type="button"
              onClick={() => setRows((r) => [...r, { name: "", values: "" }])}
              className="btn btn-outline py-2 text-sm"
            >
              <Plus size={14} /> Add option type
            </button>
          )}
          <form action={submit}>
            <button type="submit" disabled={pending} className="btn btn-primary py-2 text-sm">
              {pending && <Loader2 size={14} className="animate-spin" />}
              Save options &amp; rebuild variants
            </button>
          </form>
          {rows.length === 0 && (
            <span className="text-xs text-ink-faint">
              No options = one default variant.
            </span>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

function VariantTable({
  productId,
  options,
  variants,
  canEdit,
  canCreate,
  canDelete,
}: {
  productId: string;
  options: Option[];
  variants: Variant[];
  canEdit: boolean;
  canCreate: boolean;
  canDelete: boolean;
}) {
  const valueLabel = (id: string) => {
    for (const o of options) {
      const v = o.values.find((x) => x.id === id);
      if (v) return v.value;
    }
    return "";
  };
  const comboLabel = (v: Variant) =>
    v.optionValueIds.map(valueLabel).filter(Boolean).join(" · ") || "Default";

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink">
          Variants <span className="text-ink-faint">({variants.length})</span>
        </h3>
      </div>

      <div className="overflow-x-auto rounded-md border border-line">
        <table className="w-full min-w-[46rem] text-sm">
          <thead>
            <tr className="border-b border-line bg-surface-sunken/60 text-left text-xs uppercase tracking-wide text-ink-faint">
              <th className="px-3 py-2 font-semibold">Variant</th>
              <th className="px-3 py-2 font-semibold">SKU</th>
              <th className="px-3 py-2 font-semibold">Price</th>
              <th className="px-3 py-2 font-semibold">Compare-at</th>
              <th className="px-3 py-2 font-semibold">Status</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {variants.map((v) => (
              <VariantRow
                key={v.id}
                variant={v}
                label={comboLabel(v)}
                canEdit={canEdit}
                canDelete={canDelete}
                lastOne={variants.length <= 1}
              />
            ))}
          </tbody>
        </table>
      </div>

      {canCreate && options.length > 0 && (
        <AddVariant productId={productId} options={options} />
      )}
    </section>
  );
}

function VariantRow({
  variant,
  label,
  canEdit,
  canDelete,
  lastOne,
}: {
  variant: Variant;
  label: string;
  canEdit: boolean;
  canDelete: boolean;
  lastOne: boolean;
}) {
  const router = useRouter();
  const { state, onSubmit, pending } = usePersistentAction<CatalogState>(updateVariant, {});
  const [delState, delAction, deleting] = useActionState<CatalogState, FormData>(deleteVariant, {});
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    if (state.ok) {
      notify.success("Variant saved");
      router.refresh();
    }
    if (state.error) notify.error(state.error);
  }, [state, router]);
  useEffect(() => {
    if (delState.ok) {
      notify.success("Variant deleted");
      router.refresh();
    }
    if (delState.error) notify.error(delState.error);
  }, [delState, router]);

  const fe = state.fieldErrors ?? {};

  return (
    <tr className="border-b border-line/60 last:border-0 align-top">
      <td className="px-3 py-2.5">
        <span className="font-medium text-ink">{label}</span>
        {variant.orderItemCount > 0 && (
          <span className="ml-2 text-xs text-ink-faint">{variant.orderItemCount} sold</span>
        )}
      </td>
      <td className="px-3 py-2">
        <input
          form={`vf-${variant.id}`}
          name="sku"
          defaultValue={variant.sku}
          disabled={!canEdit}
          className="field w-32 font-mono text-xs"
        />
        {fe.sku && <p className="mt-0.5 text-xs text-clay">{fe.sku}</p>}
      </td>
      <td className="px-3 py-2">
        <input
          form={`vf-${variant.id}`}
          name="price"
          defaultValue={pesos(variant.price)}
          inputMode="decimal"
          disabled={!canEdit}
          className="field w-24 text-xs"
        />
        {fe.price && <p className="mt-0.5 text-xs text-clay">{fe.price}</p>}
      </td>
      <td className="px-3 py-2">
        <input
          form={`vf-${variant.id}`}
          name="compareAtPrice"
          defaultValue={pesos(variant.compareAtPrice)}
          inputMode="decimal"
          disabled={!canEdit}
          placeholder="—"
          className="field w-24 text-xs"
        />
        {fe.compareAtPrice && <p className="mt-0.5 text-xs text-clay">{fe.compareAtPrice}</p>}
      </td>
      <td className="px-3 py-2">
        <Select
          form={`vf-${variant.id}`}
          name="status"
          defaultValue={variant.status}
          disabled={!canEdit}
          className="w-28 text-xs"
        >
          {VARIANT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-right">
        {canEdit && (
          <form id={`vf-${variant.id}`} onSubmit={onSubmit} className="inline">
            <input type="hidden" name="id" value={variant.id} />
            <button type="submit" disabled={pending} className="btn btn-ghost p-1.5" aria-label="Save variant">
              {pending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            </button>
          </form>
        )}
        {canDelete && (
          <button
            type="button"
            onClick={() => setConfirm(true)}
            disabled={lastOne}
            title={lastOne ? "A product must keep at least one variant" : "Delete variant"}
            className="btn btn-ghost p-1.5 text-ink-faint hover:text-clay disabled:opacity-30"
          >
            <Trash2 size={14} />
          </button>
        )}
        <ConfirmDialog
          open={confirm}
          onClose={() => setConfirm(false)}
          onConfirm={() => {
            const fd = new FormData();
            fd.set("id", variant.id);
            delAction(fd);
            setConfirm(false);
          }}
          title="Delete this variant?"
          message={`${label} (${variant.sku}) will be removed. Variants with orders can't be deleted — archive them instead.`}
          confirmLabel="Delete"
          pending={deleting}
        />
      </td>
    </tr>
  );
}

function AddVariant({
  productId,
  options,
}: {
  productId: string;
  options: Option[];
}) {
  const router = useRouter();
  const { state, onSubmit, pending } = usePersistentAction<CatalogState>(addVariant, {});
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (state.ok) {
      notify.success("Variant added");
      router.refresh();
    }
    if (state.error) notify.error(state.error);
  }, [state, router]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="btn btn-outline mt-3 py-2 text-sm"
      >
        <Plus size={14} /> Add a specific variant
      </button>
    );
  }

  return (
    <form onSubmit={onSubmit} className="mt-3 rounded-md border border-line bg-surface p-4">
      <input type="hidden" name="productId" value={productId} />
      <div className="grid gap-3 sm:grid-cols-2">
        {options.map((o) => (
          <FormField key={o.id} label={o.name} htmlFor={`av-${o.id}`}>
            <Select id={`av-${o.id}`} name={`option_${o.id}`} defaultValue="" required>
              <option value="" disabled>
                Choose…
              </option>
              {o.values.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.value}
                </option>
              ))}
            </Select>
          </FormField>
        ))}
        <FormField label="SKU" htmlFor="av-sku" hint="Blank = auto">
          <input id="av-sku" name="sku" className="field font-mono text-sm" />
        </FormField>
        <FormField label="Price (pesos)" htmlFor="av-price" hint="Blank = product price">
          <input id="av-price" name="price" inputMode="decimal" className="field text-sm" />
        </FormField>
      </div>
      <div className="mt-3 flex gap-2">
        <button type="submit" disabled={pending} className="btn btn-primary py-2 text-sm">
          {pending && <Loader2 size={14} className="animate-spin" />}
          Add variant
        </button>
        <button type="button" onClick={() => setOpen(false)} className="btn btn-outline py-2 text-sm">
          Cancel
        </button>
      </div>
    </form>
  );
}
