"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSiteUrl } from "@/lib/site-url";
import { syncAppUser } from "@/lib/auth";
import { getSupabaseUser } from "@/lib/auth";
import { requireRole, getCurrentAdmin } from "@/lib/admin/rbac";
import {
  assignRoleToUser,
  removeRoleFromUser,
  claimAdminInvites,
} from "@/lib/admin/provisioning";
import { writeAudit } from "@/lib/admin/audit";
import { ROLE_KEYS } from "@/lib/rbac/catalog";

// ---------------------------------------------------------------------------
// Admin sign in / out
// ---------------------------------------------------------------------------

export type AdminLoginState = { error?: string };

export async function adminLogin(
  _prev: AdminLoginState,
  formData: FormData,
): Promise<AdminLoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "Enter your email and password." };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    return { error: "That email and password don’t match an account." };
  }

  // Resolve the application user and apply any pending invitation.
  const appUser = await syncAppUser(data.user);
  try {
    await claimAdminInvites(appUser, data.user.email ?? appUser.email);
  } catch {
    /* logged inside */
  }

  const roleCount = await prisma.userRole.count({ where: { userId: appUser.id } });
  if (roleCount === 0) {
    // Not an administrator — drop the session we just created on this surface.
    await supabase.auth.signOut({ scope: "local" });
    return { error: "This account doesn’t have administrator access." };
  }

  await writeAudit({
    actorUserId: appUser.id,
    action: "admin.login",
    targetType: "user",
    targetId: appUser.id,
    summary: `${appUser.email} signed in to the admin area`,
    meta: { email },
  });

  revalidatePath("/", "layout");
  redirect("/admin");
}

export async function adminSignOut() {
  const supabase = await createClient();
  const admin = await getCurrentAdmin();
  await supabase.auth.signOut();
  if (admin) {
    await writeAudit({
      actorUserId: admin.user.id,
      action: "admin.logout",
      targetType: "user",
      targetId: admin.user.id,
      summary: `${admin.user.email} signed out of the admin area`,
    });
  }
  revalidatePath("/", "layout");
  redirect("/admin/login");
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export type InviteState = { error?: string; ok?: boolean; message?: string };

const emailSchema = z.string().trim().toLowerCase().email("Enter a valid email address");

export async function inviteAdmin(
  _prev: InviteState,
  formData: FormData,
): Promise<InviteState> {
  // Only a SUPER_ADMIN may invite or promote administrators.
  const actor = await requireRole("SUPER_ADMIN");

  const parsedEmail = emailSchema.safeParse(formData.get("email"));
  if (!parsedEmail.success) {
    return { error: parsedEmail.error.issues[0].message };
  }
  const email = parsedEmail.data;
  const roleKey = String(formData.get("roleKey") ?? "");
  if (!ROLE_KEYS.includes(roleKey as (typeof ROLE_KEYS)[number])) {
    return { error: "Choose a valid role." };
  }

  const role = await prisma.role.findUnique({ where: { key: roleKey } });
  if (!role) return { error: "That role no longer exists." };

  // Defence in depth: granting SUPER_ADMIN requires the caller to be one.
  if (roleKey === "SUPER_ADMIN" && !actor.isSuperAdmin) {
    return { error: "Only a Super Admin can grant the Super Admin role." };
  }

  // Record the intent. This row is the trusted source for the role that gets
  // applied on first sign-in — not the email link, not user_metadata.
  const invite = await prisma.adminInvite.create({
    data: {
      email,
      roleId: role.id,
      invitedById: actor.user.id,
      status: "PENDING",
    },
  });

  // If this address already has a linked account, apply the role immediately.
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing?.supabaseUserId) {
    if (existing.id === actor.user.id) {
      await prisma.adminInvite.update({
        where: { id: invite.id },
        data: { status: "REVOKED" },
      });
      return { error: "You can’t change your own roles." };
    }
    const { created } = await assignRoleToUser(existing.id, role.id, actor.user.id);
    await prisma.adminInvite.update({
      where: { id: invite.id },
      data: { status: "ACCEPTED", acceptedAt: new Date(), acceptedById: existing.id },
    });
    await writeAudit({
      actorUserId: actor.user.id,
      action: "admin.role.assign",
      targetType: "user",
      targetId: existing.id,
      summary: `${actor.user.email} granted ${existing.email} the ${role.name} role`,
      meta: { email, role: role.key, viaInvite: true, alreadyHadRole: !created },
    });
    revalidatePath("/admin/users");
    revalidatePath("/admin/audit");
    return {
      ok: true,
      message: created
        ? `${email} already has an account — the ${role.name} role was assigned.`
        : `${email} already has the ${role.name} role.`,
    };
  }

  // Brand-new (or not-yet-linked) address: send the Supabase invitation email.
  // Best-effort — even if the email can't be sent (e.g. the address already
  // exists in Supabase Auth), the PENDING invite is claimed on the person's
  // first authenticated request.
  let emailed = false;
  try {
    const service = createAdminClient();
    const { data: invited, error: inviteError } = await service.auth.admin.inviteUserByEmail(
      email,
      { redirectTo: `${getSiteUrl()}/auth/callback?next=/admin/accept` },
    );
    if (inviteError) {
      const benign = /already|registered|exists/i.test(inviteError.message);
      if (!benign) {
        await prisma.adminInvite.update({
          where: { id: invite.id },
          data: { status: "REVOKED" },
        });
        return { error: inviteError.message };
      }
    } else {
      emailed = true;
      if (invited?.user?.id) {
        await prisma.adminInvite.update({
          where: { id: invite.id },
          data: { supabaseUserId: invited.user.id },
        });
      }
    }
  } catch (err) {
    console.error("[inviteAdmin] Supabase invite failed", err);
    await prisma.adminInvite.update({ where: { id: invite.id }, data: { status: "REVOKED" } });
    return { error: "Could not send the invitation. Check the service configuration and try again." };
  }

  await writeAudit({
    actorUserId: actor.user.id,
    action: "admin.invite",
    targetType: "invite",
    targetId: invite.id,
    summary: `${actor.user.email} invited ${email} as ${role.name}`,
    meta: { email, role: role.key, emailed },
  });
  revalidatePath("/admin/users");
  revalidatePath("/admin/audit");
  return {
    ok: true,
    message: emailed
      ? `Invitation sent to ${email}. They’ll get the ${role.name} role once they set a password.`
      : `${email} already has an account — they’ll get the ${role.name} role the next time they sign in.`,
  };
}

