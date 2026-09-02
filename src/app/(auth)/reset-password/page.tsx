import type { Metadata } from "next";
import Link from "next/link";
import { getSupabaseUser } from "@/lib/auth";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { buttonClasses } from "@/components/ui/button";

export const metadata: Metadata = { title: "Set a new password" };
export const dynamic = "force-dynamic";

export default async function ResetPasswordPage() {
  // Arriving here means the recovery link exchanged a short-lived session via
  // /auth/callback. If there's no session, the link was invalid or expired.
  const user = await getSupabaseUser();

  if (!user) {
    return (
      <div className="text-center">
        <h1 className="text-title">This link has expired</h1>
        <p className="mt-2 text-sm text-ink-soft">
          Password reset links are valid for one hour. Request a fresh one.
        </p>
        <Link
          href="/forgot-password"
          className={buttonClasses({ className: "mt-6 w-full" })}
        >
          Request a new link
        </Link>
      </div>
    );
  }

  return <ResetPasswordForm />;
}
