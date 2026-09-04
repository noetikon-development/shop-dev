"use client";

import { useActionState, useEffect, useRef } from "react";
import Image from "next/image";
import { Loader2, Upload, Trash2 } from "lucide-react";
import { ALLOWED_IMAGE_ACCEPT } from "@/lib/media-constants";
import {
  uploadRequestImageAction,
  detachRequestImageAction,
  type SellerRequestActionState,
} from "@/lib/seller/product-request-actions";
import { FormField, notify, usePersistentAction } from "@/components/seller/ui";

type Img = { id: string; url: string; filename: string; role: string; sortOrder: number };

export function RequestImagesPanel({
  requestId,
  editable,
  images,
}: {
  requestId: string;
  editable: boolean;
  images: Img[];
}) {
  const [uploadState, uploadAction, uploading] = useActionState<SellerRequestActionState, FormData>(
    uploadRequestImageAction,
    {},
  );
  const formRef = useRef<HTMLFormElement>(null);
  const detach = usePersistentAction<SellerRequestActionState>(detachRequestImageAction, {});

  useEffect(() => {
    if (uploadState.ok) {
      notify.success(uploadState.message ?? "Image added");
      formRef.current?.reset();
    }
    if (uploadState.error) notify.error(uploadState.error);
  }, [uploadState]);
  useEffect(() => {
    if (detach.state.ok && detach.state.message) notify.success(detach.state.message);
    if (detach.state.error) notify.error(detach.state.error);
  }, [detach.state]);

  return (
    <div className="space-y-4">
      {images.length === 0 ? (
        <p className="text-sm text-ink-faint">No reference images yet.</p>
      ) : (
        <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4">
          {images.map((img) => (
            <li key={img.id} className="overflow-hidden rounded-sm border border-line bg-surface">
              <div className="relative aspect-square bg-surface-sunken">
                <Image src={img.url} alt={img.filename} fill sizes="160px" className="object-contain" />
              </div>
              {editable && (
                <form onSubmit={detach.onSubmit} className="p-1">
                  <input type="hidden" name="requestId" value={requestId} />
                  <input type="hidden" name="imageId" value={img.id} />
                  <button
                    type="submit"
                    className="flex w-full items-center justify-center gap-1 rounded-sm px-1 py-0.5 text-[11px] text-ink-soft hover:bg-surface-sunken"
                  >
                    <Trash2 size={11} /> Remove
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}

      {editable && (
        <form ref={formRef} action={uploadAction} className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <input type="hidden" name="requestId" value={requestId} />
          <FormField label="Add a reference image" htmlFor="req-img-file" hint="PNG, JPG, WEBP or GIF · up to 8 MB. Stays in your media library.">
            <input
              id="req-img-file"
              name="file"
              type="file"
              required
              accept={ALLOWED_IMAGE_ACCEPT}
              className="field text-sm file:mr-3 file:rounded-sm file:border-0 file:bg-ink file:px-3 file:py-1.5 file:text-xs file:text-paper"
            />
          </FormField>
          <button type="submit" disabled={uploading} className="btn btn-primary py-2 text-sm">
            {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            Upload
          </button>
        </form>
      )}
      {!editable && images.length === 0 && (
        <p className="text-xs text-ink-faint">This request is locked — images can&rsquo;t be changed.</p>
      )}
    </div>
  );
}
