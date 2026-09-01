"use client";

import { useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";
import { changePassword, type PasswordState } from "@/lib/auth-actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";

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
      <Field
        label="Current password"
        type="password"
        name="currentPassword"
        required
        autoComplete="current-password"
      />
      <Field
        label="New password"
        hint="At least 8 characters."
        type="password"
        name="newPassword"
        required
        minLength={8}
        autoComplete="new-password"
      />
      <Field
        label="Confirm new password"
        type="password"
        name="confirm"
        required
        minLength={8}
        autoComplete="new-password"
      />

      {state.error && (
        <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>
      )}

      <Button type="submit" loading={pending}>
        Update password
      </Button>
    </form>
  );
}
