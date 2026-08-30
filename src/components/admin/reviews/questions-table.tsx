"use client";

import Link from "next/link";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { MessagesSquare, Check, X, Archive, Loader2 } from "lucide-react";
import { DataTable, type Column, StatusBadge, notify } from "@/components/admin/ui";
import { formatDate } from "@/lib/utils";
import { setQuestionStatusAction } from "@/lib/admin/question-actions";
import type { AdminQuestionRow, QAStatus } from "@/lib/admin/questions";

const STATUS_TONE: Record<QAStatus, "neutral" | "success" | "warning" | "danger"> = {
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  ARCHIVED: "neutral",
};

function RowActions({ id, status, canManage }: { id: string; status: QAStatus; canManage: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  if (!canManage) return null;

  const run = (next: QAStatus, msg: string) =>
    start(async () => {
      const res = await setQuestionStatusAction({ id, status: next });
      if (res.ok) {
        notify.success(msg);
        router.refresh();
      } else {
        notify.error(res.error ?? "That didn't work.");
      }
    });

  return (
    <div className="flex items-center justify-end gap-1">
      {pending && <Loader2 size={13} className="animate-spin text-ink-faint" />}
      {status !== "APPROVED" && (
        <button type="button" onClick={() => run("APPROVED", "Question approved")} disabled={pending} className="btn btn-ghost p-1.5 text-sage" title="Approve" aria-label="Approve question">
          <Check size={15} />
        </button>
      )}
      {status !== "REJECTED" && (
        <button type="button" onClick={() => run("REJECTED", "Question rejected")} disabled={pending} className="btn btn-ghost p-1.5 text-clay" title="Reject" aria-label="Reject question">
          <X size={15} />
        </button>
      )}
      {status !== "ARCHIVED" && (
        <button type="button" onClick={() => run("ARCHIVED", "Question archived")} disabled={pending} className="btn btn-ghost p-1.5 text-ink-faint" title="Archive" aria-label="Archive question">
          <Archive size={15} />
        </button>
      )}
    </div>
  );
}

export function QuestionsTable({
  rows,
  canManage,
  searching,
}: {
  rows: AdminQuestionRow[];
  canManage: boolean;
  searching: boolean;
}) {
  const columns: Column<AdminQuestionRow>[] = [
    {
      key: "question",
      header: "Question",
      cell: (r) => (
        <div className="min-w-0 max-w-md">
          <Link href={`/admin/reviews/questions/${r.id}`} className="font-medium text-ink hover:underline">
            {r.excerpt}
          </Link>
          <p className="mt-1 text-xs text-ink-faint">{r.customer}</p>
        </div>
      ),
    },
    {
      key: "product",
      header: "Product",
      cell: (r) => (
        <Link href={`/p/${r.productSlug}`} target="_blank" className="text-ink-soft hover:underline">
          {r.productName}
        </Link>
      ),
    },
    {
      key: "answers",
      header: "Answers",
      align: "right",
      cell: (r) => <span className="tabular-nums text-ink-soft">{r.answerCount}</span>,
    },
    {
      key: "status",
      header: "Status",
      cell: (r) => <StatusBadge tone={STATUS_TONE[r.status]}>{r.status}</StatusBadge>,
    },
    {
      key: "date",
      header: "Date",
      cell: (r) => <span className="whitespace-nowrap text-ink-faint">{formatDate(r.createdAt)}</span>,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (r) => <RowActions id={r.id} status={r.status} canManage={canManage} />,
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(r) => r.id}
      empty={{
        icon: <MessagesSquare size={18} />,
        title: searching ? "No questions match your search." : "No questions yet.",
        description: searching
          ? "Try a different search or status filter."
          : "Customer questions will appear here once they're submitted.",
      }}
    />
  );
}
