"use client";

import { useActionState, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { ConfirmDialog, notify } from "@/components/admin/ui";
import { deleteCategory, type CatalogState } from "@/lib/admin/catalog-actions";

export function CategoryDelete({
  categoryId,
  name,
  productCount,
  childCount,
}: {
  categoryId: string;
  name: string;
  productCount: number;
  childCount: number;
}) {
  const [state, action, pending] = useActionState<CatalogState, FormData>(deleteCategory, {});
  const [open, setOpen] = useState(false);
  const blocked = productCount > 0 || childCount > 0;

  useEffect(() => {
    if (state.error) notify.error(state.error);
  }, [state]);

  return (
    <div className="rounded-md border border-clay/30 bg-clay-50/40 p-5">
      <h3 className="text-sm font-semibold text-ink">Delete category</h3>
      <p className="mt-1 text-xs text-ink-soft">
        {blocked
          ? `“${name}” has ${productCount} product(s) and ${childCount} sub-categor(y/ies). Reassign or deactivate it instead.`
          : "Permanent. Only categories with no products and no sub-categories can be deleted."}
      </p>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={blocked}
        className="btn btn-outline mt-3 py-2 text-sm text-clay disabled:opacity-40"
      >
        <Trash2 size={14} /> Delete
      </button>

      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={() => {
          const fd = new FormData();
          fd.set("id", categoryId);
          action(fd);
        }}
        title={`Delete “${name}”?`}
        message="This cannot be undone."
        confirmLabel="Delete"
        pending={pending}
      />
    </div>
  );
}
