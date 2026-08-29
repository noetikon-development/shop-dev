"use client";

import { useActionState, useEffect, useState } from "react";
import { FileText, Trash2, ImageIcon } from "lucide-react";
import {
  EmptyState,
  ConfirmDialog,
  StatusBadge,
  notify,
} from "@/components/admin/ui";
import { deleteMediaAction, type MediaDeleteState } from "@/lib/admin/content-actions";

type Asset = {
  id: string;
  url: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  folder: string;
  createdAt: string;
};

function humanSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function MediaGrid({ assets, canManage }: { assets: Asset[]; canManage: boolean }) {
  const [pendingDelete, setPendingDelete] = useState<Asset | null>(null);
  const [state, formAction, deleting] = useActionState<MediaDeleteState, FormData>(
    deleteMediaAction,
    {},
  );

  useEffect(() => {
    if (state.ok) notify.success("File deleted");
    else if (state.error) notify.error(state.error);
  }, [state]);

  if (assets.length === 0) {
    return (
      <EmptyState
        icon={<ImageIcon size={18} />}
        title="No media uploaded yet."
        description={
          canManage
            ? "Upload an image or file above to get started."
            : "Files uploaded by an editor will appear here."
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
            <li
              key={a.id}
              className="group overflow-hidden rounded-md border border-line bg-surface"
            >
              <div className="flex aspect-[4/3] items-center justify-center bg-surface-sunken">
                {isImage ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={a.url}
                    alt={a.filename}
                    className="h-full w-full object-contain"
                    loading="lazy"
                  />
                ) : (
                  <FileText size={28} className="text-ink-faint" />
                )}
              </div>
              <div className="space-y-1 p-2.5">
                <p className="truncate text-xs font-medium text-ink" title={a.filename}>
                  {a.filename}
                </p>
                <div className="flex items-center justify-between text-[11px] text-ink-faint">
                  <span>{humanSize(a.sizeBytes)}</span>
                  {a.folder && <StatusBadge tone="neutral">{a.folder}</StatusBadge>}
                </div>
                {canManage && (
                  <button
                    type="button"
                    onClick={() => setPendingDelete(a)}
                    className="mt-1 inline-flex items-center gap-1 text-[11px] text-ink-faint hover:text-clay"
                  >
                    <Trash2 size={12} /> Delete
                  </button>
                )}
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
            <strong>{pendingDelete?.filename}</strong> will be removed from storage and
            can’t be recovered.
          </>
        }
        confirmLabel="Delete"
        pending={deleting}
      />
    </>
  );
}
