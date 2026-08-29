import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseUser } from "@/lib/auth";
import { getCurrentAdmin } from "@/lib/admin/rbac";
import { AcceptInviteForm } from "@/components/admin/accept-invite-form";

export const metadata: Metadata = { title: "Finish setup" };

export default async function AdminAcceptPage() {
  const sbUser = await getSupabaseUser();
  if (!sbUser) {
    // No session from the invite link — send them to sign in.
    redirect("/admin/login");
  }

  // Resolving the admin context also claims the pending invitation
  // (getCurrentAdmin → claimAdminInvites), so by the time this renders the role
  // is assigned.
  const admin = await getCurrentAdmin();

  return (
    <div className="flex min-h-screen items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl">Finish setting up your account</h1>
        <p className="mt-1.5 text-sm text-ink-soft">
          {admin
            ? `Your ${admin.roles.map((r) => r.replace(/_/g, " ").toLowerCase()).join(", ")} access is ready. Choose a password to sign in from now on.`
            : "Choose a password to finish creating your account."}
        </p>
        <AcceptInviteForm />
        <p className="mt-6 text-center text-xs text-ink-faint">
          <Link href="/admin/login" className="underline hover:text-ink">
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
