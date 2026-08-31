"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Loader2, Check } from "lucide-react";
import { login, resendVerification, type LoginState } from "@/lib/auth-actions";

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
      <p className="mt-1.5 text-sm text-ink-soft">Sign in to your AXIARO account.</p>

      <form action={formAction} className="mt-7 space-y-4">
        <input type="hidden" name="redirectTo" value={redirectTo} />
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Email</span>
          <input
            type="email"
            name="email"
            required
            autoComplete="email"
            className="field"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 flex items-center justify-between text-sm font-medium">
            Password
            <Link
              href="/forgot-password"
              className="text-xs font-normal text-ink-soft underline underline-offset-2 hover:text-ink"
            >
              Forgot password?
            </Link>
          </span>
          <input
            type="password"
            name="password"
            required
            autoComplete="current-password"
            className="field"
          />
        </label>

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

        <button type="submit" disabled={pending} className="btn btn-primary w-full">
          {pending && <Loader2 size={15} className="animate-spin" />}
          Sign in
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-ink-soft">
        New to AXIARO?{" "}
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
