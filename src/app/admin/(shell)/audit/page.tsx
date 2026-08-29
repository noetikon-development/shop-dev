import type { Metadata } from "next";
import { requirePermission } from "@/lib/admin/rbac";
import { prisma } from "@/lib/prisma";
import { formatDate } from "@/lib/utils";

export const metadata: Metadata = { title: "Audit Log" };

export default async function AdminAuditPage() {
  await requirePermission("view_audit_logs");

  const events = await prisma.adminAuditLog.findMany({
    include: { actor: { select: { email: true, name: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return (
    <div className="mx-auto max-w-4xl">
      <header>
        <p className="eyebrow">Admin</p>
        <h1 className="mt-1 text-3xl">Audit Log</h1>
        <p className="mt-1.5 text-sm text-ink-soft">
          The 100 most recent security-relevant admin events (sign in, invitations,
          role changes). Read-only.
        </p>
      </header>

      {events.length === 0 ? (
        <p className="mt-8 text-sm text-ink-soft">No events recorded yet.</p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
                <th className="py-2 pr-4 font-medium">When</th>
                <th className="py-2 pr-4 font-medium">Actor</th>
                <th className="py-2 pr-4 font-medium">Action</th>
                <th className="py-2 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-b border-line/60 align-top">
                  <td className="whitespace-nowrap py-2.5 pr-4 text-ink-soft">
                    {formatDate(e.createdAt, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </td>
                  <td className="py-2.5 pr-4 text-ink-soft">
                    {e.actor?.email ?? "system"}
                  </td>
                  <td className="py-2.5 pr-4">
                    <code className="text-xs">{e.action}</code>
                  </td>
                  <td className="py-2.5 text-ink-soft">{e.summary ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
