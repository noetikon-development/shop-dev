"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { syncAppUser } from "@/lib/auth";
import { getSiteUrl } from "@/lib/site-url";
import { scheduleEmail } from "@/lib/email/schedule";
import { sendPasswordChanged, sendEmailChanged, sendSignInAlert } from "@/lib/email/notifications";
import { recordSignIn, summarizeUserAgent } from "@/lib/auth/devices";

/** Best-effort User-Agent for this request — used only for a coarse device summary. */
async function currentUserAgent(): Promise<string | null> {
  try {
    return (await headers()).get("user-agent");
  } catch {
    return null;
  }
}

/**
 * Map a Supabase Auth error to safe, customer-friendly copy. A raw provider
 * string is NEVER returned — anything unrecognised falls back to `fallback`.
 * Keeps the useful guidance (rate limit, weak password, reused password, bad
 * address) without exposing provider internals, DB errors, tokens or identifiers.
 */
function friendlyAuthError(err: { message?: string; code?: string } | null, fallback: string): string {
  const raw = `${err?.code ?? ""} ${err?.message ?? ""}`.toLowerCase();
  if (!raw.trim()) return fallback;
  if (/rate limit|too many|after \d+ seconds|for security purposes/.test(raw)) {
    return "You've tried that a few times — please wait a minute and try again.";
  }
  if (/different from the old password|should be different/.test(raw)) {
    return "Choose a password you haven't used on this account before.";
  }
  if (/password/.test(raw) && /(weak|at least|characters|short|strength|pwned|compromised)/.test(raw)) {
    return "Choose a stronger password — at least 8 characters.";
  }
  if (/(invalid|unable to validate|not valid).*(email|address)|email.*(invalid|not valid)/.test(raw)) {
    return "That doesn't look like a valid email address.";
  }
  if (/already (been )?registered|already in use|already exists/.test(raw)) {
    return "An account with that email already exists. Try signing in instead.";
  }
  if (/signup.*(disabled|not allowed)|not allowed to sign ?up/.test(raw)) {
    return "Sign-ups are temporarily unavailable. Please try again later.";
  }
  if (/email not confirmed/.test(raw)) {
    return "Please confirm your email first — check your inbox for the verification link.";
  }
  if (/same.*(email|address)|no change/.test(raw)) {
    return "That's already the email on your account.";
  }
  return fallback;
}

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
    return { error: friendlyAuthError(error, "We couldn't create your account. Please try again.") };
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

  // New-device sign-in alert (Step 21 P2). Best-effort — a failure here must
  // never block a valid login, and never sends on session refresh / page loads
  // (this runs only on an explicit password sign-in).
  try {
    const { data: { user: sbUser } } = await supabase.auth.getUser();
    if (sbUser) {
      const appUser = await syncAppUser(sbUser);
      const rec = await recordSignIn(appUser.id, await currentUserAgent());
      if (rec.isNewDevice) {
        scheduleEmail(() =>
          sendSignInAlert(appUser.id, { deviceSummary: rec.deviceSummary, uaHash: rec.uaHash }),
        );
      }
    }
  } catch (err) {
    console.error("[auth] sign-in alert", err);
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
  if (error) return { error: friendlyAuthError(error, "We couldn't send the email. Please try again shortly.") };
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
  if (error) return { error: friendlyAuthError(error, "We couldn't update your password. Please try again.") };

  // Password-changed security notice (Step 21 P2) — only after a real success.
  try {
    const appUser = await syncAppUser(user);
    const deviceSummary = summarizeUserAgent(await currentUserAgent());
    scheduleEmail(() => sendPasswordChanged(appUser.id, { deviceSummary }));
  } catch (err) {
    console.error("[auth] password-changed notice", err);
  }

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

  // Verify the current password on a throwaway client that never persists a
  // session — signing in on the cookie-bound client would rotate the refresh
  // token and kill the real session mid-action.
  const verifier = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { error: reauthError } = await verifier.auth.signInWithPassword({
    email: user.email,
    password: current,
  });
  if (reauthError) return { error: "Your current password is incorrect." };
  // Only clear this throwaway client's (in-memory, unpersisted) session — a
  // default global sign-out would revoke the caller's real session too.
  await verifier.auth.signOut({ scope: "local" });

  // Apply the change on the real cookie-bound session.
  const { error } = await supabase.auth.updateUser({ password: next.data });
  if (error) return { error: friendlyAuthError(error, "We couldn't update your password. Please try again.") };

  // Password-changed security notice (Step 21 P2) — only after a real success.
  try {
    const appUser = await syncAppUser(user);
    const deviceSummary = summarizeUserAgent(await currentUserAgent());
    scheduleEmail(() => sendPasswordChanged(appUser.id, { deviceSummary }));
  } catch (err) {
    console.error("[auth] password-changed notice", err);
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Email change (Step 21 P2)
// ---------------------------------------------------------------------------

const changeEmailSchema = z.object({
  newEmail: z.string().trim().toLowerCase().email("Enter a valid email address"),
});

export type EmailChangeState = { error?: string; ok?: boolean };

/**
 * Start a customer email change. Supabase Auth owns the mechanism: with "Secure
 * email change" (the default) it sends a confirmation link to BOTH the current
 * and the new address, and the change only takes effect once both are
 * confirmed. This action never bypasses that. On a successful request it sends
 * an app security notice to the CURRENT address (see sendEmailChanged) — that
 * notice carries no token.
 */
export async function changeEmail(
  _prev: EmailChangeState,
  formData: FormData,
): Promise<EmailChangeState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) return { error: "Please sign in again." };

  const parsed = changeEmailSchema.safeParse({ newEmail: formData.get("newEmail") });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const newEmail = parsed.data.newEmail;

  if (newEmail === user.email.toLowerCase()) {
    return { error: "That's already the email on your account." };
  }

  // Supabase sends the confirmation link(s); it also rejects an address that
  // already belongs to another account. The active session is required and is
  // preserved (an email change does not rotate the refresh token).
  const { error } = await supabase.auth.updateUser(
    { email: newEmail },
    { emailRedirectTo: `${getSiteUrl()}/auth/callback?next=/account/profile` },
  );
  if (error) {
    return { error: friendlyAuthError(error, "We couldn't start the email change. Please try again.") };
  }

  // Security notice to the CURRENT (old) address — best-effort, never blocks.
  try {
    const appUser = await syncAppUser(user);
    const deviceSummary = summarizeUserAgent(await currentUserAgent());
    scheduleEmail(() => sendEmailChanged(appUser.id, newEmail, { deviceSummary }));
  } catch (err) {
    console.error("[auth] email-changed notice", err);
  }

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
