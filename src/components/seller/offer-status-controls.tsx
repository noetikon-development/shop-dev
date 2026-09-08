"use client";

import { useEffect, useState } from "react";
import { Loader2, CheckCircle2 } from "lucide-react";
import { setOfferStatusAction, type SellerActionState } from "@/lib/seller/offer-actions";
import { ConfirmDialog, notify, usePersistentAction } from "@/components/seller/ui";

/**
 * 9F-24A — full seller status control:
 *   DRAFT / INACTIVE → Publish listing (when every publish gate passes),
 *                      Deactivate / Move to draft, Archive
 *   ACTIVE           → live badge, Take offline, Archive
 *   ARCHIVED         → terminal, no control
 *
 * `blockers` are already-resolved, user-facing reason strings from
 * `offerPublishBlockers` — when non-empty the "Publish" button is replaced by
 * the reason list. The server action re-runs the same check.
 */
export function OfferStatusControls({
  offerId,
  status,
  blockers,
}: {
  offerId: string;
  status: string;
  blockers: string[];
}) {
  const { state, dispatch, pending } = usePersistentAction<SellerActionState>(setOfferStatusAction, {});
  const [confirmArchive, setConfirmArchive] = useState(false);

  useEffect(() => {
    if (state.ok && state.message) notify.success(state.message);
    if (state.error) notify.error(state.error);
  }, [state]);

  const submit = (next: "DRAFT" | "ACTIVE" | "INACTIVE" | "ARCHIVED") => {
    const fd = new FormData();
    fd.set("offerId", offerId);
    fd.set("status", next);
    dispatch(fd);
  };

  if (status === "ARCHIVED") {
    return <p className="text-sm text-ink-faint">This listing is archived and can’t be changed.</p>;
  }

  const canPublish = blockers.length === 0;

  return (
    <div className="space-y-3">
      {status === "ACTIVE" ? (
        <>
          <p className="flex items-center gap-1.5 text-sm font-medium text-sage">
            <CheckCircle2 size={15} /> This listing is live on the storefront.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() => submit("INACTIVE")}
              className="btn btn-outline py-2 text-sm"
            >
              {pending && <Loader2 size={13} className="animate-spin" />}
              Take offline
            </button>
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
            Taking it offline hides it from buyers immediately; your stock and price are kept.
          </p>
        </>
      ) : (
        <>
          {canPublish ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => submit("ACTIVE")}
              className="btn btn-primary py-2 text-sm"
            >
              {pending && <Loader2 size={13} className="animate-spin" />}
              Publish listing
            </button>
          ) : (
            <div className="rounded-sm border border-line bg-surface-sunken px-3 py-2 text-xs text-ink-soft">
              <p className="font-medium text-ink">Not ready to publish yet:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </div>
          )}

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
        </>
      )}

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
