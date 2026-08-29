"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { syncAppUser } from "@/lib/auth";
import { getSiteUrl } from "@/lib/site-url";

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const registerSchema = z.object({
  name: z.string().trim().min(2, "Please enter your name").max(80),
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  password: z.string().min(8, "Use at least 8 characters").max(100),
});

export type RegisterState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  ok?: boolean;
};

export async function registerUser(
  _prev: RegisterState,
  formData: FormData,
): Promise<RegisterState> {
  const parsed = registerSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0])] = issue.message;
    return { fieldErrors };
  }
  const { name, email, password } = parsed.data;

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { name },
      emailRedirectTo: `${getSiteUrl()}/auth/callback?next=/account`,
    },
  });

  if (error) {
    return { error: error.message.replace(/\.$/, "") };
  }
  // Supabase returns a user with an empty `identities` array when the email is
  // already registered (to avoid account enumeration).
  if (data.user && data.user.identities && data.user.identities.length === 0) {
    return { error: "An account with that email already exists. Try signing in instead." };
  }

  // Provision / link the application User row now so it exists immediately.
  if (data.user) {
    await prisma.user.upsert({
      where: { email },
      update: { supabaseUserId: data.user.id, name },
      create: { supabaseUserId: data.user.id, email, name, role: "CUSTOMER" },
    });
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Login / logout
// ---------------------------------------------------------------------------

export type LoginState = { error?: string; needsVerification?: boolean };

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const redirectTo = String(formData.get("redirectTo") || "/account");

  if (!email || !password) return { error: "Enter your email and password." };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    if (/email not confirmed/i.test(error.message)) {
      return {
        error: "Please confirm your email first — check your inbox for the verification link.",
        needsVerification: true,
      };
    }
    return { error: "That email and password don’t match an account." };
  }

  revalidatePath("/", "layout");
  redirect(redirectTo.startsWith("/") ? redirectTo : "/account");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/");
}

export async function resendVerification(email: string) {
  const clean = email.trim().toLowerCase();
  if (!clean) return { error: "Enter your email." };
  const supabase = await createClient();
  const { error } = await supabase.auth.resend({
    type: "signup",
    email: clean,
    options: { emailRedirectTo: `${getSiteUrl()}/auth/callback?next=/account` },
  });
  if (error) return { error: error.message };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Password recovery
// ---------------------------------------------------------------------------

export type ForgotState = { error?: string; ok?: boolean };

export async function requestPasswordReset(
  _prev: ForgotState,
  formData: FormData,
): Promise<ForgotState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email.includes("@")) return { error: "Enter a valid email address." };

  const supabase = await createClient();
  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${getSiteUrl()}/auth/callback?next=/reset-password`,
  });
  // Always report success — never reveal whether the address is registered.
  return { ok: true };
}

export type PasswordState = { error?: string; ok?: boolean };

const passwordSchema = z.string().min(8, "Use at least 8 characters").max(100);

/** Used on the reset-password page (the visitor arrived via a recovery link). */
export async function resetPassword(
  _prev: PasswordState,
  formData: FormData,
): Promise<PasswordState> {
  const password = passwordSchema.safeParse(formData.get("password"));
  const confirm = String(formData.get("confirm") ?? "");
  if (!password.success) return { error: password.error.issues[0].message };
  if (password.data !== confirm) return { error: "The two passwords don’t match." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { error: "This reset link has expired. Request a new one from the sign-in page." };
  }

  const { error } = await supabase.auth.updateUser({ password: password.data });
  if (error) return { error: error.message };
  revalidatePath("/", "layout");
  return { ok: true };
}

/** Used on the account page (the customer is signed in and knows their password). */
export async function changePassword(
  _prev: PasswordState,
  formData: FormData,
): Promise<PasswordState> {
  const current = String(formData.get("currentPassword") ?? "");
  const next = passwordSchema.safeParse(formData.get("newPassword"));
  const confirm = String(formData.get("confirm") ?? "");
  if (!current) return { error: "Enter your current password." };
  if (!next.success) return { error: next.error.issues[0].message };
  if (next.data !== confirm) return { error: "The new passwords don’t match." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) return { error: "Please sign in again." };

  // Re-authenticate with the current password before allowing the change.
  const { error: reauthError } = await supabase.auth.signInWithPassword({
    email: user.email,
    password: current,
  });
  if (reauthError) return { error: "Your current password is incorrect." };

  const { error } = await supabase.auth.updateUser({ password: next.data });
  if (error) return { error: error.message };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

const profileSchema = z.object({
  name: z.string().trim().min(2, "Please enter your name").max(80),
  phone: z.string().trim().max(30).optional().or(z.literal("")),
});

export type ProfileState = { error?: string; ok?: boolean };

export async function updateProfile(
  _prev: ProfileState,
  formData: FormData,
): Promise<ProfileState> {
  // Single Supabase client per request — creating a second one can trip
  // refresh-token-reuse detection and drop the session.
  const supabase = await createClient();
  const {
    data: { user: sbUser },
  } = await supabase.auth.getUser();
  if (!sbUser) return { error: "Please sign in." };

  const parsed = profileSchema.safeParse({
    name: formData.get("name"),
    phone: formData.get("phone"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const phone = parsed.data.phone || null;
  const appUser = await syncAppUser(sbUser);
  await prisma.user.update({
    where: { id: appUser.id },
    data: { name: parsed.data.name, phone },
  });
  // Keep the Supabase user_metadata roughly in sync (best-effort — the app
  // treats the Prisma row as the source of truth for profile fields).
  await supabase.auth.updateUser({ data: { name: parsed.data.name, phone } }).catch(() => {});

  revalidatePath("/account");
  revalidatePath("/account/profile");
  revalidatePath("/", "layout");
  return { ok: true };
}
