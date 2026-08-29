import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getSupabaseUser } from "@/lib/auth";
import { RegisterForm } from "@/components/auth/register-form";

export const metadata: Metadata = { title: "Create an account" };
export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  if (await getSupabaseUser()) redirect("/account");
  return (
    <Suspense>
      <RegisterForm />
    </Suspense>
  );
}
