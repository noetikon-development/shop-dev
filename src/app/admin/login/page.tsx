import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentAdmin } from "@/lib/admin/rbac";
import { AdminLoginForm } from "@/components/admin/admin-login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function AdminLoginPage() {
  // Already a signed-in admin → straight to the dashboard.
  const admin = await getCurrentAdmin();
  if (admin) redirect("/admin");

  return (
    <div className="flex min-h-screen items-center justify-center px-6 py-12">
      <AdminLoginForm />
    </div>
  );
}
