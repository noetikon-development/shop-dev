"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { changeEmail, type EmailChangeState } from "@/lib/auth-actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";

export function ChangeEmailForm({ currentEmail }: { currentEmail: string }) {
  // `attempt` remounts the inner form so a fresh <useActionState> is created
  // each time the panel is opened — avoids reusing a stale success/error state.
  const [attempt, setAttempt] = useState<number | null>(null);

  return (
    <div className="max-w-md space-y-3">
      <Field label="Email">
        {(control) => (
          <input
            {...control}
            value={currentEmail}
            disabled
            className="field bg-surface-sunken text-ink-faint"
          />
        )}
      </Field>

      {attempt === null ? (
        <Button variant="outline" size="sm" onClick={() => setAttempt(Date.now())}>
          Change email
        </Button>
      ) : (
        <EmailChangePanel key={attempt} onClose={() => setAttempt(null)} />
      )}
    </div>
  );
}

function EmailChangePanel({ onClose }: { onClose: () => void }) {
  const [state, formAction, pending] = useActionState<EmailChangeState, FormData>(changeEmail, {});
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) {
      toast.success("Confirmation links sent — check both inboxes");
      ref.current?.reset();
    }
  }, [state.ok]);

  if (state.ok) {
    return (
      <div className="space-y-3 rounded-md border border-line bg-surface p-4">
        <p className="flex items-start gap-2 text-sm text-ink">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-sage" />
          <span>
            We&apos;ve sent a confirmation link to your current address and the new one. Your email
            changes only after both are confirmed.
          </span>
        </p>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Done
        </Button>
      </div>
    );
  }

  return (
    <form ref={ref} action={formAction} className="space-y-3 rounded-md border border-line bg-surface p-4">
      <Field
        label="New email address"
        hint="We'll send a confirmation link to your current address and the new one. The change takes effect only after both are confirmed."
        type="email"
        name="newEmail"
        required
        autoComplete="email"
        placeholder="you@example.com"
      />

      {state.error && (
        <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>
      )}

      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={pending}>
          Send confirmation
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
