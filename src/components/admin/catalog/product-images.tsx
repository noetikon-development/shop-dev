"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, ArrowDown, Star, Trash2, Loader2, Upload } from "lucide-react";
import { ProductImage } from "@/components/product-image";
import { FormField, ConfirmDialog, StatusBadge, notify } from "@/components/admin/ui";
import {
  uploadProductImage,
  deleteProductImage,
  reorderProductImages,
  type CatalogState,
} from "@/lib/admin/catalog-actions";

type Img = {
  id: string;
  url: string;
  alt: string;
  isUpload: boolean;
  sizeLabel?: string;
};

export function ProductImages({
  productId,
  images,
  canManage,
}: {
  productId: string;
  images: Img[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [order, setOrder] = useState(images);
  const [pendingDelete, setPendingDelete] = useState<Img | null>(null);

  const [uploadState, uploadAction, uploading] = useActionState<CatalogState, FormData>(
    uploadProductImage,
    {},
  );
  const [reorderState, reorderAction, reordering] = useActionState<CatalogState, FormData>(
    reorderProductImages,
    {},
  );
  const [deleteState, deleteAction, deleting] = useActionState<CatalogState, FormData>(
    deleteProductImage,
    {},
  );
  const uploadRef = useRef<HTMLFormElement>(null);

  // Keep local order in step with server data after any mutation (the
  // "adjust state when a prop changes" pattern — during render, not an effect).
  const serverKey = images.map((i) => i.id).join(",");
  const [prevKey, setPrevKey] = useState(serverKey);
  if (prevKey !== serverKey) {
    setPrevKey(serverKey);
    setOrder(images);
  }

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

  const move = (index: number, dir: -1 | 1) => {
    const next = [...order];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setOrder(next);
  };
  const makePrimary = (index: number) => {
    if (index === 0) return;
    const next = [...order];
    const [item] = next.splice(index, 1);
    next.unshift(item);
    setOrder(next);
  };

  const dirty = order.map((i) => i.id).join(",") !== images.map((i) => i.id).join(",");

  return (
    <div className="space-y-6">
      {canManage && (
        <form ref={uploadRef} action={uploadAction} className="rounded-md border border-line bg-surface p-4">
          <input type="hidden" name="productId" value={productId} />
          <div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
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

      {order.length === 0 ? (
        <div className="rounded-md border border-dashed border-line-strong bg-surface px-6 py-12 text-center text-sm text-ink-soft">
          No images yet. {canManage && "Upload the first one above."}
        </div>
      ) : (
        <ul className="space-y-2">
          {order.map((img, index) => (
            <li
              key={img.id}
              className="flex items-center gap-3 rounded-md border border-line bg-surface p-2.5"
            >
              <div className="h-14 w-14 shrink-0 overflow-hidden rounded-sm bg-surface-sunken">
                <ProductImage src={img.url} alt={img.alt} seedOverride={`${img.id}-admin`} />
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
                  <button
                    type="button"
                    onClick={() => makePrimary(index)}
                    disabled={index === 0}
                    aria-label="Make primary"
                    className="btn btn-ghost p-1.5 disabled:opacity-30"
                  >
                    <Star size={15} />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(index, -1)}
                    disabled={index === 0}
                    aria-label="Move up"
                    className="btn btn-ghost p-1.5 disabled:opacity-30"
                  >
                    <ArrowUp size={15} />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(index, 1)}
                    disabled={index === order.length - 1}
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

      {canManage && dirty && (
        <form action={reorderAction} className="flex items-center gap-3">
          <input type="hidden" name="productId" value={productId} />
          {order.map((i) => (
            <input key={i.id} type="hidden" name="imageIds" value={i.id} />
          ))}
          <button type="submit" disabled={reordering} className="btn btn-primary py-2 text-sm">
            {reordering && <Loader2 size={14} className="animate-spin" />}
            Save order
          </button>
          <button
            type="button"
            onClick={() => setOrder(images)}
            className="btn btn-outline py-2 text-sm"
          >
            Reset
          </button>
          <StatusBadge tone="warning">Unsaved order</StatusBadge>
        </form>
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
