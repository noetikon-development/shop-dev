"use client";

import { useActionState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { MailCheck } from "lucide-react";
import { registerUser, type RegisterState } from "@/lib/auth-actions";
import { Button, buttonClasses } from "@/components/ui/button";
import { Field } from "@/components/ui/field";

export function RegisterForm() {
  const params = useSearchParams();
  const redirectTo = params.get("redirectTo") || "/account";
  const [state, formAction, pending] = useActionState<RegisterState, FormData>(registerUser, {});

  if (state.ok) {
    return (
      <div className="text-center">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-sage-50">
          <MailCheck size={24} className="text-sage" />
        </div>
        <h1 className="mt-5 text-title">Confirm your email</h1>
        <p className="mt-2 text-sm text-ink-soft">
          We&apos;ve sent a confirmation link to your inbox. Open it to activate your account, then
          sign in. The link expires in 24 hours.
        </p>
        <p className="mt-2 text-meta text-ink-faint">
          Didn&apos;t get it? Check your spam folder, or sign in to resend it.
        </p>
        <Link href="/login" className={buttonClasses({ className: "mt-6 w-full" })}>
          Go to sign in
        </Link>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-title">Create your Axiaro account</h1>
      <p className="mt-1.5 text-sm text-ink-soft">
        Track orders, save addresses and keep a wishlist.
      </p>

      <form id="register-form" action={formAction} className="mt-7 space-y-4">
        <Field
          label="Full name"
          type="text"
          name="name"
          required
          autoComplete="name"
          error={state.fieldErrors?.name}
        />
        <Field
          label="Email"
          type="email"
          name="email"
          required
          autoComplete="email"
          error={state.fieldErrors?.email}
        />
        <Field
          label="Password"
          hint="At least 8 characters."
          error={state.fieldErrors?.password}
          type="password"
          name="password"
          required
          minLength={8}
          autoComplete="new-password"
        />

        {state.error && (
          <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>
        )}

        <Button type="submit" loading={pending} className="w-full">
          Create account
        </Button>
        <p className="text-center text-meta text-ink-faint">
          By continuing you agree to our{" "}
          <Link href="/pages/terms" className="underline">
            Terms
          </Link>{" "}
          and{" "}
          <Link href="/pages/privacy" className="underline">
            Privacy Policy
          </Link>
          .
        </p>
      </form>

      <p className="mt-6 text-center text-sm text-ink-soft">
        Already have an account?{" "}
        <Link
          href={`/login${redirectTo ? `?redirectTo=${encodeURIComponent(redirectTo)}` : ""}`}
          className="font-medium text-ink underline underline-offset-4"
        >
          Sign in
        </Link>
      </p>
    </div>
  );
}
