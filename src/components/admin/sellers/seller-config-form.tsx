"use client";

import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import { updateSellerConfigAction, type SellerAdminActionState } from "@/lib/admin/sellers/actions";
import { FormField, notify, usePersistentAction } from "@/components/admin/ui";

export function SellerConfigForm({
  sellerId,
  displayName,
  slug,
  supportEmail,
  notifyEmail,
  commissionRate,
}: {
  sellerId: string;
  displayName: string;
  slug: string;
  supportEmail: string;
  notifyEmail: string | null;
  commissionRate: number;
}) {
  const { state, onSubmit, pending } = usePersistentAction<SellerAdminActionState>(updateSellerConfigAction, {});

  useEffect(() => {
    if (state.ok && state.message) notify.success(state.message);
    if (state.error) notify.error(state.error);
  }, [state]);

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <input type="hidden" name="sellerId" value={sellerId} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Display name" htmlFor="cfg-displayName" required>
          <input id="cfg-displayName" name="displayName" defaultValue={displayName} minLength={2} maxLength={80} className="field text-sm" />
        </FormField>
        <FormField label="Slug" htmlFor="cfg-slug" required hint="Canonical — admin-owned.">
          <input id="cfg-slug" name="slug" defaultValue={slug} minLength={3} maxLength={40} className="field text-sm" />
        </FormField>
        <FormField label="Support email" htmlFor="cfg-supportEmail" required>
          <input id="cfg-supportEmail" name="supportEmail" type="email" defaultValue={supportEmail} className="field text-sm" />
        </FormField>
        <FormField label="Notification email" htmlFor="cfg-notifyEmail" hint="Blank = use support email.">
          <input id="cfg-notifyEmail" name="notifyEmail" type="email" defaultValue={notifyEmail ?? ""} className="field text-sm" />
        </FormField>
        <FormField label="Commission (bps)" htmlFor="cfg-commission" hint={`${(commissionRate / 100).toFixed(2)}% now. 0–10000.`}>
          <input id="cfg-commission" name="commissionRate" type="number" min={0} max={10000} defaultValue={commissionRate} className="field text-sm" />
        </FormField>
      </div>

      {state.error && <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>}

      <div className="border-t border-line pt-4">
        <button type="submit" disabled={pending} className="btn btn-primary py-2 text-sm">
          {pending && <Loader2 size={14} className="animate-spin" />}
          Save
        </button>
      </div>
    </form>
  );
}
