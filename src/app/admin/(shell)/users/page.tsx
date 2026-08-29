import type { Metadata } from "next";
import { requirePermission } from "@/lib/admin/rbac";
import { prisma } from "@/lib/prisma";
import { formatDate } from "@/lib/utils";
import { InviteAdminForm } from "@/components/admin/invite-admin-form";
import { PendingInvites } from "@/components/admin/pending-invites";
import { AdminRoster } from "@/components/admin/admin-roster";

export const metadata: Metadata = { title: "Admin Users" };

export default async function AdminUsersPage() {
  const admin = await requirePermission("view_admin_users");
  const canManage = admin.isSuperAdmin; // invite / role changes are SUPER_ADMIN-only

  const [roles, invites, roster] = await Promise.all([
    prisma.role.findMany({ orderBy: [{ sortOrder: "asc" }, { key: "asc" }] }),
    prisma.adminInvite.findMany({
      where: { status: "PENDING" },
      include: { role: true, invitedBy: { select: { email: true, name: true } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.user.findMany({
      where: { userRoles: { some: {} } },
      include: { userRoles: { include: { role: true } } },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const roleOptions = roles.map((r) => ({ key: r.key, name: r.name }));

  return (
    <div className="mx-auto max-w-4xl">
      <header>
        <p className="eyebrow">Admin</p>
        <h1 className="mt-1 text-3xl">Admin Users</h1>
        <p className="mt-1.5 text-sm text-ink-soft">
          {canManage
            ? "Invite administrators and manage their roles. Only a Super Admin can make changes here."
            : "You can view administrators. Role changes are restricted to Super Admins."}
        </p>
      </header>

      {canManage && (
        <section className="mt-8">
          <h2 className="text-lg">Invite an administrator</h2>
          <p className="mt-1 text-sm text-ink-soft">
            New addresses get a Supabase invitation email. Existing accounts are
            promoted immediately.
          </p>
          <InviteAdminForm roles={roleOptions} />
        </section>
      )}

      {invites.length > 0 && (
        <section className="mt-10">
          <h2 className="text-lg">Pending invitations ({invites.length})</h2>
          <PendingInvites
            canManage={canManage}
            invites={invites.map((i) => ({
              id: i.id,
              email: i.email,
              roleName: i.role.name,
              invitedBy: i.invitedBy.name ?? i.invitedBy.email,
              createdAt: formatDate(i.createdAt),
            }))}
          />
        </section>
      )}

      <section className="mt-10">
        <h2 className="text-lg">Administrators ({roster.length})</h2>
        <AdminRoster
          canManage={canManage}
          currentUserId={admin.user.id}
          roleOptions={roleOptions}
          admins={roster.map((u) => ({
            id: u.id,
            name: u.name,
            email: u.email,
            roleKeys: u.userRoles.map((ur) => ur.role.key),
          }))}
        />
      </section>
    </div>
  );
}
