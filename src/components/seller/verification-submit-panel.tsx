"use client";

import { useEffect } from "react";
import { Loader2, Send } from "lucide-react";
import { submitSellerVerificationForReviewAction, type SellerVerificationActionState } from "@/lib/seller-verification/actions";
import { notify, usePersistentAction } from "@/components/seller/ui";

/**
 * "Submit for Review" (Phase 5) — the DRAFT → PENDING transition. Shown by
 * the page ONLY while `verification.status === "DRAFT"`; the page itself
 * shows the PENDING/APPROVED/REJECTED read-only states instead once this
 * succeeds (no client-side status juggling needed here — `revalidatePath`
 * in the action re-renders the page with the new status).
 */
export function SellerVerificationSubmitPanel() {
  const submit = usePersistentAction<SellerVerificationActionState>(submitSellerVerificationForReviewAction, {});

  useEffect(() => {
    if (submit.state.ok && submit.state.message) notify.success(submit.state.message);
    if (submit.state.error) notify.error(submit.state.error);
  }, [submit.state]);

  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-soft">
        Once submitted, Axiaro reviews your information and documents. You won&rsquo;t be able to edit them while the
        review is in progress.
      </p>
      {submit.state.error && <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{submit.state.error}</p>}
      <form onSubmit={submit.onSubmit}>
        <button type="submit" disabled={submit.pending} className="btn btn-primary py-2 text-sm">
          {submit.pending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          Submit for review
        </button>
      </form>
    </div>
  );
}
