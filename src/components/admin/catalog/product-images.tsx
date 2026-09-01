"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, ArrowDown, Star, Trash2, Loader2, Upload } from "lucide-react";
import { ProductImage } from "@/components/product-image";
import { FormField, ConfirmDialog, StatusBadge, notify } from "@/components/admin/ui";
import {
  uploadProductImage,
  deleteProductImage,
  reorderProductImages,
  setImageColour,
  type CatalogState,
} from "@/lib/admin/catalog-actions";

type Img = {
  id: string;
  url: string;
  alt: string;
  optionValueId: string | null;
  isUpload: boolean;
  sizeLabel?: string;
};

type Colour = { id: string; value: string; swatchHex: string | null };

/** The product-level bucket uses this sentinel as its key / form value. */
const PRODUCT_KEY = "__product";

export function ProductImages({
  productId,
  images,
  colours,
  canManage,
}: {
  productId: string;
  images: Img[];
  colours: Colour[];
  canManage: boolean;
}) {
  const router = useRouter();
  const hasColours = colours.length > 0;

  // Groups in display order: product-level first, then each colour.
  const groups = useMemo(
    () => [
      { key: PRODUCT_KEY, label: "Product-level (all colours)", swatchHex: null as string | null },
      ...colours.map((c) => ({ key: c.id, label: c.value, swatchHex: c.swatchHex })),
    ],
    [colours],
  );
  const groupKeyFor = (img: Img) => img.optionValueId ?? PRODUCT_KEY;

  // Server truth, grouped.
  const serverGroups = useMemo(() => {
    const map: Record<string, Img[]> = {};
    for (const g of groups) map[g.key] = [];
    for (const img of images) (map[groupKeyFor(img)] ??= []).push(img);
    return map;
  }, [images, groups]);

  // Local (possibly re-ordered) copy.
  const [order, setOrder] = useState<Record<string, Img[]>>(serverGroups);
  const serverSig = images.map((i) => `${i.id}:${groupKeyFor(i)}`).join(",");
  const [prevSig, setPrevSig] = useState(serverSig);
  if (prevSig !== serverSig) {
    setPrevSig(serverSig);
    setOrder(serverGroups);
  }

  const [pendingDelete, setPendingDelete] = useState<Img | null>(null);

  const [uploadState, uploadAction, uploading] = useActionState<CatalogState, FormData>(uploadProductImage, {});
  const [reorderState, reorderAction, reordering] = useActionState<CatalogState, FormData>(reorderProductImages, {});
  const [deleteState, deleteAction, deleting] = useActionState<CatalogState, FormData>(deleteProductImage, {});
  const [colourState, colourAction, recolouring] = useActionState<CatalogState, FormData>(setImageColour, {});
  const uploadRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (uploadState.ok) {
      notify.success(uploadState.message ?? "Uploaded");
      uploadRef.current?.reset();
      router.refresh();
    }
    if (uploadState.error) notify.error(uploadState.error);
  }, [uploadState, router]);
  useEffect(() => {
    if (reorderState.ok) {
      notify.success("Order saved");
      router.refresh();
    }
    if (reorderState.error) notify.error(reorderState.error);
  }, [reorderState, router]);
  useEffect(() => {
    if (deleteState.ok) {
      notify.success("Image removed");
      router.refresh();
    }
    if (deleteState.error) notify.error(deleteState.error);
  }, [deleteState, router]);
  useEffect(() => {
    if (colourState.ok) {
      notify.success("Image reassigned");
      router.refresh();
    }
    if (colourState.error) notify.error(colourState.error);
  }, [colourState, router]);

  const move = (groupKey: string, index: number, dir: -1 | 1) => {
    setOrder((prev) => {
      const list = [...(prev[groupKey] ?? [])];
      const target = index + dir;
      if (target < 0 || target >= list.length) return prev;
      [list[index], list[target]] = [list[target], list[index]];
      return { ...prev, [groupKey]: list };
    });
  };
  const makePrimary = (groupKey: string, index: number) => {
    if (index === 0) return;
    setOrder((prev) => {
      const list = [...(prev[groupKey] ?? [])];
      const [item] = list.splice(index, 1);
      list.unshift(item);
      return { ...prev, [groupKey]: list };
    });
  };
  const groupDirty = (groupKey: string) =>
    (order[groupKey] ?? []).map((i) => i.id).join(",") !==
    (serverGroups[groupKey] ?? []).map((i) => i.id).join(",");

  const totalImages = images.length;

  return (
    <div className="space-y-8">
      {canManage && (
        <form ref={uploadRef} action={uploadAction} className="rounded-md border border-line bg-surface p-4">
          <input type="hidden" name="productId" value={productId} />
          {!hasColours && <input type="hidden" name="optionValueId" value="" />}
          <div className={`grid gap-4 ${hasColours ? "sm:grid-cols-[1fr_180px_1fr_auto]" : "sm:grid-cols-[1fr_1fr_auto]"} sm:items-end`}>
            <FormField label="Add image" htmlFor="pi-file" hint="PNG / JPG / WEBP · up to 8 MB">
              <input
                id="pi-file"
                name="file"
                type="file"
                required
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="field text-sm file:mr-3 file:rounded-sm file:border-0 file:bg-ink file:px-3 file:py-1.5 file:text-xs file:text-paper"
              />
            </FormField>
            {hasColours && (
              <FormField
                label="Colour"
                htmlFor="pi-colour"
                hint="Which colour is this image for?"
              >
                <select id="pi-colour" name="optionValueId" defaultValue="" className="field text-sm">
                  <option value="">Product-level (all colours)</option>
                  {colours.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.value}
                    </option>
                  ))}
                </select>
              </FormField>
            )}
            <FormField label="Alt text" htmlFor="pi-alt" hint="Optional; defaults to the product name">
              <input id="pi-alt" name="alt" className="field text-sm" />
            </FormField>
            <button type="submit" disabled={uploading} className="btn btn-primary py-2 text-sm">
              {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
              Upload
            </button>
          </div>
        </form>
      )}

      {totalImages === 0 && !canManage ? (
        <div className="rounded-md border border-dashed border-line-strong bg-surface px-6 py-12 text-center text-sm text-ink-soft">
          No images yet.
        </div>
      ) : (
        groups.map((g) => {
          const list = order[g.key] ?? [];
          // Hide an empty product-level bucket for viewers; keep colour buckets
          // visible for managers so they know the group exists.
          if (list.length === 0 && (!canManage || (g.key === PRODUCT_KEY && !hasColours))) return null;
          if (list.length === 0 && g.key === PRODUCT_KEY && !canManage) return null;

          return (
            <section key={g.key} className="space-y-2">
              <div className="flex items-center gap-2">
                {g.swatchHex && (
                  <span
                    className="inline-block h-3.5 w-3.5 rounded-full border border-black/10"
                    style={{ backgroundColor: g.swatchHex }}
                    aria-hidden
                  />
                )}
                <h3 className="text-sm font-medium text-ink">{g.label}</h3>
                <span className="text-xs text-ink-faint">
                  {list.length === 0 ? "no images" : `${list.length} image${list.length === 1 ? "" : "s"}`}
                </span>
              </div>

              {list.length === 0 ? (
                <p className="rounded-md border border-dashed border-line px-4 py-6 text-center text-xs text-ink-faint">
                  {g.key === PRODUCT_KEY
                    ? "Images here show for every colour that has no images of its own."
                    : "No images for this colour yet — customers will see the product-level images (or the illustration) until you add one."}
                </p>
              ) : (
                <ul className="space-y-2">
                  {list.map((img, index) => (
                    <li
                      key={img.id}
                      className="flex items-center gap-3 rounded-md border border-line bg-surface p-2.5"
                    >
                      <div className="h-14 w-14 shrink-0 overflow-hidden rounded-sm bg-surface-sunken">
                        <ProductImage src={img.url} alt={img.alt} allowArt sizes="56px" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-ink">{img.alt || "—"}</p>
                        <p className="text-xs text-ink-faint">
                          {index === 0 && <span className="mr-2 font-medium text-ink-soft">Primary</span>}
                          {img.isUpload ? (img.sizeLabel ?? "Uploaded") : "Illustration"}
                        </p>
                      </div>

                      {canManage && (
                        <div className="flex items-center gap-1">
                          {hasColours && (
                            <select
                              aria-label="Reassign colour"
                              className="field !w-auto !py-1 text-xs"
                              value={img.optionValueId ?? ""}
                              disabled={recolouring}
                              onChange={(e) => {
                                const fd = new FormData();
                                fd.set("imageId", img.id);
                                fd.set("optionValueId", e.target.value);
                                colourAction(fd);
                              }}
                            >
                              <option value="">Product-level</option>
                              {colours.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.value}
                                </option>
                              ))}
                            </select>
                          )}
                          <button
                            type="button"
                            onClick={() => makePrimary(g.key, index)}
                            disabled={index === 0}
                            aria-label="Make primary"
                            className="btn btn-ghost p-1.5 disabled:opacity-30"
                          >
                            <Star size={15} />
                          </button>
                          <button
                            type="button"
                            onClick={() => move(g.key, index, -1)}
                            disabled={index === 0}
                            aria-label="Move up"
                            className="btn btn-ghost p-1.5 disabled:opacity-30"
                          >
                            <ArrowUp size={15} />
                          </button>
                          <button
                            type="button"
                            onClick={() => move(g.key, index, 1)}
                            disabled={index === list.length - 1}
                            aria-label="Move down"
                            className="btn btn-ghost p-1.5 disabled:opacity-30"
                          >
                            <ArrowDown size={15} />
                          </button>
                          <button
                            type="button"
                            onClick={() => setPendingDelete(img)}
                            aria-label="Delete image"
                            className="btn btn-ghost p-1.5 text-ink-faint hover:text-clay"
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {canManage && groupDirty(g.key) && (
                <form action={reorderAction} className="flex items-center gap-3">
                  <input type="hidden" name="productId" value={productId} />
                  <input type="hidden" name="optionValueId" value={g.key === PRODUCT_KEY ? "" : g.key} />
                  {list.map((i) => (
                    <input key={i.id} type="hidden" name="imageIds" value={i.id} />
                  ))}
                  <button type="submit" disabled={reordering} className="btn btn-primary py-2 text-sm">
                    {reordering && <Loader2 size={14} className="animate-spin" />}
                    Save order
                  </button>
                  <button
                    type="button"
                    onClick={() => setOrder((prev) => ({ ...prev, [g.key]: serverGroups[g.key] ?? [] }))}
                    className="btn btn-outline py-2 text-sm"
                  >
                    Reset
                  </button>
                  <StatusBadge tone="warning">Unsaved order</StatusBadge>
                </form>
              )}
            </section>
          );
        })
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (!pendingDelete) return;
          const fd = new FormData();
          fd.set("imageId", pendingDelete.id);
          deleteAction(fd);
          setPendingDelete(null);
        }}
        title="Delete this image?"
        message="It will be removed from the product and from storage."
        confirmLabel="Delete"
        pending={deleting}
      />
    </div>
  );
}
