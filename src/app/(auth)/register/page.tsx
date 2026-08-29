import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { RegisterForm } from "@/components/auth/register-form";

export const metadata: Metadata = { title: "Create an account" };

export default async function RegisterPage() {
  const session = await auth();
  if (session?.user) redirect("/account");
  return (
    <Suspense>
      <RegisterForm />
    </Suspense>
  );
}
