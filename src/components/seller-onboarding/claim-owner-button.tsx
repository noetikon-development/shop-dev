"use client";

import { useActionState } from "react";
import Link from "next/link";
import {
  claimSellerOwnerInviteAction,
  type ClaimSellerOwnerInviteActionState,
} from "@/lib/seller-onboarding/actions";
import { Button, buttonClasses } from "@/components/ui/button";

/**
 * Renders only when the status page has already determined (server-side, via
 * `getSellerApplicationStatus`) that a PENDING invite exists for this
 * applicant's approved Seller. This component itself sends no id of any
 * kind — the form has no fields — so there's nothing for a client to spoof.
 */
export function ClaimOwnerButton() {
  const [state, formAction, pending] = useActionState<ClaimSellerOwnerInviteActionState, FormData>(
    claimSellerOwnerInviteAction,
    {},
  );

  if (state.ok) {
    return (
      <div className="mt-4 space-y-2">
        <p className="text-sm text-ink-soft">
          {state.code === "ALREADY_CLAIMED"
            ? "Your seller account is already activated."
            : "Your seller account is now active."}
        </p>
        <Link href="/seller" className={buttonClasses()}>
          Go to Seller Portal
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} className="mt-4">
      <Button type="submit" loading={pending}>
        Activate your seller account
      </Button>
      {state.error && <p className="mt-2 text-sm text-clay">{state.error}</p>}
    </form>
  );
}
