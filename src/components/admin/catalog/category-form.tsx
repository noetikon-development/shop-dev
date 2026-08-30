"use client";

import { startTransition, useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { slugify } from "@/lib/utils";
import { FormField, Select, notify, usePersistentAction } from "@/components/admin/ui";
import { MediaPickerField } from "@/components/admin/media/media-picker";
import { CATEGORY_IMAGE_SPEC } from "@/lib/media-constants";
import {
  createCategory,
  updateCategory,
  setCategoryImage,
  type CatalogState,
} from "@/lib/admin/catalog-actions";
import type { PickerAsset } from "@/lib/admin/media-picker-data";

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
  imageMediaId: string | null;
};

export function CategoryForm({
  parents,
  category,
  canEdit,
  mediaAssets = [],
}: {
  parents: ParentOption[];
  category?: Existing;
  canEdit: boolean;
  mediaAssets?: PickerAsset[];
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
        <CategoryImage
          categoryId={category!.id}
          imageMediaId={category!.imageMediaId}
          mediaAssets={mediaAssets}
        />
      )}
    </div>
  );
}

function CategoryImage({
  categoryId,
  imageMediaId,
  mediaAssets,
}: {
  categoryId: string;
  imageMediaId: string | null;
  mediaAssets: PickerAsset[];
}) {
  const router = useRouter();
  const [state, dispatch, pending] = useActionState<CatalogState, FormData>(setCategoryImage, {});
  const [value, setValue] = useState(imageMediaId ?? "");

  useEffect(() => {
    if (state.ok) {
      notify.success(state.message ?? "Category image updated");
      router.refresh();
    }
    if (state.error) notify.error(state.error);
  }, [state, router]);

  function save() {
    const fd = new FormData();
    fd.set("id", categoryId);
    fd.set("mediaAssetId", value);
    startTransition(() => dispatch(fd));
  }

  return (
    <div className="space-y-3 rounded-md border border-line bg-surface p-5">
      <div>
        <h3 className="text-sm font-semibold text-ink">Category image</h3>
        <p className="text-xs text-ink-faint">
          One optional image, shown on the homepage &ldquo;shop by category&rdquo; tiles and category
          cards. An empty category keeps its built-in illustration. Stored in Supabase Storage;
          separate from product images.
        </p>
      </div>
      <MediaPickerField
        name="__categoryImage"
        label="Image"
        assets={mediaAssets}
        defaultValue={imageMediaId ?? ""}
        uploadFolder="categories"
        showSpecHints
        spec={CATEGORY_IMAGE_SPEC}
        onValueChange={setValue}
      />
      <button
        type="button"
        onClick={save}
        disabled={pending}
        className="btn btn-primary py-2 text-sm"
      >
        {pending && <Loader2 size={14} className="animate-spin" />}
        Save image
      </button>
    </div>
  );
}
