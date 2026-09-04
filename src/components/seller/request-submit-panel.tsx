"use client";

import { useEffect, useState } from "react";
import { Loader2, AlertTriangle, Info } from "lucide-react";
import {
  submitRequestAction,
  type SellerRequestActionState,
} from "@/lib/seller/product-request-actions";
import { notify, usePersistentAction, ConfirmDialog } from "@/components/seller/ui";

type Block = { message: string };
type Warning = { message: string };

export function RequestSubmitPanel({
  requestId,
  blocks,
  warnings,
}: {
  requestId: string;
  blocks: Block[];
  warnings: Warning[];
}) {
  const { state, dispatch, pending } = usePersistentAction<SellerRequestActionState>(submitRequestAction, {});
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    if (state.ok && state.message) notify.success(state.message);
    if (state.error) notify.error(state.error);
  }, [state]);

  const blocked = blocks.length > 0;

  return (
    <div className="space-y-3">
      {blocked && (
        <div className="space-y-1 rounded-sm border border-clay/30 bg-clay-50 px-3 py-2 text-sm text-clay">
          <p className="flex items-center gap-1.5 font-medium">
            <AlertTriangle size={13} /> Can&rsquo;t submit yet
          </p>
          {blocks.map((b, i) => (
            <p key={i}>{b.message}</p>
          ))}
        </div>
      )}
      {!blocked && warnings.length > 0 && (
        <div className="space-y-1 rounded-sm border border-line bg-surface-sunken px-3 py-2 text-sm text-ink-soft">
          <p className="flex items-center gap-1.5 font-medium text-ink">
            <Info size={13} /> Possible matches
          </p>
          {warnings.map((w, i) => (
            <p key={i}>{w.message}</p>
          ))}
          <p className="text-xs">You can still submit — Axiaro will double-check.</p>
        </div>
      )}

      <p className="text-xs text-ink-faint">
        Once submitted, the request is locked while Axiaro reviews it.
      </p>
      <button
        type="button"
        disabled={pending || blocked}
        onClick={() => setConfirm(true)}
        className="btn btn-primary w-full py-2 text-sm"
      >
        {pending && <Loader2 size={14} className="animate-spin" />}
        Submit for review
      </button>

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          const fd = new FormData();
          fd.set("requestId", requestId);
          dispatch(fd);
        }}
        title="Submit this request?"
        message="Axiaro will review it. You won't be able to edit it while it's in review."
        confirmLabel="Submit"
        tone="default"
        pending={pending}
      />
    </div>
  );
}
