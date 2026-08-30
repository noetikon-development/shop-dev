"use client";

import { useActionState, useEffect, useRef } from "react";
import { Loader2, Upload } from "lucide-react";
import { FormField, notify } from "@/components/admin/ui";
import { uploadMediaAction, type MediaUploadState } from "@/lib/admin/content-actions";
import { ALLOWED_MEDIA_ACCEPT } from "@/lib/media-constants";

export function MediaUploader() {
  const [state, formAction, pending] = useActionState<MediaUploadState, FormData>(
    uploadMediaAction,
    {},
  );
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) {
      notify.success(state.message ?? "Uploaded");
      ref.current?.reset();
    }
    if (state.error) notify.error(state.error);
  }, [state]);

  return (
    <form ref={ref} action={formAction} className="grid gap-4 sm:grid-cols-[1fr_180px_1fr_auto] sm:items-end">
      <FormField label="File" htmlFor="media-file" hint="PNG, JPG, WEBP, GIF or PDF · up to 8 MB. File type is verified on the server.">
        <input
          id="media-file"
          name="file"
          type="file"
          required
          accept={ALLOWED_MEDIA_ACCEPT}
          className="field text-sm file:mr-3 file:rounded-sm file:border-0 file:bg-ink file:px-3 file:py-1.5 file:text-xs file:text-paper"
        />
      </FormField>
      <FormField label="Folder" htmlFor="media-folder" hint="Optional grouping">
        <input id="media-folder" name="folder" type="text" placeholder="banners" className="field text-sm" />
      </FormField>
      <FormField label="Description" htmlFor="media-alt" hint="Alt text for accessibility">
        <input id="media-alt" name="alt" type="text" placeholder="e.g. living room sofa" className="field text-sm" />
      </FormField>
      <button type="submit" disabled={pending} className="btn btn-primary">
        {pending ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
        Upload
      </button>
    </form>
  );
}