export type SimpleState = { error?: string; ok?: boolean };

export async function revokeInvite(
  _prev: SimpleState,
  formData: FormData,
): Promise<SimpleState> {
  const actor = await requireRole("SUPER_ADMIN");
  const inviteId = String(formData.get("inviteId") ?? "");
  const invite = await prisma.adminInvite.findUnique({ where: { id: inviteId } });
  if (!invite) return { error: "That invitation no longer exists." };
  if (invite.status !== "PENDING") return { error: "That invitation is no longer pending." };

  await prisma.adminInvite.update({ where: { id: inviteId }, data: { status: "REVOKED" } });
  await writeAudit({
    actorUserId: actor.user.id,
    action: "admin.invite.revoked",
    targetType: "invite",
    targetId: inviteId,
    summary: `${actor.user.email} revoked the invitation for ${invite.email}`,
    meta: { email: invite.email },
  });
  revalidatePath("/admin/users");
  revalidatePath("/admin/audit");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Role assignment for existing administrators
// ---------------------------------------------------------------------------

export type RolesState = { error?: string; ok?: boolean };

export async function updateUserRoles(
  _prev: RolesState,
  formData: FormData,
): Promise<RolesState> {
  const actor = await requireRole("SUPER_ADMIN");

  const targetUserId = String(formData.get("userId") ?? "");
  const nextRoleKeys = formData.getAll("roleKeys").map((v) => String(v));

  if (!targetUserId) return { error: "Missing user." };
  if (targetUserId === actor.user.id) {
    return { error: "You can’t change your own roles." };
  }
  for (const k of nextRoleKeys) {
    if (!ROLE_KEYS.includes(k as (typeof ROLE_KEYS)[number])) {
      return { error: `Unknown role: ${k}` };
    }
  }

  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    include: { userRoles: { include: { role: true } } },
  });
  if (!target) return { error: "That user no longer exists." };

  const allRoles = await prisma.role.findMany();
  const roleByKey = new Map(allRoles.map((r) => [r.key, r]));

  const currentKeys = new Set(target.userRoles.map((ur) => ur.role.key));
  const nextKeys = new Set(nextRoleKeys);

  const toAdd = [...nextKeys].filter((k) => !currentKeys.has(k));
  const toRemove = [...currentKeys].filter((k) => !nextKeys.has(k));

  if (toAdd.length === 0 && toRemove.length === 0) {
    return { ok: true };
  }

  // Defence in depth: only a SUPER_ADMIN can grant SUPER_ADMIN (the require
  // above already guarantees this, but keep the explicit guard).
  if (toAdd.includes("SUPER_ADMIN") && !actor.isSuperAdmin) {
    return { error: "Only a Super Admin can grant the Super Admin role." };
  }

  // Don't allow removing the final Super Admin.
  if (toRemove.includes("SUPER_ADMIN")) {
    const superRole = roleByKey.get("SUPER_ADMIN");
    if (superRole) {
      const superAdmins = await prisma.userRole.count({ where: { roleId: superRole.id } });
      if (superAdmins <= 1) {
        return { error: "You can’t remove the last Super Admin." };
      }
    }
  }

  for (const key of toAdd) {
    const role = roleByKey.get(key)!;
    await assignRoleToUser(targetUserId, role.id, actor.user.id);
    await writeAudit({
      actorUserId: actor.user.id,
      action: "admin.role.assign",
      targetType: "user",
      targetId: targetUserId,
      summary: `${actor.user.email} granted ${target.email} the ${role.name} role`,
      meta: { targetEmail: target.email, role: key },
    });
  }
  for (const key of toRemove) {
    const role = roleByKey.get(key)!;
    await removeRoleFromUser(targetUserId, role.id);
    await writeAudit({
      actorUserId: actor.user.id,
      action: "admin.role.remove",
      targetType: "user",
      targetId: targetUserId,
      summary: `${actor.user.email} removed the ${role.name} role from ${target.email}`,
      meta: { targetEmail: target.email, role: key },
    });
  }

  revalidatePath("/admin/users");
  revalidatePath("/admin/audit");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Invited-admin password setup
// ---------------------------------------------------------------------------

export type AcceptState = { error?: string; ok?: boolean };

const passwordSchema = z.string().min(8, "Use at least 8 characters").max(100);

/**
 * Sets the password for an invited admin who arrived via the invitation email
 * (they have a session but no password yet). Runs on the cookie-bound client so
 * the session is preserved.
 */
export async function setInitialPassword(
  _prev: AcceptState,
  formData: FormData,
): Promise<AcceptState> {
  const password = passwordSchema.safeParse(formData.get("password"));
  const confirm = String(formData.get("confirm") ?? "");
  if (!password.success) return { error: password.error.issues[0].message };
  if (password.data !== confirm) return { error: "The two passwords don’t match." };

  const sbUser = await getSupabaseUser();
  if (!sbUser) {
    return { error: "Your setup link has expired. Ask for a new invitation." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: password.data });
  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  return { ok: true };
}
