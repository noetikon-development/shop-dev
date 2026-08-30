"use client";

import { useMemo, useRef, useState } from "react";
import { AlertTriangle, ImageIcon, Loader2, Upload, X } from "lucide-react";
import { Modal, notify } from "@/components/admin/ui";
import { uploadMediaAction } from "@/lib/admin/content-actions";
import {
  ALLOWED_IMAGE_ACCEPT,
  imageSpecWarnings,
  HERO_IMAGE_SPEC,
  type ImageSpec,
} from "@/lib/media-constants";
import type { PickerAsset } from "@/lib/admin/media-picker-data";

/**
 * A field that stores a MediaAsset id and shows a thumbnail. Opens a modal to
 * pick from recent uploads or upload a new image inline. `name` is submitted in
 * the surrounding form as a hidden input.
 *
 * `showSpecHints` adds a dimensions / file-size / type readout for the selected
 * image plus advisory warnings against `spec` (defaults to the hero standard).
 * Warnings never block a valid upload.
 */
export function MediaPickerField({
  name,
  label,
  assets,
  defaultValue = "",
  error,
  hint,
  uploadFolder = "content",
  showSpecHints = false,
  spec = HERO_IMAGE_SPEC,
  onValueChange,
}: {
  name: string;
  label: string;
  assets: PickerAsset[];
  defaultValue?: string;
  error?: string;
  hint?: string;
  uploadFolder?: string;
  showSpecHints?: boolean;
  spec?: ImageSpec;
  /** Called whenever the selected MediaAsset id changes ("" = cleared). */
  onValueChange?: (id: string) => void;
}) {
  const [value, setValueState] = useState(defaultValue);
  const setValue = (v: string) => {
    setValueState(v);
    onValueChange?.(v);
  };
  const [list, setList] = useState<PickerAsset[]>(assets);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(() => list.find((a) => a.id === value) ?? null, [list, value]);
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return term ? list.filter((a) => `${a.filename} ${a.folder} ${a.alt ?? ""}`.toLowerCase().includes(term)) : list;
  }, [list, q]);

  async function handleUpload() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setUploading(true);
    const fd = new FormData();
    fd.set("file", file);
    fd.set("folder", uploadFolder);
    const res = await uploadMediaAction({}, fd);
    setUploading(false);
    if (res.ok && res.asset) {
      notify.success(res.message ?? "Uploaded");
      setList((cur) => [res.asset!, ...cur]);
      setValue(res.asset.id);
      setOpen(false);
      if (fileRef.current) fileRef.current.value = "";
    } else if (res.error) {
      notify.error(res.error);
    }
  }

  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-ink">{label}</label>
      <input type="hidden" name={name} value={value} />
      <div className="flex items-start gap-3">
        <div className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-md border border-line bg-surface-sunken">
          {selected ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={selected.url} alt={selected.alt ?? selected.filename} className="h-full w-full object-contain" />
          ) : (
            <ImageIcon size={18} className="text-ink-faint" />
          )}
        </div>
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setOpen(true)} className="btn btn-outline py-1.5 text-xs">
              {selected ? "Change image" : "Choose image"}
            </button>
            {value && (
              <button
                type="button"
                onClick={() => setValue("")}
                className="btn btn-ghost py-1.5 text-xs text-ink-faint"
              >
                <X size={12} /> Clear
              </button>
            )}
          </div>
          {showSpecHints && selected && <SpecReadout asset={selected} spec={spec} />}
        </div>
      </div>
      {error ? <p className="text-xs text-clay">{error}</p> : hint && <p className="text-xs text-ink-faint">{hint}</p>}

      <Modal open={open} onClose={() => setOpen(false)} title={label} size="lg">
        <div className="space-y-3">
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter by name or folder…"
            className="field text-sm"
          />
          <div className="flex items-center gap-2 rounded-md border border-dashed border-line-strong p-2 text-xs">
            <input ref={fileRef} type="file" accept={ALLOWED_IMAGE_ACCEPT} className="text-xs" />
            <button
              type="button"
              onClick={handleUpload}
              disabled={uploading}
              className="btn btn-outline py-1 text-xs"
            >
              {uploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
              Upload
            </button>
          </div>
          {showSpecHints && (
            <p className="text-[11px] text-ink-faint">
              Recommended: {spec.recommendation}. Off-spec images still upload — you&apos;ll just
              see a note.
            </p>
          )}
          {filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-ink-faint">No images match.</p>
          ) : (
            <ul className="grid max-h-[50vh] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
              {filtered.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setValue(a.id);
                      setOpen(false);
                    }}
                    className={`block w-full overflow-hidden rounded-md border-2 ${
                      a.id === value ? "border-ink" : "border-transparent hover:border-line-strong"
                    }`}
                  >
                    <span className="grid aspect-square place-items-center bg-surface-sunken">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={a.url} alt={a.alt ?? a.filename} className="h-full w-full object-contain" loading="lazy" />
                    </span>
                    <span className="block truncate px-1 py-1 text-[10px] text-ink-faint">{a.filename}</span>
                    <span className="block truncate px-1 pb-1 text-[10px] text-ink-faint">{dimText(a)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Modal>
    </div>
  );
}

function humanKB(bytes: number | null | undefined) {
  if (typeof bytes !== "number") return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function typeLabel(mime: string | null | undefined) {
  if (!mime) return "";
  return mime.replace("image/", "").toUpperCase();
}

function dimText(a: PickerAsset) {
  const dims = typeof a.width === "number" && typeof a.height === "number" ? `${a.width}×${a.height}` : "size n/a";
  return `${dims} · ${humanKB(a.sizeBytes)} · ${typeLabel(a.mimeType)}`;
}

function SpecReadout({ asset, spec }: { asset: PickerAsset; spec: ImageSpec }) {
  const warnings = imageSpecWarnings(asset, spec);
  const recorded = typeof asset.width === "number" && typeof asset.height === "number";
  return (
    <div className="text-[11px] leading-tight">
      <p className="text-ink-faint">
        {recorded ? `${asset.width}×${asset.height}px` : "dimensions not recorded"} ·{" "}
        {humanKB(asset.sizeBytes)} · {typeLabel(asset.mimeType)}
      </p>
      {warnings.length > 0 && (
        <p className="mt-0.5 flex items-start gap-1 text-[#8a5a1f]">
          <AlertTriangle size={11} className="mt-px shrink-0" />
          <span>{warnings.join(" · ")}</span>
        </p>
      )}
    </div>
  );
}
