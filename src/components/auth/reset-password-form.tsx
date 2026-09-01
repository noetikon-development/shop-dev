"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import { resetPassword, type PasswordState } from "@/lib/auth-actions";
import { Button, buttonClasses } from "@/components/ui/button";
import { Field } from "@/components/ui/field";

export function ResetPasswordForm() {
  const [state, formAction, pending] = useActionState<PasswordState, FormData>(resetPassword, {});

  if (state.ok) {
    return (
      <div className="text-center">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-sage-50">
          <Check size={24} className="text-sage" />
        </div>
        <h1 className="mt-5 text-2xl">Password updated</h1>
        <p className="mt-2 text-sm text-ink-soft">
          You can now sign in with your new password.
        </p>
        <Link href="/login" className={buttonClasses({ className: "mt-6 w-full" })}>
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl">Choose a new password</h1>
      <p className="mt-1.5 text-sm text-ink-soft">Enter it twice to confirm.</p>

      <form action={formAction} className="mt-7 space-y-4">
        <Field
          label="New password"
          hint="At least 8 characters."
          type="password"
          name="password"
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

        <Button type="submit" loading={pending} className="w-full">
          Update password
        </Button>
      </form>
    </div>
  );
}
