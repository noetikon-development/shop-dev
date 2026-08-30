"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { slugify } from "@/lib/utils";
import { FormField, Select, notify, usePersistentAction } from "@/components/admin/ui";
import {
  createProduct,
  updateProduct,
  type CatalogState,
} from "@/lib/admin/catalog-actions";
import { PRODUCT_STATUSES } from "@/lib/admin/catalog-schemas";

type CategoryOption = { id: string; label: string };

type Existing = {
  id: string;
  name: string;
  slug: string;
  shortDescription: string;
  description: string;
  categoryId: string;
  status: string;
  featured: boolean;
  freeShipping: boolean;
  price: number;
  compareAtPrice: number | null;
  weightGrams: number;
  defaultSku?: string | null;
  variantCount: number;
  /** Informational content shown on the storefront. JSON strings; not editable here. */
  specs?: string;
  highlights?: string;
  care?: string | null;
};

function safeJson<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const pesos = (centavos: number | null | undefined) =>
  centavos == null ? "" : (centavos / 100).toFixed(2);

export function ProductForm({
  categories,
  product,
  canEdit,
}: {
  categories: CategoryOption[];
  product?: Existing;
  canEdit: boolean;
}) {
  const router = useRouter();
  const isEdit = Boolean(product);
  const { state, onSubmit, pending } = usePersistentAction<CatalogState>(
    isEdit ? updateProduct : createProduct,
    {},
  );

  const [name, setName] = useState(product?.name ?? "");
  const [typedSlug, setTypedSlug] = useState(product?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(Boolean(product));
  const slug = slugTouched ? typedSlug : slugify(name);

  useEffect(() => {
    if (state.ok) {
      notify.success(state.message ?? "Saved");
      router.refresh();
    }
    if (state.error) notify.error(state.error);
  }, [state, router]);

  const fe = state.fieldErrors ?? {};
  const disabled = !canEdit;

  return (
    <form onSubmit={onSubmit} className="space-y-8">
      {product && <input type="hidden" name="id" value={product.id} />}

      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-ink">Basic information</h2>
        <FormField label="Name" htmlFor="p-name" required error={fe.name}>
          <input
            id="p-name"
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            disabled={disabled}
            className="field text-sm"
          />
        </FormField>
        <FormField
          label="Slug"
          htmlFor="p-slug"
          required
          error={fe.slug}
          hint="URL: /p/<slug>. Auto-filled from the name; edit if you need to."
        >
          <input
            id="p-slug"
            name="slug"
            value={slug}
            onChange={(e) => {
              setTypedSlug(e.target.value);
              setSlugTouched(true);
            }}
            disabled={disabled}
            className="field font-mono text-sm"
          />
        </FormField>
        <FormField label="Short description" htmlFor="p-short" required error={fe.shortDescription}>
          <input
            id="p-short"
            name="shortDescription"
            defaultValue={product?.shortDescription ?? ""}
            required
            maxLength={300}
            disabled={disabled}
            className="field text-sm"
          />
        </FormField>
        <FormField label="Description" htmlFor="p-desc" required error={fe.description}>
          <textarea
            id="p-desc"
            name="description"
            defaultValue={product?.description ?? ""}
            required
            rows={6}
            disabled={disabled}
            className="field text-sm"
          />
        </FormField>
        {!isEdit && (
          <FormField
            label="SKU"
            htmlFor="p-sku"
            error={fe.sku}
            hint="For the product's first variant. Leave blank to auto-generate."
          >
            <input id="p-sku" name="sku" disabled={disabled} className="field font-mono text-sm" />
          </FormField>
        )}
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-ink">Pricing</h2>
        <p className="text-xs text-ink-faint">
          Amounts in pesos. {isEdit && product!.variantCount > 1
            ? "This product has multiple variants — set per-variant prices in the Variants tab. This price is the display default."
            : "This is also the price of the product's single variant."}
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Price" htmlFor="p-price" required error={fe.price}>
            <input
              id="p-price"
              name="price"
              inputMode="decimal"
              defaultValue={pesos(product?.price)}
              required
              disabled={disabled}
              className="field text-sm"
              placeholder="0.00"
            />
          </FormField>
          <FormField
            label="Compare-at price"
            htmlFor="p-compare"
            error={fe.compareAtPrice}
            hint="Original price, shown struck through. Must be higher than the price."
          >
            <input
              id="p-compare"
              name="compareAtPrice"
              inputMode="decimal"
              defaultValue={pesos(product?.compareAtPrice)}
              disabled={disabled}
              className="field text-sm"
              placeholder="—"
            />
          </FormField>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-ink">Organization</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Category" htmlFor="p-cat" required error={fe.categoryId}>
            <Select
              id="p-cat"
              name="categoryId"
              defaultValue={product?.categoryId ?? ""}
              required
              disabled={disabled}
            >
              <option value="" disabled>
                Choose…
              </option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Status" htmlFor="p-status" required error={fe.status}>
            <Select
              id="p-status"
              name="status"
              defaultValue={product?.status ?? "DRAFT"}
              disabled={disabled}
            >
              {PRODUCT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </FormField>
        </div>
        <div className="flex flex-wrap gap-6">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="featured"
              defaultChecked={product?.featured ?? false}
              disabled={disabled}
            />
            Featured
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="freeShipping"
              defaultChecked={product?.freeShipping ?? false}
              disabled={disabled}
            />
            Free shipping
          </label>
        </div>
        <input type="hidden" name="weightGrams" value={product?.weightGrams ?? 500} />
      </section>

      {isEdit && (() => {
        const specs = safeJson<Record<string, string>>(product!.specs, {});
        const highlights = safeJson<string[]>(product!.highlights, []);
        const care = product!.care ?? "";
        const specEntries = Object.entries(specs);
        return (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-ink">Specifications &amp; details</h2>
            <p className="text-xs text-ink-faint">
              Informational content shown on the product page. These are{" "}
              <strong className="font-medium text-ink">not purchasable options</strong> — they
              never create variants and never affect price, SKU or stock. Managed outside this
              screen.
            </p>
            {specEntries.length === 0 && highlights.length === 0 && !care ? (
              <p className="rounded-sm border border-dashed border-line px-3 py-2 text-xs text-ink-faint">
                No specifications set.
              </p>
            ) : (
              <div className="space-y-3 rounded-md border border-line bg-surface-sunken/40 p-3 text-sm">
                {specEntries.length > 0 && (
                  <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                    {specEntries.map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-4 border-b border-line/60 py-1">
                        <dt className="text-ink-faint">{k}</dt>
                        <dd className="text-right font-medium text-ink">{v}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {highlights.length > 0 && (
                  <div>
                    <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-faint">
                      Highlights
                    </p>
                    <ul className="list-disc space-y-0.5 pl-4 text-ink-soft">
                      {highlights.map((h) => (
                        <li key={h}>{h}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {care && (
                  <div>
                    <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-faint">
                      Care
                    </p>
                    <p className="text-ink-soft">{care}</p>
                  </div>
                )}
              </div>
            )}
          </section>
        );
      })()}

      {state.error && !state.fieldErrors && (
        <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>
      )}

      {canEdit && (
        <div className="flex items-center gap-3 border-t border-line pt-5">
          <button type="submit" disabled={pending} className="btn btn-primary py-2 text-sm">
            {pending && <Loader2 size={14} className="animate-spin" />}
            {isEdit ? "Save changes" : "Create product"}
          </button>
          {!isEdit && (
            <span className="text-xs text-ink-faint">
              You&apos;ll be able to add images and variants after creating.
            </span>
          )}
        </div>
      )}
    </form>
  );
}
