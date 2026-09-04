"use client";

import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import { saveSellerContactAction, type SellerSettingsActionState } from "@/lib/seller/settings-actions";
import { FormField, notify, usePersistentAction } from "@/components/seller/ui";

export function ContactSettingsForm({
  supportEmail,
  notifyEmail,
}: {
  supportEmail: string;
  notifyEmail: string | null;
}) {
  const { state, onSubmit, pending } = usePersistentAction<SellerSettingsActionState>(
    saveSellerContactAction,
    {},
  );

  useEffect(() => {
    if (state.ok && state.message) notify.success(state.message);
    if (state.error) notify.error(state.error);
  }, [state]);

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Support email" htmlFor="supportEmail" required hint="Shown to customers on your orders.">
          <input
            id="supportEmail"
            name="supportEmail"
            type="email"
            required
            defaultValue={supportEmail}
            className="field text-sm"
          />
        </FormField>
        <FormField label="Notification email" htmlFor="notifyEmail" hint="Where Axiaro emails you. Blank = use your support email.">
          <input
            id="notifyEmail"
            name="notifyEmail"
            type="email"
            defaultValue={notifyEmail ?? ""}
            className="field text-sm"
          />
        </FormField>
      </div>

      {state.error && <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>}

      <div className="border-t border-line pt-4">
        <button type="submit" disabled={pending} className="btn btn-primary py-2 text-sm">
          {pending && <Loader2 size={14} className="animate-spin" />}
          Save contact settings
        </button>
      </div>
    </form>
  );
}
