"use client";

import { useActionState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { authenticate, type LoginState } from "@/lib/actions";

export function LoginForm() {
  const params = useSearchParams();
  const redirectTo = params.get("redirectTo") || "/account";
  const [state, formAction, pending] = useActionState<LoginState, FormData>(authenticate, {});

  return (
    <div>
      <h1 className="text-2xl">Welcome back</h1>
      <p className="mt-1.5 text-sm text-ink-soft">Sign in to your AXIARO account.</p>

      <form action={formAction} className="mt-7 space-y-4">
        <input type="hidden" name="redirectTo" value={redirectTo} />
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Email</span>
          <input type="email" name="email" required autoComplete="email" className="field" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Password</span>
          <input
            type="password"
            name="password"
            required
            autoComplete="current-password"
            className="field"
          />
        </label>

        {state.error && (
          <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>
        )}

        <button type="submit" disabled={pending} className="btn btn-primary w-full">
          {pending && <Loader2 size={15} className="animate-spin" />}
          Sign in
        </button>
      </form>

      <div className="mt-5 rounded-sm border border-line bg-surface p-3 text-xs text-ink-soft">
        <p className="font-medium text-ink">Demo account</p>
        <p className="mt-1">demo@axiaro.test · password123</p>
      </div>

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
