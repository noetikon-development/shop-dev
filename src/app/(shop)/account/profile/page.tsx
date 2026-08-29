import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { ProfileForm } from "@/components/account/profile-form";

export const metadata: Metadata = { title: "Profile" };

export default async function ProfilePage() {
  const user = await requireUser("/account/profile");

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg">Profile</h2>
        <p className="mt-1 text-sm text-ink-soft">Your name and contact details.</p>
      </div>
      <ProfileForm
        name={user.name ?? ""}
        phone={user.phone ?? ""}
        email={user.email}
      />
    </div>
  );
}
