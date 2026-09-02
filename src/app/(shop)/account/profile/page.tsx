import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { ProfileForm } from "@/components/account/profile-form";
import { ChangeEmailForm } from "@/components/account/change-email-form";

export const metadata: Metadata = { title: "Profile" };

export default async function ProfilePage() {
  const user = await requireUser("/account/profile");

  return (
    <div className="space-y-8">
      <div className="space-y-5">
        <div>
          <h2 className="text-subtitle">Profile</h2>
          <p className="mt-1 text-sm text-ink-soft">Your name and contact details.</p>
        </div>
        <ProfileForm name={user.name ?? ""} phone={user.phone ?? ""} />
      </div>

      <div className="space-y-5 border-t border-line pt-8">
        <div>
          <h2 className="text-subtitle">Account email</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Used for sign-in, order updates and security notices.
          </p>
        </div>
        <ChangeEmailForm currentEmail={user.email} />
      </div>
    </div>
  );
}
