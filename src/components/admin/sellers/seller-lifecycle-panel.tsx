"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { transitionSellerAction, type SellerAdminActionState } from "@/lib/admin/sellers/actions";
import { sellerStatusLabel } from "@/lib/admin/sellers/lifecycle";
import { notify, usePersistentAction, ConfirmDialog } from "@/components/admin/ui";

const VERB: Record<string, string> = {
  APPROVED: "Approve",
  SUSPENDED: "Suspend",
  CLOSED: "Close",
  REJECTED: "Reject",
  PENDING: "Reopen",
};
/** 9F-56 — these two transitions require a non-empty reason (enforced again,
 *  independently, at the action layer — this is just so the button isn't a
 *  guaranteed-to-fail dead end). */
const REASON_REQUIRED = new Set(["REJECTED", "PENDING"]);

export function SellerLifecyclePanel({
  sellerId,
  status,
  allowed,
}: {
  sellerId: string;
  status: string;
  allowed: string[];
}) {
  const { state, dispatch, pending } = usePersistentAction<SellerAdminActionState>(transitionSellerAction, {});
  const [confirmTo, setConfirmTo] = useState<string | null>(null);
  const [reasonDraft, setReasonDraft] = useState("");

  useEffect(() => {
    if (state.ok && state.message) notify.success(state.message);
    if (state.error) notify.error(state.error);
  }, [state]);

  if (allowed.length === 0) {
    return (
      <p className="text-sm text-ink-soft">
        This seller is {sellerStatusLabel(status).toLowerCase()} — no further transitions.
      </p>
    );
  }

  const label = (to: string) =>
    to === "APPROVED" && status === "SUSPENDED" ? "Reactivate" : VERB[to] ?? to;
  const reasonRequired = confirmTo !== null && REASON_REQUIRED.has(confirmTo);
  const canConfirm = !reasonRequired || reasonDraft.trim().length > 0;

  return (
    <div className="space-y-2">
      <p className="text-xs text-ink-faint">Currently {sellerStatusLabel(status).toLowerCase()}.</p>
      {allowed.map((to) => {
        const danger = to === "CLOSED" || to === "SUSPENDED" || to === "REJECTED";
        return (
          <button
            key={to}
            type="button"
            disabled={pending}
            onClick={() => {
              setReasonDraft("");
              setConfirmTo(to);
            }}
            className={`btn ${danger ? "btn-ghost text-clay" : "btn-primary"} w-full justify-start py-2 text-sm`}
          >
            {pending && <Loader2 size={14} className="animate-spin" />}
            {label(to)} → {sellerStatusLabel(to)}
          </button>
        );
      })}

      <ConfirmDialog
        open={confirmTo !== null}
        onClose={() => setConfirmTo(null)}
        onConfirm={() => {
          const to = confirmTo;
          const reason = reasonDraft.trim();
          if (!to || (REASON_REQUIRED.has(to) && !reason)) return;
          setConfirmTo(null);
          const fd = new FormData();
          fd.set("sellerId", sellerId);
          fd.set("to", to);
          if (reason) fd.set("reason", reason);
          dispatch(fd);
        }}
        title={confirmTo ? `${label(confirmTo)} this seller?` : ""}
        message={
          <div className="space-y-3">
            <p>
              {confirmTo === "CLOSED"
                ? "Closing is intended to be permanent — the seller keeps its data and history but cannot be reactivated."
                : confirmTo === "SUSPENDED"
                  ? "Marks the seller paused Axiaro-side."
                  : confirmTo === "REJECTED"
                    ? "The applicant will be emailed the reason below. This can be reopened later if needed."
                    : confirmTo === "PENDING"
                      ? "The applicant will be emailed the note below and their application goes back under review."
                      : "The seller becomes approved and its members can use the portal."}
            </p>
            {reasonRequired && (
              <div className="space-y-1">
                <label htmlFor="seller-transition-reason" className="text-xs font-medium text-ink-soft">
                  {confirmTo === "REJECTED" ? "Reason (sent to the applicant)" : "Note (sent to the applicant)"}
                </label>
                <textarea
                  id="seller-transition-reason"
                  value={reasonDraft}
                  onChange={(e) => setReasonDraft(e.target.value)}
                  rows={3}
                  maxLength={2000}
                  className="input w-full text-sm"
                  placeholder={confirmTo === "REJECTED" ? "Why this application isn't being approved…" : "What changed / what to expect…"}
                />
              </div>
            )}
          </div>
        }
        confirmLabel={confirmTo ? label(confirmTo) : "Confirm"}
        pending={pending || !canConfirm}
      />
    </div>
  );
}
