"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  requestChangesAction,
  rejectRequestAction,
  type RequestReviewState,
} from "@/lib/admin/seller-product-requests/actions";
import { notify, usePersistentAction } from "@/components/admin/ui";

export function RequestReviewActions({ requestId }: { requestId: string }) {
  const [mode, setMode] = useState<"changes" | "reject">("changes");
  const action = mode === "changes" ? requestChangesAction : rejectRequestAction;
  const { state, onSubmit, pending } = usePersistentAction<RequestReviewState>(action, {});

  useEffect(() => {
    if (state.ok && state.message) notify.success(state.message);
    if (state.error) notify.error(state.error);
  }, [state]);

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <input type="hidden" name="requestId" value={requestId} />
      <div className="flex gap-1 text-xs">
        <button
          type="button"
          onClick={() => setMode("changes")}
          className={`rounded-sm border px-2 py-1 ${mode === "changes" ? "border-ink bg-ink text-paper" : "border-line text-ink-soft"}`}
        >
          Request changes
        </button>
        <button
          type="button"
          onClick={() => setMode("reject")}
          className={`rounded-sm border px-2 py-1 ${mode === "reject" ? "border-clay bg-clay text-paper" : "border-line text-ink-soft"}`}
        >
          Reject
        </button>
      </div>
      <p className="text-xs text-ink-faint">
        {mode === "changes"
          ? "Sends the request back to the seller as an editable draft. They can revise and resubmit."
          : "Rejects the request. This is terminal — the seller would need to start a new request."}
      </p>
      <textarea
        name="note"
        required
        rows={3}
        maxLength={2000}
        placeholder={mode === "changes" ? "What should the seller change?" : "Why is this being rejected?"}
        className="field text-sm"
      />
      {state.error && <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>}
      <button
        type="submit"
        disabled={pending}
        className={`btn py-2 text-sm ${mode === "reject" ? "btn-clay" : "btn-outline"}`}
      >
        {pending && <Loader2 size={14} className="animate-spin" />}
        {mode === "changes" ? "Send back for changes" : "Reject request"}
      </button>
    </form>
  );
}
