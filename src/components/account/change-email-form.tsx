"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Loader2, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { changeEmail, type EmailChangeState } from "@/lib/auth-actions";

export function ChangeEmailForm({ currentEmail }: { currentEmail: string }) {
  // `attempt` remounts the inner form so a fresh <useActionState> is created
  // each time the panel is opened — avoids reusing a stale success/error state.
  const [attempt, setAttempt] = useState<number | null>(null);

  return (
    <div className="max-w-md space-y-3">
      <div>
        <span className="mb-1.5 block text-sm font-medium">Email</span>
        <input
          value={currentEmail}
          disabled
          className="field bg-surface-sunken text-ink-faint"
          aria-label="Current account email"
        />
      </div>

      {attempt === null ? (
        <button type="button" onClick={() => setAttempt(Date.now())} className="btn btn-outline text-sm">
          Change email
        </button>
      ) : (
        <EmailChangePanel key={attempt} onClose={() => setAttempt(null)} />
      )}
    </div>
  );
}

function EmailChangePanel({ onClose }: { onClose: () => void }) {
  const [state, formAction, pending] = useActionState<EmailChangeState, FormData>(changeEmail, {});
  const ref = useRef<HTMLFormElement>(null);

  // Side effects only — no state updates in this effect.
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
        <button type="button" onClick={onClose} className="btn btn-ghost text-sm">
          Done
        </button>
      </div>
    );
  }

  return (
    <form ref={ref} action={formAction} className="space-y-3 rounded-md border border-line bg-surface p-4">
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">New email address</span>
        <input
          type="email"
          name="newEmail"
          required
          autoComplete="email"
          className="field"
          placeholder="you@example.com"
        />
        <span className="mt-1 block text-xs text-ink-faint">
          We&apos;ll send a confirmation link to your current address and the new one. The change
          takes effect only after both are confirmed.
        </span>
      </label>

      {state.error && (
        <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>
      )}

      <div className="flex gap-2">
        <button type="submit" disabled={pending} className="btn btn-primary text-sm">
          {pending && <Loader2 size={15} className="animate-spin" />}
          Send confirmation
        </button>
        <button type="button" onClick={onClose} className="btn btn-ghost text-sm">
          Cancel
        </button>
      </div>
    </form>
  );
}
