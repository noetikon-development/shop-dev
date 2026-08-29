import "server-only";
import type { User as AppUser } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/lib/admin/audit";

/**
 * Shared, non-HTTP admin provisioning primitives. These enforce data integrity
 * (one Supabase user ↔ one Prisma user ↔ zero-or-more roles, no duplicates) but
 * do NOT perform authorization — callers in src/lib/admin/actions.ts do that
 * first with the require* helpers.
 */

/** Keep the coarse User.role mirror truthful after a role change. */
export async function syncUserAdminFlag(userId: string): Promise<void> {
  const count = await prisma.userRole.count({ where: { userId } });
  const desired = count > 0 ? "ADMIN" : "CUSTOMER";
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (user && user.role !== desired) {
    await prisma.user.update({ where: { id: userId }, data: { role: desired } });
  }
}

/** Assign a role to a user. Idempotent on the (userId, roleId) unique key. */
export async function assignRoleToUser(
  targetUserId: string,
  roleId: string,
  actorUserId: string | null,
): Promise<{ created: boolean }> {
  const existing = await prisma.userRole.findUnique({
    where: { userId_roleId: { userId: targetUserId, roleId } },
  });
  if (existing) return { created: false };

  await prisma.userRole.create({
    data: { userId: targetUserId, roleId, assignedBy: actorUserId },
  });
  await syncUserAdminFlag(targetUserId);
  return { created: true };
}

/** Remove a role from a user. Idempotent. */
export async function removeRoleFromUser(
  targetUserId: string,
  roleId: string,
): Promise<{ removed: boolean }> {
  const existing = await prisma.userRole.findUnique({
    where: { userId_roleId: { userId: targetUserId, roleId } },
  });
  if (!existing) return { removed: false };

  await prisma.userRole.delete({ where: { id: existing.id } });
  await syncUserAdminFlag(targetUserId);
  return { removed: true };
}

/**
 * Apply any PENDING admin invitation(s) for this user's email address. Called on
 * the invitee's first authenticated request (auth callback / admin login /
 * getCurrentAdmin). The AdminInvite row — written only by a SUPER_ADMIN action —
 * is the trusted record of the intended role; nothing here reads client input
 * or Supabase user_metadata.
 */
export async function claimAdminInvites(appUser: AppUser, email: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return;

  const pending = await prisma.adminInvite.findMany({
    where: { email: normalized, status: "PENDING" },
    include: { role: true },
  });
  if (pending.length === 0) return;

  for (const invite of pending) {
    try {
      const { created } = await assignRoleToUser(
        appUser.id,
        invite.roleId,
        invite.invitedById,
      );
      await prisma.adminInvite.update({
        where: { id: invite.id },
        data: {
          status: "ACCEPTED",
          acceptedAt: new Date(),
          acceptedById: appUser.id,
        },
      });
      await writeAudit({
        actorUserId: invite.invitedById,
        action: "admin.invite.accepted",
        targetType: "user",
        targetId: appUser.id,
        summary: `${appUser.email} accepted the ${invite.role.name} invitation`,
        meta: { email: normalized, role: invite.role.key, roleNewlyAssigned: created },
      });
    } catch (err) {
      console.error("[provisioning] failed to claim invite", invite.id, err);
    }
  }
}
