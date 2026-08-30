"use client";

import Link from "next/link";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileText, Eye, EyeOff, Trash2, Loader2, ExternalLink } from "lucide-react";
import { DataTable, type Column, StatusBadge, ConfirmDialog, notify } from "@/components/admin/ui";
import { useState } from "react";
import { formatDate } from "@/lib/utils";
import { setPageStatusAction, deletePageAction } from "@/lib/admin/content-page-actions";
import type { AdminPageRow } from "@/lib/admin/content";

function RowActions({ row, canManage }: { row: AdminPageRow; canManage: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (!canManage) return null;

  const run = (fn: () => Promise<{ ok?: boolean; error?: string }>, msg: string) =>
    start(async () => {
      const res = await fn();
      if (res.ok) {
        notify.success(msg);
        setConfirmDelete(false);
        router.refresh();
      } else {
        notify.error(res.error ?? "That didn't work.");
      }
    });

  return (
    <div className="flex items-center justify-end gap-1">
      {pending && <Loader2 size={13} className="animate-spin text-ink-faint" />}
      {row.status === "PUBLISHED" ? (
        <button
          type="button"
          onClick={() => run(() => setPageStatusAction({ id: row.id, status: "DRAFT" }), "Page unpublished")}
          disabled={pending}
          className="btn btn-ghost p-1.5 text-ink-faint"
          title="Unpublish"
        >
          <EyeOff size={15} />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => run(() => setPageStatusAction({ id: row.id, status: "PUBLISHED" }), "Page published")}
          disabled={pending}
          className="btn btn-ghost p-1.5 text-sage"
          title="Publish"
        >
          <Eye size={15} />
        </button>
      )}
      <button
        type="button"
        onClick={() => setConfirmDelete(true)}
        disabled={pending}
        className="btn btn-ghost p-1.5 text-clay"
        title="Delete"
      >
        <Trash2 size={15} />
      </button>
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => !pending && setConfirmDelete(false)}
        onConfirm={() => run(() => deletePageAction({ id: row.id }), "Page deleted")}
        title="Delete this page?"
        message={`"${row.title}" will be permanently removed. Any footer or menu links to /pages/${row.slug} will 404.`}
        confirmLabel="Delete"
        pending={pending}
      />
    </div>
  );
}

export function PagesTable({ rows, canManage }: { rows: AdminPageRow[]; canManage: boolean }) {
  const columns: Column<AdminPageRow>[] = [
    {
      key: "title",
      header: "Page",
      cell: (r) => (
        <div className="min-w-0">
          <Link href={`/admin/content/pages/${r.id}`} className="font-medium text-ink hover:underline">
            {r.title}
          </Link>
          <p className="truncate text-xs text-ink-faint">/pages/{r.slug}</p>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (r) => (
        <StatusBadge tone={r.status === "PUBLISHED" ? "success" : "neutral"}>
          {r.status === "PUBLISHED" ? "Published" : "Draft"}
        </StatusBadge>
      ),
    },
    {
      key: "updated",
      header: "Updated",
      cell: (r) => <span className="whitespace-nowrap text-ink-faint">{formatDate(r.updatedAt)}</span>,
    },
    {
      key: "view",
      header: "",
      cell: (r) =>
        r.status === "PUBLISHED" ? (
          <a href={`/pages/${r.slug}`} target="_blank" rel="noreferrer" className="text-ink-faint hover:text-ink">
            <ExternalLink size={14} />
          </a>
        ) : null,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (r) => <RowActions row={r} canManage={canManage} />,
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(r) => r.id}
      empty={{
        icon: <FileText size={18} />,
        title: "No content pages yet.",
        description: "Create pages like About, FAQ, Privacy Policy and Terms.",
      }}
    />
  );
}
