"use client";

import { useMemo, useRef, useState } from "react";
import { ImageIcon, Loader2, Upload, X } from "lucide-react";
import { Modal, notify } from "@/components/admin/ui";
import { uploadMediaAction } from "@/lib/admin/content-actions";
import { ALLOWED_IMAGE_ACCEPT } from "@/lib/media-constants";
import type { PickerAsset } from "@/lib/admin/media-picker-data";

/**
 * A field that stores a MediaAsset id and shows a thumbnail. Opens a modal to
 * pick from recent uploads or upload a new image inline. `name` is submitted in
 * the surrounding form as a hidden input.
 */
export function MediaPickerField({
  name,
  label,
  assets,
  defaultValue = "",
  error,
  hint,
}: {
  name: string;
  label: string;
  assets: PickerAsset[];
  defaultValue?: string;
  error?: string;
  hint?: string;
}) {
  const [value, setValue] = useState(defaultValue);
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
    fd.set("folder", "content");
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
      <div className="flex items-center gap-3">
        <div className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-md border border-line bg-surface-sunken">
          {selected ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={selected.url} alt={selected.alt ?? selected.filename} className="h-full w-full object-contain" />
          ) : (
            <ImageIcon size={18} className="text-ink-faint" />
          )}
        </div>
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
