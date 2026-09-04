"use client";

import { useSyncExternalStore } from "react";
import { CheckCircle2, X } from "lucide-react";

/**
 * Phase 9F-5c Part 12 — a one-time "your seller account is approved" note on the
 * seller dashboard. Dismiss state is a per-browser localStorage flag (no schema).
 *
 * The portal is only reachable by an APPROVED seller (requireSellerSession gates
 * every seller route on Seller.status === "APPROVED" + an ACTIVE membership), so
 * a SUSPENDED / CLOSED seller never renders this.
 *
 * Copy deliberately stops at "prepare your listings" — it must not imply the
 * storefront shows seller offers, because marketplace.multiSellerCheckout is off.
 */

const KEY = "axr_seller_approved_ack_dismissed";

const listeners = new Set<() => void>();
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function isDismissed(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}
/** SSR / first paint: treat as dismissed so a previously-dismissed banner never flashes. */
function isDismissedServer(): boolean {
  return true;
}

export function SellerApprovedBanner({ sellerName }: { sellerName: string }) {
  const dismissed = useSyncExternalStore(subscribe, isDismissed, isDismissedServer);
  if (dismissed) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      /* private mode — the banner just reappears next load */
    }
    listeners.forEach((l) => l());
  };

  return (
    <div className="mb-6 flex items-start gap-3 rounded-md border border-sage/40 bg-sage-50 px-4 py-3 text-sm">
      <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-sage" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-ink">Your {sellerName} seller account is approved and ready.</p>
        <p className="mt-0.5 text-ink-soft">
          You can now prepare your product listings on Axiaro — set them up as drafts and manage your
          stock. Axiaro will let you know when customer checkout opens for sellers.
        </p>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="btn btn-ghost -mr-1 shrink-0 px-1.5 py-1.5 text-ink-faint"
      >
        <X size={15} />
      </button>
    </div>
  );
}
