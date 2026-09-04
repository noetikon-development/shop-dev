"use client";

import { useActionState, useEffect, useRef } from "react";
import Image from "next/image";
import { Loader2, Upload, Trash2 } from "lucide-react";
import { ALLOWED_IMAGE_ACCEPT } from "@/lib/media-constants";
import {
  uploadSellerMediaAction,
  setSellerImageAction,
  deleteSellerMediaAction,
  type SellerSettingsActionState,
} from "@/lib/seller/settings-actions";
import { FormField, notify, usePersistentAction } from "@/components/seller/ui";

type MediaItem = {
  id: string;
  url: string;
  filename: string;
  mimeType: string;
  width: number | null;
  height: number | null;
};

export function SellerMediaManager({
  logoUrl,
  bannerUrl,
  logoMediaId,
  bannerMediaId,
  media,
  count,
  cap,
}: {
  logoUrl: string | null;
  bannerUrl: string | null;
  logoMediaId: string | null;
  bannerMediaId: string | null;
  media: MediaItem[];
  count: number;
  cap: number;
}) {
  const [uploadState, uploadAction, uploading] = useActionState<SellerSettingsActionState, FormData>(
    uploadSellerMediaAction,
    {},
  );
  const formRef = useRef<HTMLFormElement>(null);
  const setImage = usePersistentAction<SellerSettingsActionState>(setSellerImageAction, {});
  const del = usePersistentAction<SellerSettingsActionState>(deleteSellerMediaAction, {});

  useEffect(() => {
    if (uploadState.ok) {
      notify.success(uploadState.message ?? "Uploaded");
      formRef.current?.reset();
    }
    if (uploadState.error) notify.error(uploadState.error);
  }, [uploadState]);
  useEffect(() => {
    if (setImage.state.ok && setImage.state.message) notify.success(setImage.state.message);
    if (setImage.state.error) notify.error(setImage.state.error);
  }, [setImage.state]);
  useEffect(() => {
    if (del.state.ok && del.state.message) notify.success(del.state.message);
    if (del.state.error) notify.error(del.state.error);
  }, [del.state]);

  const atCap = count >= cap;

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Slot label="Logo" url={logoUrl} slot="logo" hasValue={Boolean(logoMediaId)} onSubmit={setImage.onSubmit} />
        <Slot label="Banner" url={bannerUrl} slot="banner" hasValue={Boolean(bannerMediaId)} onSubmit={setImage.onSubmit} />
      </div>

      <form ref={formRef} action={uploadAction} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <FormField label="Add image" htmlFor="seller-media-file" hint="PNG, JPG, WEBP or GIF · up to 8 MB. Verified on the server.">
          <input
            id="seller-media-file"
            name="file"
            type="file"
            required
            disabled={atCap}
            accept={ALLOWED_IMAGE_ACCEPT}
            className="field text-sm file:mr-3 file:rounded-sm file:border-0 file:bg-ink file:px-3 file:py-1.5 file:text-xs file:text-paper"
          />
        </FormField>
        <FormField label="Description" htmlFor="seller-media-alt" hint="Alt text">
          <input id="seller-media-alt" name="alt" type="text" className="field text-sm" />
        </FormField>
        <button type="submit" disabled={uploading || atCap} className="btn btn-primary py-2 text-sm">
          {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
          Upload
        </button>
      </form>
      <p className="text-xs text-ink-faint">
        {count} / {cap} files{atCap && " — delete one to add more"}
      </p>

      {media.length > 0 && (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {media.map((m) => (
            <li key={m.id} className="overflow-hidden rounded-sm border border-line bg-surface">
              <div className="relative aspect-square bg-surface-sunken">
                {m.mimeType.startsWith("image/") && (
                  <Image src={m.url} alt={m.filename} fill sizes="200px" className="object-contain" />
                )}
              </div>
              <div className="space-y-1.5 p-2">
                <p className="truncate text-xs text-ink-soft" title={m.filename}>
                  {m.filename}
                </p>
                <div className="flex flex-wrap gap-1">
                  <SetButton slot="logo" mediaId={m.id} onSubmit={setImage.onSubmit} label="Logo" />
                  <SetButton slot="banner" mediaId={m.id} onSubmit={setImage.onSubmit} label="Banner" />
                  <form onSubmit={del.onSubmit} className="inline">
                    <input type="hidden" name="id" value={m.id} />
                    <button
                      type="submit"
                      className="inline-flex items-center gap-1 rounded-sm border border-line px-1.5 py-0.5 text-[11px] text-ink-soft hover:bg-surface-sunken"
                    >
                      <Trash2 size={11} /> Delete
                    </button>
                  </form>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Slot({
  label,
  url,
  slot,
  hasValue,
  onSubmit,
}: {
  label: string;
  url: string | null;
  slot: "logo" | "banner";
  hasValue: boolean;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <div className="rounded-sm border border-line p-3">
      <p className="mb-2 text-xs font-medium text-ink">{label}</p>
      <div className="relative mb-2 h-24 overflow-hidden rounded-sm bg-surface-sunken">
        {url ? (
          <Image src={url} alt={`${label} preview`} fill sizes="240px" className="object-contain" />
        ) : (
          <div className="grid h-full place-items-center text-[11px] text-ink-faint">Not set</div>
        )}
      </div>
      {hasValue && (
        <form onSubmit={onSubmit} className="inline">
          <input type="hidden" name="slot" value={slot} />
          <input type="hidden" name="mediaId" value="" />
          <button type="submit" className="text-[11px] text-ink-soft underline hover:text-ink">
            Clear {label.toLowerCase()}
          </button>
        </form>
      )}
    </div>
  );
}

function SetButton({
  slot,
  mediaId,
  onSubmit,
  label,
}: {
  slot: "logo" | "banner";
  mediaId: string;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  label: string;
}) {
  return (
    <form onSubmit={onSubmit} className="inline">
      <input type="hidden" name="slot" value={slot} />
      <input type="hidden" name="mediaId" value={mediaId} />
      <button
        type="submit"
        className="rounded-sm border border-line px-1.5 py-0.5 text-[11px] text-ink-soft hover:bg-surface-sunken"
      >
        {label}
      </button>
    </form>
  );
}
