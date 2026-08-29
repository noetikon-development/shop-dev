"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, Trash2, Archive, CheckCircle2, FileEdit } from "lucide-react";
import Link from "next/link";
import {
  ActionMenu,
  ConfirmDialog,
  StatusBadge,
  notify,
} from "@/components/admin/ui";
import {
  setProductStatus,
  deleteProduct,
  type CatalogState,
} from "@/lib/admin/catalog-actions";

export function ProductActions({
  productId,
  slug,
  status,
  canEdit,
  canDelete,
  isActive,
}: {
  productId: string;
  slug: string;
  status: string;
  canEdit: boolean;
  canDelete: boolean;
  isActive: boolean;
}) {
  const router = useRouter();
  const [statusState, statusAction] = useActionState<CatalogState, FormData>(setProductStatus, {});
  const [delState, delAction, deleting] = useActionState<CatalogState, FormData>(deleteProduct, {});
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (statusState.ok) {
      notify.success(statusState.message ?? "Status updated");
      router.refresh();
    }
    if (statusState.error) notify.error(statusState.error);
  }, [statusState, router]);
  useEffect(() => {
    if (delState.error) notify.error(delState.error);
  }, [delState]);

  const changeStatus = (next: string) => {
    const fd = new FormData();
    fd.set("id", productId);
    fd.set("status", next);
    statusAction(fd);
  };

  const items = [];
  if (canEdit) {
    if (status !== "ACTIVE")
      items.push({ label: "Set active", icon: <CheckCircle2 size={14} />, onSelect: () => changeStatus("ACTIVE") });
    if (status !== "DRAFT")
      items.push({ label: "Move to draft", icon: <FileEdit size={14} />, onSelect: () => changeStatus("DRAFT") });
    if (status !== "ARCHIVED")
      items.push({ label: "Archive", icon: <Archive size={14} />, onSelect: () => changeStatus("ARCHIVED") });
  }
  if (canDelete)
    items.push({
      label: "Delete…",
      icon: <Trash2 size={14} />,
      tone: "danger" as const,
      onSelect: () => setConfirmDelete(true),
    });

  return (
    <div className="flex items-center gap-2">
      <StatusBadge tone={isActive ? "success" : status === "DRAFT" ? "warning" : "neutral"}>
        {status}
      </StatusBadge>
      {isActive && (
        <Link
          href={`/p/${slug}`}
          target="_blank"
          className="btn btn-outline py-2 text-sm"
        >
          <ExternalLink size={14} /> View
        </Link>
      )}
      {items.length > 0 && <ActionMenu items={items} />}

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => {
          const fd = new FormData();
          fd.set("id", productId);
          delAction(fd);
        }}
        title="Delete this product?"
        message="Only products with no orders, reviews or wishlist entries can be deleted. If it has history, archive it instead."
        confirmLabel="Delete"
        pending={deleting}
      />
    </div>
  );
}
