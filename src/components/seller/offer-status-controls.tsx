"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { setOfferStatusAction, type SellerActionState } from "@/lib/seller/offer-actions";
import { ConfirmDialog, notify, usePersistentAction } from "@/components/seller/ui";

/**
 * DRAFT ↔ INACTIVE, and either → ARCHIVED. There is deliberately NO "publish /
 * go live" control — a seller offer cannot reach ACTIVE in this phase (the
 * server action refuses it too).
 */
export function OfferStatusControls({ offerId, status }: { offerId: string; status: string }) {
  const { state, dispatch, pending } = usePersistentAction<SellerActionState>(setOfferStatusAction, {});
  const [confirmArchive, setConfirmArchive] = useState(false);

  useEffect(() => {
    if (state.ok && state.message) notify.success(state.message);
    if (state.error) notify.error(state.error);
  }, [state]);

  const submit = (next: "DRAFT" | "INACTIVE" | "ARCHIVED") => {
    const fd = new FormData();
    fd.set("offerId", offerId);
    fd.set("status", next);
    dispatch(fd);
  };

  if (status === "ARCHIVED") {
    return <p className="text-sm text-ink-faint">This listing is archived and can’t be changed.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {status === "INACTIVE" ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => submit("DRAFT")}
            className="btn btn-outline py-2 text-sm"
          >
            {pending && <Loader2 size={13} className="animate-spin" />}
            Move to draft
          </button>
        ) : (
          <button
            type="button"
            disabled={pending}
            onClick={() => submit("INACTIVE")}
            className="btn btn-outline py-2 text-sm"
          >
            {pending && <Loader2 size={13} className="animate-spin" />}
            Deactivate
          </button>
        )}
        <button
          type="button"
          disabled={pending}
          onClick={() => setConfirmArchive(true)}
          className="btn btn-ghost py-2 text-sm text-clay"
        >
          Archive
        </button>
      </div>
      <p className="text-xs text-ink-faint">
        {status === "DRAFT" && "Draft — being prepared, not visible to buyers."}
        {status === "INACTIVE" && "Inactive — paused by you, not visible to buyers."}
      </p>

      <ConfirmDialog
        open={confirmArchive}
        onClose={() => setConfirmArchive(false)}
        onConfirm={() => {
          setConfirmArchive(false);
          submit("ARCHIVED");
        }}
        title="Archive this listing?"
        message="Archived listings are read-only and can't be brought back. The stock history stays for your records."
        confirmLabel="Archive"
        tone="danger"
        pending={pending}
      />
    </div>
  );
}
