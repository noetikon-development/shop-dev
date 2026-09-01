"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Loader2, ShieldCheck } from "lucide-react";
import { Logo } from "@/components/logo";
import { adminLogin, type AdminLoginState } from "@/lib/admin/actions";

export function AdminLoginForm() {
  const [state, formAction, pending] = useActionState<AdminLoginState, FormData>(
    adminLogin,
    {},
  );

  return (
    <div className="w-full max-w-sm">
      <div className="flex items-center gap-2">
        <Logo className="h-9" />
        <span className="inline-flex items-center gap-1 rounded-xs bg-ink px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-paper">
          <ShieldCheck size={11} /> Admin
        </span>
      </div>

      <h1 className="mt-8 text-2xl">Administrator sign in</h1>
      <p className="mt-1.5 text-sm text-ink-soft">
        Restricted area. Use your Axiaro account — access depends on your assigned role.
      </p>

      <form action={formAction} className="mt-7 space-y-4">
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

      <p className="mt-6 text-center text-xs text-ink-faint">
        Not an administrator?{" "}
        <Link href="/login" className="underline hover:text-ink">
          Customer sign in
        </Link>
      </p>
    </div>
  );
}
