"use client";

import Link from "next/link";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { MessageSquare, Check, X, Archive, Loader2 } from "lucide-react";
import { DataTable, type Column, StatusBadge, notify } from "@/components/admin/ui";
import { Stars } from "@/components/ui/primitives";
import { formatDate } from "@/lib/utils";
import { setReviewStatusAction } from "@/lib/admin/review-actions";
import type { AdminReviewRow } from "@/lib/admin/reviews";
import type { ReviewStatus } from "@/lib/reviews";

const STATUS_TONE: Record<ReviewStatus, "neutral" | "success" | "warning" | "danger"> = {
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  ARCHIVED: "neutral",
};

function RowActions({
  id,
  status,
  canManage,
}: {
  id: string;
  status: ReviewStatus;
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  if (!canManage) return null;

  const run = (next: ReviewStatus, msg: string) =>
    start(async () => {
      const res = await setReviewStatusAction({ id, status: next });
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
        <button
          type="button"
          onClick={() => run("APPROVED", "Review approved")}
          disabled={pending}
          className="btn btn-ghost p-1.5 text-sage"
          aria-label="Approve review"
          title="Approve"
        >
          <Check size={15} />
        </button>
      )}
      {status !== "REJECTED" && (
        <button
          type="button"
          onClick={() => run("REJECTED", "Review rejected")}
          disabled={pending}
          className="btn btn-ghost p-1.5 text-clay"
          aria-label="Reject review"
          title="Reject"
        >
          <X size={15} />
        </button>
      )}
      {status !== "ARCHIVED" && (
        <button
          type="button"
          onClick={() => run("ARCHIVED", "Review archived")}
          disabled={pending}
          className="btn btn-ghost p-1.5 text-ink-faint"
          aria-label="Archive review"
          title="Archive"
        >
          <Archive size={15} />
        </button>
      )}
    </div>
  );
}

export function ReviewsTable({
  rows,
  canManage,
  searching,
}: {
  rows: AdminReviewRow[];
  canManage: boolean;
  searching: boolean;
}) {
  const columns: Column<AdminReviewRow>[] = [
    {
      key: "review",
      header: "Review",
      cell: (r) => (
        <div className="min-w-0 max-w-md">
          <Link href={`/admin/reviews/${r.id}`} className="font-medium text-ink hover:underline">
            {r.title || "(no title)"}
          </Link>
          <p className="truncate text-xs text-ink-faint">{r.excerpt}</p>
          <p className="mt-1 text-xs text-ink-faint">
            {r.customer}
            {r.verified && <span className="text-sage"> · verified</span>}
          </p>
        </div>
      ),
    },
    {
      key: "product",
      header: "Product",
      cell: (r) => (
        <Link href={`/p/${r.productSlug}`} className="text-ink-soft hover:underline" target="_blank">
          {r.productName}
        </Link>
      ),
    },
    {
      key: "rating",
      header: "Rating",
      cell: (r) => <Stars value={r.rating} showNumber={false} size={13} />,
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
        icon: <MessageSquare size={18} />,
        title: searching ? "No reviews match your search." : "No reviews yet.",
        description: searching
          ? "Try a different search or status filter."
          : "Customer reviews will appear here once they're submitted.",
      }}
    />
  );
}
