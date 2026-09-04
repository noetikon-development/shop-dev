"use client";

import { useActionState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Loader2, Store } from "lucide-react";
import { Logo } from "@/components/logo";
import { Field } from "@/components/ui/field";
import { sellerLogin, type SellerLoginState } from "@/lib/seller/auth-actions";

export function SellerLoginForm() {
  const params = useSearchParams();
  const redirectTo = params.get("redirectTo") ?? "/seller";
  const [state, formAction, pending] = useActionState<SellerLoginState, FormData>(sellerLogin, {});

  return (
    <div className="w-full max-w-sm">
      <div className="flex items-center gap-2">
        <Logo className="h-9" />
        <span className="inline-flex items-center gap-1 rounded-xs bg-ink px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-paper">
          <Store size={11} /> Seller
        </span>
      </div>

      <h1 className="mt-8 text-2xl">Seller sign in</h1>
      <p className="mt-1.5 text-sm text-ink-soft">
        For approved Axiaro sellers. Use the Axiaro account linked to your seller.
      </p>

      <form action={formAction} className="mt-7 space-y-4">
        <input type="hidden" name="redirectTo" value={redirectTo} />
        <Field label="Email" type="email" name="email" required autoComplete="email" />
        <Field
          label="Password"
          type="password"
          name="password"
          required
          autoComplete="current-password"
        />

        <div className="text-right">
          <Link href="/forgot-password?next=/seller/login" className="text-xs text-ink-soft underline hover:text-ink">
            Forgot password?
          </Link>
        </div>

        {state.error && (
          <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>
        )}

        <button type="submit" disabled={pending} className="btn btn-primary w-full">
          {pending && <Loader2 size={15} className="animate-spin" />}
          Sign in
        </button>
      </form>

      <p className="mt-6 text-center text-xs text-ink-faint">
        Shopping instead?{" "}
        <Link href="/login" className="underline hover:text-ink">
          Customer sign in
        </Link>
      </p>
    </div>
  );
}
