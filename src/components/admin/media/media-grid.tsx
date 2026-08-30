"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { FileText, Trash2, ImageIcon, Pencil, Copy, Check } from "lucide-react";
import {
  EmptyState,
  ConfirmDialog,
  Modal,
  StatusBadge,
  notify,
} from "@/components/admin/ui";
import {
  deleteMediaAction,
  updateMediaAltAction,
  type MediaDeleteState,
} from "@/lib/admin/content-actions";

type Asset = {
  id: string;
  url: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  folder: string;
  alt: string | null;
  createdAt: string;
};

function humanSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function MediaGrid({ assets, canManage }: { assets: Asset[]; canManage: boolean }) {
  const [pendingDelete, setPendingDelete] = useState<Asset | null>(null);
  const [editing, setEditing] = useState<Asset | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [state, formAction, deleting] = useActionState<MediaDeleteState, FormData>(deleteMediaAction, {});

  useEffect(() => {
    if (state.ok) notify.success("File deleted");
    else if (state.error) notify.error(state.error);
  }, [state]);

  if (assets.length === 0) {
    return (
      <EmptyState
        icon={<ImageIcon size={18} />}
        title="No media here yet."
        description={
          canManage ? "Upload an image or file above to get started." : "Files uploaded by an editor will appear here."
        }
      />
    );
  }

  return (
    <>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {assets.map((a) => {
          const isImage = a.mimeType.startsWith("image/");
          return (
            <li key={a.id} className="group overflow-hidden rounded-md border border-line bg-surface">
              <div className="flex aspect-[4/3] items-center justify-center bg-surface-sunken">
                {isImage ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={a.url} alt={a.alt ?? a.filename} className="h-full w-full object-contain" loading="lazy" />
                ) : (
                  <FileText size={28} className="text-ink-faint" />
                )}
              </div>
              <div className="space-y-1 p-2.5">
                <p className="truncate text-xs font-medium text-ink" title={a.filename}>
                  {a.filename}
                </p>
                {a.alt && <p className="truncate text-[11px] text-ink-faint" title={a.alt}>{a.alt}</p>}
                <div className="flex items-center justify-between text-[11px] text-ink-faint">
                  <span>{humanSize(a.sizeBytes)}</span>
                  {a.folder && <StatusBadge tone="neutral">{a.folder}</StatusBadge>}
                </div>
                <div className="flex flex-wrap gap-2 pt-1 text-[11px]">
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard?.writeText(a.url).then(() => {
                        setCopied(a.id);
                        setTimeout(() => setCopied(null), 1500);
                      });
                    }}
                    className="inline-flex items-center gap-1 text-ink-faint hover:text-ink"
                  >
                    {copied === a.id ? <Check size={12} /> : <Copy size={12} />}
                    {copied === a.id ? "Copied" : "URL"}
                  </button>
                  {canManage && (
                    <>
                      <button
                        type="button"
                        onClick={() => setEditing(a)}
                        className="inline-flex items-center gap-1 text-ink-faint hover:text-ink"
                      >
                        <Pencil size={12} /> Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingDelete(a)}
                        className="inline-flex items-center gap-1 text-ink-faint hover:text-clay"
                      >
                        <Trash2 size={12} /> Delete
                      </button>
                    </>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (!pendingDelete) return;
          const fd = new FormData();
          fd.set("id", pendingDelete.id);
          formAction(fd);
          setPendingDelete(null);
        }}
        title="Delete this file?"
        message={
          <>
            <strong>{pendingDelete?.filename}</strong> will be removed from storage. If it is still
            used by a product, category or content block, the delete is blocked.
          </>
        }
        confirmLabel="Delete"
        pending={deleting}
      />

      {editing && <AltEditor asset={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function AltEditor({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const [alt, setAlt] = useState(asset.alt ?? "");
  const [pending, start] = useTransition();

  return (
    <Modal
      open
      onClose={onClose}
      title="Edit description"
      footer={
        <>
          <button type="button" onClick={onClose} className="btn btn-outline py-2 text-sm">
            Cancel
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const res = await updateMediaAltAction({ id: asset.id, alt });
                if (res.ok) {
                  notify.success("Description updated");
                  onClose();
                } else {
                  notify.error(res.error ?? "That didn't work.");
                }
              })
            }
            className="btn btn-primary py-2 text-sm"
          >
            Save
          </button>
        </>
      }
    >
      <label className="block text-sm font-medium text-ink">Alt text</label>
      <input
        value={alt}
        onChange={(e) => setAlt(e.target.value)}
        maxLength={300}
        className="field mt-1.5 text-sm"
        placeholder="Describe the image for screen readers"
      />
    </Modal>
  );
}
