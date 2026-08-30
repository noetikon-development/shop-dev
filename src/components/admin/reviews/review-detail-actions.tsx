"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, X, Archive, RotateCcw, Loader2 } from "lucide-react";
import { notify } from "@/components/admin/ui";
import { setReviewStatusAction } from "@/lib/admin/review-actions";
import type { ReviewStatus } from "@/lib/reviews";

export function ReviewDetailActions({
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
    <div className="flex flex-wrap items-center gap-2">
      {pending && <Loader2 size={14} className="animate-spin text-ink-faint" />}
      {status !== "APPROVED" && (
        <button type="button" onClick={() => run("APPROVED", "Review approved")} disabled={pending} className="btn btn-primary py-2 text-sm">
          <Check size={14} /> Approve
        </button>
      )}
      {status !== "REJECTED" && (
        <button type="button" onClick={() => run("REJECTED", "Review rejected")} disabled={pending} className="btn btn-outline py-2 text-sm">
          <X size={14} /> Reject
        </button>
      )}
      {status !== "ARCHIVED" && (
        <button type="button" onClick={() => run("ARCHIVED", "Review archived")} disabled={pending} className="btn btn-ghost py-2 text-sm text-clay">
          <Archive size={14} /> Archive
        </button>
      )}
      {status !== "PENDING" && (
        <button type="button" onClick={() => run("PENDING", "Review reopened for moderation")} disabled={pending} className="btn btn-ghost py-2 text-sm">
          <RotateCcw size={14} /> Reopen
        </button>
      )}
    </div>
  );
}
