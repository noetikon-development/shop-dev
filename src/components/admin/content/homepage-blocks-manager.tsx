"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, ArrowDown, Eye, EyeOff, Pencil, Trash2, Plus, Loader2 } from "lucide-react";
import { Card, StatusBadge, ConfirmDialog, EmptyState, notify } from "@/components/admin/ui";
import { BlockEditor } from "@/components/admin/content/block-editor";
import {
  setBlockStatusAction,
  reorderBlocksAction,
  deleteBlockAction,
  getBlockForEditAction,
} from "@/lib/admin/content-block-actions";
import type { AdminBlockRow } from "@/lib/admin/content";
import type { PickerAsset } from "@/lib/admin/media-picker-data";
import type { BlockTypeKey } from "@/lib/content-blocks";

type ProductOption = { id: string; name: string; slug: string; status: string };
type CategoryOption = { slug: string; name: string };
type BlockDetail = NonNullable<Awaited<ReturnType<typeof getBlockForEditAction>>>;

export function HomepageBlocksManager({
  rows,
  canManage,
  mediaAssets,
  products,
  categories,
}: {
  rows: AdminBlockRow[];
  canManage: boolean;
  mediaAssets: PickerAsset[];
  products: ProductOption[];
  categories: CategoryOption[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirmDelete, setConfirmDelete] = useState<AdminBlockRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<BlockDetail | null>(null);
  const [loadingEdit, setLoadingEdit] = useState<string | null>(null);

  function run(fn: () => Promise<{ ok?: boolean; error?: string }>, msg: string) {
    start(async () => {
      const res = await fn();
      if (res.ok) {
        notify.success(msg);
        setConfirmDelete(null);
        router.refresh();
      } else {
        notify.error(res.error ?? "That didn't work.");
      }
    });
  }

  function move(index: number, dir: -1 | 1) {
    const next = [...rows];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    run(() => reorderBlocksAction({ area: "homepage", ids: next.map((b) => b.id) }), "Order updated");
  }

  async function openEdit(id: string) {
    setLoadingEdit(id);
    const block = await getBlockForEditAction(id);
    setLoadingEdit(null);
    if (block) setEditing(block);
    else notify.error("That section wasn't found.");
  }

  if (adding) {
    return (
      <div>
        <button onClick={() => setAdding(false)} className="mb-4 text-sm text-ink-soft hover:text-ink">
          ← Back to sections
        </button>
        <BlockEditor
          mediaAssets={mediaAssets}
          products={products}
          categories={categories}
          onDone={() => {
            setAdding(false);
            router.refresh();
          }}
        />
      </div>
    );
  }

  if (editing) {
    return (
      <div>
        <button onClick={() => setEditing(null)} className="mb-4 text-sm text-ink-soft hover:text-ink">
          ← Back to sections
        </button>
        <BlockEditor
          block={{
            id: editing.id,
            type: editing.type as BlockTypeKey,
            title: editing.title,
            status: editing.status,
            data: editing.data,
          }}
          mediaAssets={mediaAssets}
          products={products}
          categories={categories}
          onDone={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {canManage && (
        <button onClick={() => setAdding(true)} className="btn btn-primary py-2 text-sm">
          <Plus size={14} /> Add section
        </button>
      )}

      {rows.length === 0 ? (
        <EmptyState
          title="No homepage sections yet."
          description={
            canManage
              ? "Add a hero, product rails, feature cards and value props. Until you publish sections here, the storefront shows the built-in homepage."
              : "Sections added by an editor will appear here."
          }
        />
      ) : (
        <ul className="space-y-2">
          {rows.map((b, i) => (
            <li key={b.id}>
              <Card className="flex flex-wrap items-center gap-3">
                <div className="flex flex-col">
                  <button
                    type="button"
                    onClick={() => move(i, -1)}
                    disabled={!canManage || pending || i === 0}
                    className="text-ink-faint hover:text-ink disabled:opacity-30"
                    aria-label="Move up"
                  >
                    <ArrowUp size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(i, 1)}
                    disabled={!canManage || pending || i === rows.length - 1}
                    className="text-ink-faint hover:text-ink disabled:opacity-30"
                    aria-label="Move down"
                  >
                    <ArrowDown size={14} />
                  </button>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink">
                    {b.title || b.typeLabel}
                    <span className="ml-2 text-xs font-normal text-ink-faint">{b.typeLabel}</span>
                  </p>
                  <p className="truncate text-xs text-ink-faint">{b.summary}</p>
                </div>
                <StatusBadge tone={b.status === "PUBLISHED" ? "success" : "neutral"}>
                  {b.status === "PUBLISHED" ? "Published" : "Draft"}
                </StatusBadge>
                {canManage && (
                  <div className="flex items-center gap-1">
                    {b.status === "PUBLISHED" ? (
                      <button
                        onClick={() => run(() => setBlockStatusAction({ id: b.id, status: "DRAFT" }), "Section hidden")}
                        disabled={pending}
                        className="btn btn-ghost p-1.5 text-ink-faint"
                        title="Hide"
                      >
                        <EyeOff size={15} />
                      </button>
                    ) : (
                      <button
                        onClick={() => run(() => setBlockStatusAction({ id: b.id, status: "PUBLISHED" }), "Section published")}
                        disabled={pending}
                        className="btn btn-ghost p-1.5 text-sage"
                        title="Publish"
                      >
                        <Eye size={15} />
                      </button>
                    )}
                    <button
                      onClick={() => openEdit(b.id)}
                      disabled={pending || loadingEdit === b.id}
                      className="btn btn-ghost p-1.5"
                      title="Edit"
                    >
                      {loadingEdit === b.id ? <Loader2 size={15} className="animate-spin" /> : <Pencil size={15} />}
                    </button>
                    <button
                      onClick={() => setConfirmDelete(b)}
                      disabled={pending}
                      className="btn btn-ghost p-1.5 text-clay"
                      title="Delete"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        onClose={() => !pending && setConfirmDelete(null)}
        onConfirm={() => confirmDelete && run(() => deleteBlockAction({ id: confirmDelete.id }), "Section deleted")}
        title="Delete this section?"
        message={`The "${confirmDelete?.title || confirmDelete?.typeLabel}" section will be removed from the homepage.`}
        confirmLabel="Delete"
        pending={pending}
      />
    </div>
  );
}
