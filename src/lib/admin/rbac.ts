import "server-only";
import { cache } from "react";
import { forbidden } from "next/navigation";
import type { User as AppUser } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getSupabaseUser } from "@/lib/auth";
import { syncAppUser } from "@/lib/auth";
import { claimAdminInvites } from "@/lib/admin/provisioning";

/**
 * Server-side authorization for the admin area.
 *
 * The authenticated Supabase user is resolved from the session cookie
 * (getSupabaseUser → supabase.auth.getUser, which revalidates the JWT). The
 * application user, their roles and the union of their permissions are then
 * loaded from the database. Nothing here trusts a client-supplied id, role or
 * permission. Every protected page, server action and route handler must call
 * one of the `require*` helpers.
 */

export type AdminContext = {
  user: AppUser;
  supabaseUserId: string;
  /** role keys, e.g. ["SUPER_ADMIN"] */
  roles: string[];
  /** union of permission keys granted by those roles */
  permissions: Set<string>;
  isSuperAdmin: boolean;
};

/**
 * The admin context for the current request, or null when the visitor is not
 * signed in OR is signed in but holds no admin role. Deduped per request.
 */
export const getCurrentAdmin = cache(async (): Promise<AdminContext | null> => {
  const sbUser = await getSupabaseUser();
  if (!sbUser) return null;

  const appUser = await syncAppUser(sbUser);

  // Apply any pending invitation for this address (safe + idempotent). Wrapped
  // so a provisioning hiccup never blocks an otherwise-valid admin.
  try {
    await claimAdminInvites(appUser, sbUser.email ?? appUser.email);
  } catch {
    /* logged inside claimAdminInvites */
  }

  const userRoles = await prisma.userRole.findMany({
    where: { userId: appUser.id },
    include: {
      role: { include: { rolePermissions: { include: { permission: true } } } },
    },
  });
  if (userRoles.length === 0) return null;

  const roles = userRoles.map((ur) => ur.role.key);
  const permissions = new Set<string>();
  for (const ur of userRoles) {
    for (const rp of ur.role.rolePermissions) permissions.add(rp.permission.key);
  }
  const isSuperAdmin = roles.includes("SUPER_ADMIN");

  return { user: appUser, supabaseUserId: sbUser.id, roles, permissions, isSuperAdmin };
});

/** True when the given app user holds at least one admin role. Cheap count. */
export async function userHasAnyAdminRole(userId: string): Promise<boolean> {
  const n = await prisma.userRole.count({ where: { userId } });
  return n > 0;
}

/** Pure check — use for conditional UI. Never the only gate on an action. */
export function hasPermission(admin: AdminContext, permission: string): boolean {
  return admin.isSuperAdmin || admin.permissions.has(permission);
}

export function hasRole(admin: AdminContext, roleKey: string): boolean {
  return admin.roles.includes(roleKey);
}

/**
 * Require an authenticated admin (any role). Throws the Next.js 403 interrupt
 * otherwise. Use in server actions, route handlers and placeholder pages that
 * live under the admin layout.
 */
export async function requireAdmin(): Promise<AdminContext> {
  const admin = await getCurrentAdmin();
  if (!admin) forbidden();
  return admin;
}

/** Require a specific permission (SUPER_ADMIN always passes). */
export async function requirePermission(permission: string): Promise<AdminContext> {
  const admin = await requireAdmin();
  if (!hasPermission(admin, permission)) forbidden();
  return admin;
}

/** Require ANY of the listed permissions (SUPER_ADMIN always passes). */
export async function requireAnyPermission(permissions: string[]): Promise<AdminContext> {
  const admin = await requireAdmin();
  if (!admin.isSuperAdmin && !permissions.some((p) => admin.permissions.has(p))) {
    forbidden();
  }
  return admin;
}

/** Require a specific role key. */
export async function requireRole(roleKey: string): Promise<AdminContext> {
  const admin = await requireAdmin();
  if (!hasRole(admin, roleKey)) forbidden();
  return admin;
}
