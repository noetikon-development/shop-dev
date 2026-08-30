"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Star, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { usePersistentAction } from "@/components/admin/ui/use-form";
import { REVIEW_LIMITS } from "@/lib/ugc";
import {
  submitReviewAction,
  editReviewAction,
  deleteReviewAction,
  type ReviewActionState,
} from "@/lib/review-actions";

type MyReview = {
  id: string;
  rating: number;
  title: string | null;
  body: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "ARCHIVED";
} | null;

const EMPTY: ReviewActionState = {};

const STATUS_NOTE: Record<NonNullable<MyReview>["status"], string> = {
  PENDING: "Your review is awaiting moderation and isn't public yet.",
  APPROVED: "Your review is published.",
  REJECTED: "Your review wasn't approved. You can edit it to resubmit.",
  ARCHIVED: "Your review has been archived by the store.",
};

export function ReviewComposer({
  productId,
  canReview,
  myReview,
}: {
  productId: string;
  canReview: boolean;
  myReview: MyReview;
}) {
  const router = useRouter();
  const editing = Boolean(myReview);
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(myReview?.rating ?? 0);
  const [hover, setHover] = useState(0);
  const [deletePending, startDelete] = useTransition();
  const doneRef = useRef(false);

  const { state, onSubmit, pending } = usePersistentAction<ReviewActionState>(
    editing ? editReviewAction : submitReviewAction,
    EMPTY,
  );
  const fe = state.fieldErrors ?? {};

  useEffect(() => {
    if (!state.ok || doneRef.current) return;
    doneRef.current = true;
    toast.success(editing ? "Review updated — pending moderation" : "Thanks! Your review is pending moderation");
    setOpen(false);
    router.refresh();
  }, [state.ok, editing, router]);

  useEffect(() => {
    if (state.error || state.fieldErrors) doneRef.current = false;
  }, [state]);

  function remove() {
    if (!myReview) return;
    startDelete(async () => {
      const res = await deleteReviewAction({ reviewId: myReview.id });
      if (res.ok) {
        toast.success("Review removed");
        router.refresh();
      } else {
        toast.error(res.error ?? "That didn't work.");
      }
    });
  }

  if (!editing && !canReview) return null;

  if (!open) {
    return (
      <div className="rounded-md border border-line bg-surface-sunken/40 p-4">
        {editing ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-ink-soft">
              {STATUS_NOTE[myReview!.status]}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setRating(myReview!.rating);
                  setOpen(true);
                }}
                className="btn btn-outline py-2 text-sm"
              >
                Edit review
              </button>
              <button
                type="button"
                onClick={remove}
                disabled={deletePending}
                className="btn btn-ghost py-2 text-sm text-clay"
              >
                {deletePending && <Loader2 size={13} className="animate-spin" />}
                Delete
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-ink-soft">
              You bought this — share what you think.
            </p>
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="btn btn-primary py-2 text-sm"
            >
              Write a review
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-md border border-line bg-surface-sunken/40 p-4">
      <input type="hidden" name="productId" value={productId} />
      {editing && <input type="hidden" name="reviewId" value={myReview!.id} />}
      <input type="hidden" name="rating" value={rating} />

      <div>
        <p className="text-sm font-medium">Your rating</p>
        <div className="mt-1.5 flex gap-1" onMouseLeave={() => setHover(0)}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setRating(n)}
              onMouseEnter={() => setHover(n)}
              aria-label={`${n} star${n > 1 ? "s" : ""}`}
              aria-pressed={rating === n}
              className="p-0.5"
            >
              <Star
                size={24}
                strokeWidth={1.5}
                className={cn(
                  (hover || rating) >= n ? "text-clay" : "text-line-strong",
                )}
                fill={(hover || rating) >= n ? "currentColor" : "none"}
              />
            </button>
          ))}
        </div>
        {fe.rating && <p className="mt-1 text-xs text-clay">{fe.rating}</p>}
      </div>

      <div>
        <label htmlFor="review-title" className="text-sm font-medium">
          Title <span className="text-ink-faint">(optional)</span>
        </label>
        <input
          id="review-title"
          name="title"
          maxLength={REVIEW_LIMITS.titleMax}
          defaultValue={myReview?.title ?? ""}
          className="field mt-1.5"
          placeholder="Sums up your experience"
        />
        {fe.title && <p className="mt-1 text-xs text-clay">{fe.title}</p>}
      </div>

      <div>
        <label htmlFor="review-body" className="text-sm font-medium">
          Your review
        </label>
        <textarea
          id="review-body"
          name="body"
          required
          rows={5}
          minLength={REVIEW_LIMITS.bodyMin}
          maxLength={REVIEW_LIMITS.bodyMax}
          defaultValue={myReview?.body ?? ""}
          className="field mt-1.5"
          placeholder="What did you like or not like? How are you using it?"
        />
        {fe.body && <p className="mt-1 text-xs text-clay">{fe.body}</p>}
      </div>

      {state.error && !state.fieldErrors && (
        <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>
      )}

      <p className="text-xs text-ink-faint">
        Reviews are checked by our team before they appear. Editing a published review sends it back for review.
      </p>

      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => setOpen(false)} className="btn btn-outline py-2 text-sm">
          Cancel
        </button>
        <button type="submit" disabled={pending} className="btn btn-primary py-2 text-sm">
          {pending && <Loader2 size={14} className="animate-spin" />}
          {editing ? "Save changes" : "Submit review"}
        </button>
      </div>
    </form>
  );
}
