import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { ChangePasswordForm } from "@/components/account/change-password-form";

export const metadata: Metadata = { title: "Change password" };

export default async function AccountPasswordPage() {
  await requireUser("/account/password");

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg">Change password</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Enter your current password, then choose a new one.
        </p>
      </div>
      <ChangePasswordForm />
    </div>
  );
}
