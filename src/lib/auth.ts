import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import type { User as SupabaseUser } from "@supabase/supabase-js";
import type { User as AppUser } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { scheduleEmail } from "@/lib/email/schedule";
import { sendWelcomeEmail } from "@/lib/email/notifications";

/**
 * The verified Supabase Auth user for this request, or null. Deduped per request.
 * Uses supabase.auth.getUser() which revalidates the JWT with Supabase —
 * never trust getSession() / client-supplied ids for anything protected.
 */
export const getSupabaseUser = cache(async (): Promise<SupabaseUser | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user ?? null;
});

/**
 * Maps a Supabase Auth user to exactly one application `User` row:
 *   1. match on supabaseUserId (already linked)
 *   2. else match on email and link (covers pre-existing accounts)
 *   3. else create
 * Written to be safe under concurrent first requests.
 */
export async function syncAppUser(supabaseUser: SupabaseUser): Promise<AppUser> {
  const linked = await prisma.user.findUnique({
    where: { supabaseUserId: supabaseUser.id },
  });
  if (linked) return maybeSyncLinked(linked, supabaseUser);

  const email = (supabaseUser.email ?? "").toLowerCase();
  const meta = (supabaseUser.user_metadata ?? {}) as { name?: string; phone?: string };
  const emailVerified = supabaseUser.email_confirmed_at
    ? new Date(supabaseUser.email_confirmed_at)
    : null;

  try {
    // Link an existing row by email, or create a new one — atomic on the
    // unique email constraint.
    const existed = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    const user = await prisma.user.upsert({
      where: { email },
      update: { supabaseUserId: supabaseUser.id, emailVerified },
      create: {
        supabaseUserId: supabaseUser.id,
        email,
        name: meta.name ?? null,
        phone: meta.phone ?? null,
        role: "CUSTOMER",
        emailVerified,
      },
    });
    // First time this account exists → customer welcome email. NOT sent to
    // admin accounts: an admin is provisioned via AdminInvite (the role is
    // applied later by claimAdminInvites), so a pending / accepted invite for
    // this address means this is an admin onboarding, not a customer sign-up.
    // `sendWelcomeEmail` re-checks this too (defence in depth). The
    // WELCOME:<userId> idempotency key means it is sent at most once, ever.
    if (!existed) {
      const adminInvite = await prisma.adminInvite.count({
        where: { email, status: { in: ["PENDING", "ACCEPTED"] } },
      });
      if (adminInvite === 0) scheduleEmail(() => sendWelcomeEmail(user.id));
    }
    return user;
  } catch {
    // Lost a race — the row now exists; read it back.
    const again = await prisma.user.findFirst({
      where: { OR: [{ supabaseUserId: supabaseUser.id }, { email }] },
    });
    if (again) return again;
    throw new Error("Failed to provision application user");
  }
}

/**
 * Keep the application row in step with the Supabase Auth user for the fields
 * Supabase owns: `emailVerified`, and `email` itself once a Supabase email
 * change has completed (Step 21 P2). Runs on every authenticated request for a
 * linked user, so it is the natural place to pick up a confirmed email change.
 */
async function maybeSyncLinked(user: AppUser, supabaseUser: SupabaseUser): Promise<AppUser> {
  const verified = supabaseUser.email_confirmed_at
    ? new Date(supabaseUser.email_confirmed_at)
    : null;
  const sbEmail = (supabaseUser.email ?? "").toLowerCase();
  const emailDrifted = Boolean(sbEmail) && sbEmail !== user.email.toLowerCase();
  const verifiedDrifted = Boolean(user.emailVerified) !== Boolean(verified);

  if (!emailDrifted && !verifiedDrifted) return user;

  const data: { emailVerified?: Date | null; email?: string } = {};
  if (verifiedDrifted) data.emailVerified = verified;
  if (emailDrifted) data.email = sbEmail;

  try {
    return await prisma.user.update({ where: { id: user.id }, data });
  } catch {
    // A rare unique-email collision with an orphan row — leave the app email
    // stale rather than fail the request; the sync retries next time.
    if (verifiedDrifted && !emailDrifted) {
      return prisma.user
        .update({ where: { id: user.id }, data: { emailVerified: verified } })
        .catch(() => user);
    }
    return user;
  }
}

/** The application User for the current request, or null when unauthenticated. Deduped per request. */
export const getCurrentUser = cache(async (): Promise<AppUser | null> => {
  const supabaseUser = await getSupabaseUser();
  if (!supabaseUser) return null;
  return syncAppUser(supabaseUser);
});

/** Use in protected Server Components / Actions. Redirects guests to /login. */
export async function requireUser(redirectTo?: string): Promise<AppUser> {
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login${redirectTo ? `?redirectTo=${encodeURIComponent(redirectTo)}` : ""}`);
  }
  return user;
}
