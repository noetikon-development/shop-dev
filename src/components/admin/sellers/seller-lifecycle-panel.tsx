"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { transitionSellerAction, type SellerAdminActionState } from "@/lib/admin/sellers/actions";
import { sellerStatusLabel } from "@/lib/admin/sellers/lifecycle";
import { notify, usePersistentAction, ConfirmDialog } from "@/components/admin/ui";

const VERB: Record<string, string> = { APPROVED: "Approve", SUSPENDED: "Suspend", CLOSED: "Close" };

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

  return (
    <div className="space-y-2">
      <p className="text-xs text-ink-faint">Currently {sellerStatusLabel(status).toLowerCase()}.</p>
      {allowed.map((to) => {
        const danger = to === "CLOSED" || to === "SUSPENDED";
        return (
          <button
            key={to}
            type="button"
            disabled={pending}
            onClick={() => setConfirmTo(to)}
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
          setConfirmTo(null);
          if (!to) return;
          const fd = new FormData();
          fd.set("sellerId", sellerId);
          fd.set("to", to);
          dispatch(fd);
        }}
        title={confirmTo ? `${label(confirmTo)} this seller?` : ""}
        message={
          confirmTo === "CLOSED"
            ? "Closing is intended to be permanent — the seller keeps its data and history but cannot be reactivated."
            : confirmTo === "SUSPENDED"
              ? "Marks the seller paused Axiaro-side."
              : "The seller becomes approved and its members can use the portal."
        }
        confirmLabel={confirmTo ? label(confirmTo) : "Confirm"}
        pending={pending}
      />
    </div>
  );
}
