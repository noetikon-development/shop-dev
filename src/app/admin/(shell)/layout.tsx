import { forbidden, redirect } from "next/navigation";
import { getSupabaseUser } from "@/lib/auth";
import { getCurrentAdmin } from "@/lib/admin/rbac";
import { AdminShell } from "@/components/admin/admin-shell";

export default async function AdminShellLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Unauthenticated → sign-in (proxy.ts already does this; this is the backstop).
  const sbUser = await getSupabaseUser();
  if (!sbUser) redirect("/admin/login");

  // Signed in but not an administrator → real HTTP 403 (app/forbidden.tsx).
  const admin = await getCurrentAdmin();
  if (!admin) forbidden();

  return (
    <AdminShell
      name={admin.user.name ?? admin.user.email}
      email={admin.user.email}
      roles={admin.roles}
      permissions={[...admin.permissions]}
      isSuperAdmin={admin.isSuperAdmin}
    >
      {children}
    </AdminShell>
  );
}
