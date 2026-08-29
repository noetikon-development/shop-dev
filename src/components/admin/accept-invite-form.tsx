"use client";

import { useActionState, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Check } from "lucide-react";
import { setInitialPassword, type AcceptState } from "@/lib/admin/actions";

export function AcceptInviteForm() {
  const [state, formAction, pending] = useActionState<AcceptState, FormData>(
    setInitialPassword,
    {},
  );
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (state.ok) setDone(true);
  }, [state.ok]);

  if (done) {
    return (
      <div className="mt-7 rounded-sm border border-line bg-surface p-4 text-center">
        <p className="inline-flex items-center gap-1.5 text-sm font-medium text-success">
          <Check size={15} /> Password set
        </p>
        <p className="mt-1 text-sm text-ink-soft">Your account is ready.</p>
        <Link href="/admin" className="btn btn-primary mt-4 w-full">
          Go to the dashboard
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} className="mt-7 space-y-4">
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">New password</span>
        <input
          type="password"
          name="password"
          required
          minLength={8}
          autoComplete="new-password"
          className="field"
        />
        <span className="mt-1 block text-xs text-ink-faint">At least 8 characters.</span>
      </label>
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">Confirm password</span>
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

      <button type="submit" disabled={pending} className="btn btn-primary w-full">
        {pending && <Loader2 size={15} className="animate-spin" />}
        Set password
      </button>
    </form>
  );
}
