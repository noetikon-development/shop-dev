"use client";

import { useEffect, useState } from "react";
import { Loader2, CheckCircle2 } from "lucide-react";
import {
  setAdminOfferStatusAction,
  type AdminOfferActionState,
} from "@/lib/admin/offer-admin-actions";
import { notify, usePersistentAction, ConfirmDialog } from "@/components/admin/ui";

/**
 * 9F-24D (P1-4) — operator status control for a single Offer, cross-seller.
 * Mirrors the seller's own control (`src/components/seller/offer-status-controls.tsx`)
 * and goes through the same repo rules — this is a second door, not a bypass.
 *
 *   DRAFT / INACTIVE → Publish (when every gate passes) · Deactivate/Move to draft · Archive
 *   ACTIVE           → live badge · Take offline · Archive
 *   ARCHIVED         → terminal
 */
export function AdminOfferStatusControls({
  offerId,
  status,
  blockers,
}: {
  offerId: string;
  status: string;
  blockers: string[];
}) {
  const { state, dispatch, pending } = usePersistentAction<AdminOfferActionState>(
    setAdminOfferStatusAction,
    {},
  );
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
    return <p className="text-sm text-ink-faint">This listing is archived — no further transitions.</p>;
  }

  const canPublish = blockers.length === 0;

  return (
    <div className="space-y-3">
      {status === "ACTIVE" ? (
        <>
          <p className="flex items-center gap-1.5 text-sm font-medium text-sage">
            <CheckCircle2 size={15} /> Live on the storefront.
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
            Taking it offline hides it from buyers immediately. The seller keeps their stock and price.
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
              <p className="font-medium text-ink">Not ready to publish:</p>
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
            {status === "DRAFT" && "Draft — being prepared by the seller, not visible to buyers."}
            {status === "INACTIVE" && "Inactive — paused, not visible to buyers."}
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
        message="Archived listings are read-only and can't be brought back. The seller's stock history stays for the record."
        confirmLabel="Archive"
        pending={pending}
      />
    </div>
  );
}
