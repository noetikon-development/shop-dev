"use client";

import { useActionState, useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { changePassword, type PasswordState } from "@/lib/auth-actions";

export function ChangePasswordForm() {
  const [state, formAction, pending] = useActionState<PasswordState, FormData>(changePassword, {});
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) {
      toast.success("Password changed");
      ref.current?.reset();
    }
  }, [state.ok]);

  return (
    <form ref={ref} action={formAction} className="max-w-md space-y-4">
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">Current password</span>
        <input
          type="password"
          name="currentPassword"
          required
          autoComplete="current-password"
          className="field"
        />
      </label>
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">New password</span>
        <input
          type="password"
          name="newPassword"
          required
          minLength={8}
          autoComplete="new-password"
          className="field"
        />
        <span className="mt-1 block text-xs text-ink-faint">At least 8 characters.</span>
      </label>
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">Confirm new password</span>
        <input
          type="password"
          name="confirm"
          required
          minLength={8}
          autoComplete="new-password"
          className="field"
        />
      </label>

      {state.error && (
        <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>
      )}

      <button type="submit" disabled={pending} className="btn btn-primary">
        {pending && <Loader2 size={15} className="animate-spin" />}
        Update password
      </button>
    </form>
  );
}
