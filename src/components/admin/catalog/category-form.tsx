"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Upload, Trash2 } from "lucide-react";
import { slugify } from "@/lib/utils";
import { FormField, Select, notify, usePersistentAction } from "@/components/admin/ui";
import {
  createCategory,
  updateCategory,
  uploadCategoryImage,
  removeCategoryImage,
  type CatalogState,
} from "@/lib/admin/catalog-actions";

type ParentOption = { id: string; label: string };

type Existing = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  parentId: string | null;
  heroColor: string | null;
  sortOrder: number;
  featured: boolean;
  active: boolean;
  imageUrl: string | null;
};

export function CategoryForm({
  parents,
  category,
  canEdit,
}: {
  parents: ParentOption[];
  category?: Existing;
  canEdit: boolean;
}) {
  const router = useRouter();
  const isEdit = Boolean(category);
  const { state, onSubmit, pending } = usePersistentAction<CatalogState>(
    isEdit ? updateCategory : createCategory,
    {},
  );
  const [name, setName] = useState(category?.name ?? "");
  const [typedSlug, setTypedSlug] = useState(category?.slug ?? "");
  const [touched, setTouched] = useState(Boolean(category));
  const slug = touched ? typedSlug : slugify(name);

  useEffect(() => {
    if (state.ok) {
      notify.success(state.message ?? "Saved");
      router.refresh();
    }
    if (state.error) notify.error(state.error);
  }, [state, router]);

  const fe = state.fieldErrors ?? {};

  return (
    <div className="space-y-6">
      <form onSubmit={onSubmit} className="space-y-4 rounded-md border border-line bg-surface p-5">
        {category && <input type="hidden" name="id" value={category.id} />}

        <FormField label="Name" htmlFor="c-name" required error={fe.name}>
          <input
            id="c-name"
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            disabled={!canEdit}
            className="field text-sm"
          />
        </FormField>
        <FormField label="Slug" htmlFor="c-slug" required error={fe.slug} hint="URL: /c/<slug>">
          <input
            id="c-slug"
            name="slug"
            value={slug}
            onChange={(e) => {
              setTypedSlug(e.target.value);
              setTouched(true);
            }}
            disabled={!canEdit}
            className="field font-mono text-sm"
          />
        </FormField>
        <FormField label="Description" htmlFor="c-desc" error={fe.description}>
          <textarea
            id="c-desc"
            name="description"
            defaultValue={category?.description ?? ""}
            rows={3}
            disabled={!canEdit}
            className="field text-sm"
          />
        </FormField>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Parent category" htmlFor="c-parent" error={fe.parentId}>
            <Select
              id="c-parent"
              name="parentId"
              defaultValue={category?.parentId ?? ""}
              disabled={!canEdit}
            >
              <option value="">None (top level)</option>
              {parents.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField
            label="Hero colour"
            htmlFor="c-hero"
            error={fe.heroColor}
            hint="Hex like #e7ece6 — the tile background"
          >
            <input
              id="c-hero"
              name="heroColor"
              defaultValue={category?.heroColor ?? ""}
              placeholder="#e7ece6"
              disabled={!canEdit}
              className="field font-mono text-sm"
            />
          </FormField>
        </div>

        <div className="grid gap-4 sm:grid-cols-[120px_1fr] sm:items-center">
          <FormField label="Sort order" htmlFor="c-sort" error={fe.sortOrder}>
            <input
              id="c-sort"
              name="sortOrder"
              type="number"
              min={0}
              defaultValue={category?.sortOrder ?? 0}
              disabled={!canEdit}
              className="field text-sm"
            />
          </FormField>
          <div className="flex flex-wrap gap-6 pt-5">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="active"
                defaultChecked={category?.active ?? true}
                disabled={!canEdit}
              />
              Active (visible on the storefront)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="featured"
                defaultChecked={category?.featured ?? false}
                disabled={!canEdit}
              />
              Featured
            </label>
          </div>
        </div>

        {state.error && !state.fieldErrors && (
          <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>
        )}

        {canEdit && (
          <div className="border-t border-line pt-4">
            <button type="submit" disabled={pending} className="btn btn-primary py-2 text-sm">
              {pending && <Loader2 size={14} className="animate-spin" />}
              {isEdit ? "Save changes" : "Create category"}
            </button>
          </div>
        )}
      </form>

      {isEdit && canEdit && (
        <CategoryImage categoryId={category!.id} imageUrl={category!.imageUrl} />
      )}
    </div>
  );
}

function CategoryImage({
  categoryId,
  imageUrl,
}: {
  categoryId: string;
  imageUrl: string | null;
}) {
  const [upState, upAction, uploading] = useActionState<CatalogState, FormData>(
    uploadCategoryImage,
    {},
  );
  const [rmState, rmAction, removing] = useActionState<CatalogState, FormData>(
    removeCategoryImage,
    {},
  );

  useEffect(() => {
    if (upState.ok) notify.success(upState.message ?? "Image updated");
    if (upState.error) notify.error(upState.error);
  }, [upState]);
  useEffect(() => {
    if (rmState.ok) notify.success("Image removed");
    if (rmState.error) notify.error(rmState.error);
  }, [rmState]);

  return (
    <div className="rounded-md border border-line bg-surface p-5">
      <h3 className="text-sm font-semibold text-ink">Category image</h3>
      <p className="text-xs text-ink-faint">Optional. Stored in Supabase Storage.</p>
      <div className="mt-3 flex items-center gap-4">
        {imageUrl ? (
          <div className="h-16 w-24 shrink-0 overflow-hidden rounded-sm bg-surface-sunken">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={imageUrl} alt="Category" className="h-full w-full object-cover" />
          </div>
        ) : (
          <div className="grid h-16 w-24 shrink-0 place-items-center rounded-sm border border-dashed border-line-strong text-xs text-ink-faint">
            None
          </div>
        )}
        <form action={upAction} className="flex items-end gap-2">
          <input type="hidden" name="id" value={categoryId} />
          <input
            name="file"
            type="file"
            required
            accept="image/png,image/jpeg,image/webp"
            className="field text-sm file:mr-3 file:rounded-sm file:border-0 file:bg-ink file:px-3 file:py-1.5 file:text-xs file:text-paper"
          />
          <button type="submit" disabled={uploading} className="btn btn-primary py-2 text-sm">
            {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            {imageUrl ? "Replace" : "Upload"}
          </button>
        </form>
        {imageUrl && (
          <form action={rmAction}>
            <input type="hidden" name="id" value={categoryId} />
            <button type="submit" disabled={removing} className="btn btn-ghost py-2 text-sm text-ink-faint hover:text-clay">
              <Trash2 size={14} /> Remove
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
