"use client";

import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import { createSellerAction, type SellerAdminActionState } from "@/lib/admin/sellers/actions";
import { FormField, notify, usePersistentAction } from "@/components/admin/ui";

export function CreateSellerForm({ defaultCommissionBps }: { defaultCommissionBps: number }) {
  const { state, onSubmit, pending } = usePersistentAction<SellerAdminActionState>(createSellerAction, {});

  useEffect(() => {
    if (state.error) notify.error(state.error);
  }, [state]);

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <FormField label="Display name" htmlFor="displayName" required hint="Customer-facing “Sold by …” name.">
        <input id="displayName" name="displayName" required minLength={2} maxLength={80} className="field text-sm" />
      </FormField>
      <FormField label="Slug" htmlFor="slug" required hint="Lowercase, dashes. Reserved for a future /store/<slug> page.">
        <input id="slug" name="slug" required minLength={3} maxLength={40} className="field text-sm" placeholder="acme-supplies" />
      </FormField>
      <FormField label="Support email" htmlFor="supportEmail" required hint="Customer contact for this seller's orders.">
        <input id="supportEmail" name="supportEmail" type="email" required className="field text-sm" />
      </FormField>
      <FormField label="Commission (basis points)" htmlFor="commissionRate" hint="1500 = 15.00%. 0–10000. Stored only — no settlement in this phase.">
        <input
          id="commissionRate"
          name="commissionRate"
          type="number"
          min={0}
          max={10000}
          defaultValue={defaultCommissionBps}
          className="field text-sm"
        />
      </FormField>

      {state.error && <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>}

      <div className="border-t border-line pt-4">
        <button type="submit" disabled={pending} className="btn btn-primary py-2 text-sm">
          {pending && <Loader2 size={14} className="animate-spin" />}
          Create seller
        </button>
      </div>
    </form>
  );
}
