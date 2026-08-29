"use client";

import { useActionState, useEffect } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { registerUser, type RegisterState } from "@/lib/actions";

export function RegisterForm() {
  const router = useRouter();
  const params = useSearchParams();
  const redirectTo = params.get("redirectTo") || "/account";
  const [state, formAction, pending] = useActionState<RegisterState, FormData>(registerUser, {});

  useEffect(() => {
    if (!state.ok) return;
    const form = document.getElementById("register-form") as HTMLFormElement | null;
    const email = (form?.elements.namedItem("email") as HTMLInputElement)?.value;
    const password = (form?.elements.namedItem("password") as HTMLInputElement)?.value;
    toast.success("Account created — signing you in");
    signIn("credentials", { email, password, redirectTo }).catch(() => router.push("/login"));
  }, [state.ok, redirectTo, router]);

  return (
    <div>
      <h1 className="text-2xl">Create your account</h1>
      <p className="mt-1.5 text-sm text-ink-soft">
        Save your details, track orders, and keep a wishlist.
      </p>

      <form id="register-form" action={formAction} className="mt-7 space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Full name</span>
          <input type="text" name="name" required autoComplete="name" className="field" />
          {state.fieldErrors?.name && (
            <span className="mt-1 block text-xs text-clay">{state.fieldErrors.name}</span>
          )}
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Email</span>
          <input type="email" name="email" required autoComplete="email" className="field" />
          {state.fieldErrors?.email && (
            <span className="mt-1 block text-xs text-clay">{state.fieldErrors.email}</span>
          )}
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Password</span>
          <input
            type="password"
            name="password"
            required
            minLength={8}
            autoComplete="new-password"
            className="field"
          />
          {state.fieldErrors?.password ? (
            <span className="mt-1 block text-xs text-clay">{state.fieldErrors.password}</span>
          ) : (
            <span className="mt-1 block text-xs text-ink-faint">At least 8 characters.</span>
          )}
        </label>

        {state.error && (
          <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>
        )}

        <button type="submit" disabled={pending || state.ok} className="btn btn-primary w-full">
          {(pending || state.ok) && <Loader2 size={15} className="animate-spin" />}
          Create account
        </button>
        <p className="text-center text-xs text-ink-faint">
          By continuing you agree to our{" "}
          <Link href="/legal/terms" className="underline">
            Terms
          </Link>{" "}
          and{" "}
          <Link href="/legal/privacy" className="underline">
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
