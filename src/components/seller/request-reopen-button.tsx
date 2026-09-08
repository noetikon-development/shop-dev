"use client";

import { useEffect } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import {
  reopenRequestAction,
  type SellerRequestActionState,
} from "@/lib/seller/product-request-actions";
import { notify, usePersistentAction } from "@/components/seller/ui";

/**
 * 9F-26A (G7) — "Revise and resubmit" for a REJECTED product request. Moves it
 * back to DRAFT (proposal, images and the rejection note are kept), after which
 * the normal edit form + "Submit for review" panel appear.
 */
export function RequestReopenButton({ requestId }: { requestId: string }) {
  const { state, dispatch, pending } = usePersistentAction<SellerRequestActionState>(
    reopenRequestAction,
    {},
  );

  useEffect(() => {
    if (state.ok && state.message) notify.success(state.message);
    if (state.error) notify.error(state.error);
  }, [state]);

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        const fd = new FormData();
        fd.set("requestId", requestId);
        dispatch(fd);
      }}
      className="btn btn-primary mt-2 py-1.5 text-xs"
    >
      {pending ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
      Revise and resubmit
    </button>
  );
}
