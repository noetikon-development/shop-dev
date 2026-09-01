"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Check } from "lucide-react";
import { login, resendVerification, type LoginState } from "@/lib/auth-actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";

export function LoginForm() {
  const params = useSearchParams();
  const redirectTo = params.get("redirectTo") || "/account";
  const linkError = params.get("error");
  const [state, formAction, pending] = useActionState<LoginState, FormData>(login, {});
  const [email, setEmail] = useState("");
  const [resent, setResent] = useState(false);
  const shownError = state.error ?? linkError ?? undefined;

  return (
    <div>
      <h1 className="text-2xl">Welcome back</h1>
      <p className="mt-1.5 text-sm text-ink-soft">Sign in to your Axiaro account.</p>

      <form action={formAction} className="mt-7 space-y-4">
        <input type="hidden" name="redirectTo" value={redirectTo} />
        <Field
          label="Email"
          type="email"
          name="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Field
          label={
            <span className="flex items-center justify-between">
              Password
              <Link
                href="/forgot-password"
                className="text-xs font-normal text-ink-soft underline underline-offset-2 hover:text-ink"
              >
                Forgot password?
              </Link>
            </span>
          }
          type="password"
          name="password"
          required
          autoComplete="current-password"
        />

        {shownError && (
          <div className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">
            <p>{shownError}</p>
            {state.needsVerification && !resent && (
              <button
                type="button"
                onClick={async () => {
                  await resendVerification(email);
                  setResent(true);
                }}
                className="mt-1 font-medium underline underline-offset-2"
              >
                Resend the verification email
              </button>
            )}
            {resent && (
              <p className="mt-1 inline-flex items-center gap-1 font-medium text-success">
                <Check size={13} /> Verification email sent.
              </p>
            )}
          </div>
        )}

        <Button type="submit" loading={pending} className="w-full">
          Sign in
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-ink-soft">
        New to Axiaro?{" "}
        <Link
          href={`/register${redirectTo ? `?redirectTo=${encodeURIComponent(redirectTo)}` : ""}`}
          className="font-medium text-ink underline underline-offset-4"
        >
          Create an account
        </Link>
      </p>
    </div>
  );
}
