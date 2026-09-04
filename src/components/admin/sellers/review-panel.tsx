"use client";

import { useEffect, useState } from "react";
import { Loader2, Check, X } from "lucide-react";
import { FormField, notify, usePersistentAction } from "@/components/admin/ui";
import {
  approveSellerContentAction,
  rejectSellerContentAction,
  type SellerReviewActionState,
} from "@/lib/admin/seller-content-actions";

export function SellerContentReviewPanel({ sellerId }: { sellerId: string }) {
  const [note, setNote] = useState("");
  const approve = usePersistentAction<SellerReviewActionState>(approveSellerContentAction, {});
  const reject = usePersistentAction<SellerReviewActionState>(rejectSellerContentAction, {});

  useEffect(() => {
    if (approve.state.ok && approve.state.message) notify.success(approve.state.message);
    if (approve.state.error) notify.error(approve.state.error);
  }, [approve.state]);
  useEffect(() => {
    if (reject.state.ok && reject.state.message) notify.success(reject.state.message);
    if (reject.state.error) notify.error(reject.state.error);
  }, [reject.state]);

  const pending = approve.pending || reject.pending;

  return (
    <div className="space-y-3">
      <FormField label="Note to the seller" htmlFor="review-note" hint="Required to request changes; optional on approval.">
        <textarea
          id="review-note"
          name="note"
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={2000}
          className="field text-sm"
        />
      </FormField>

      <div className="flex flex-wrap gap-2">
        <form onSubmit={approve.onSubmit}>
          <input type="hidden" name="sellerId" value={sellerId} />
          <input type="hidden" name="note" value={note} />
          <button type="submit" disabled={pending} className="btn btn-primary py-2 text-sm">
            {approve.pending ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            Approve
          </button>
        </form>
        <form onSubmit={reject.onSubmit}>
          <input type="hidden" name="sellerId" value={sellerId} />
          <input type="hidden" name="note" value={note} />
          <button type="submit" disabled={pending} className="btn btn-secondary py-2 text-sm">
            {reject.pending ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
            Request changes
          </button>
        </form>
      </div>
    </div>
  );
}
