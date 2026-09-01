"use client";

import { useActionState } from "react";
import Link from "next/link";
import { MailCheck } from "lucide-react";
import { requestPasswordReset, type ForgotState } from "@/lib/auth-actions";
import { Button, buttonClasses } from "@/components/ui/button";
import { Field } from "@/components/ui/field";

export function ForgotPasswordForm() {
  const [state, formAction, pending] = useActionState<ForgotState, FormData>(
    requestPasswordReset,
    {},
  );

  if (state.ok) {
    return (
      <div className="text-center">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-sage-50">
          <MailCheck size={24} className="text-sage" />
        </div>
        <h1 className="mt-5 text-2xl">Check your email</h1>
        <p className="mt-2 text-sm text-ink-soft">
          If an account exists for that address, we&apos;ve sent a link to reset your password. It
          expires in one hour.
        </p>
        <Link
          href="/login"
          className={buttonClasses({ variant: "outline", className: "mt-6 w-full" })}
        >
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl">Reset your password</h1>
      <p className="mt-1.5 text-sm text-ink-soft">
        Enter your email and we&apos;ll send you a secure reset link.
      </p>

      <form action={formAction} className="mt-7 space-y-4">
        <Field label="Email" type="email" name="email" required autoComplete="email" />

        {state.error && (
          <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>
        )}

        <Button type="submit" loading={pending} className="w-full">
          Send reset link
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-ink-soft">
        Remembered it?{" "}
        <Link href="/login" className="font-medium text-ink underline underline-offset-4">
          Sign in
        </Link>
      </p>
    </div>
  );
}
