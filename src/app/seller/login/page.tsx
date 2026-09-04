import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getSellerSession } from "@/lib/seller/session";
import { SellerLoginForm } from "@/components/seller/seller-login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function SellerLoginPage() {
  const user = await getCurrentUser();
  if (user) {
    const session = await getSellerSession();
    if (session) redirect("/seller");
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6 py-12">
      <Suspense>
        <SellerLoginForm />
      </Suspense>
    </div>
  );
}
