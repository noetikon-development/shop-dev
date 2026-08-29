import type { Metadata } from "next";
import { requirePermission } from "@/lib/admin/rbac";
import { prisma } from "@/lib/prisma";
import { formatDate } from "@/lib/utils";
import { PageHeader, DataTable, type Column } from "@/components/admin/ui";

export const metadata: Metadata = { title: "Audit Log" };

type Event = {
  id: string;
  when: string;
  actor: string;
  action: string;
  detail: string;
};

export default async function AdminAuditPage() {
  await requirePermission("view_audit_logs");

  const events = await prisma.adminAuditLog.findMany({
    include: { actor: { select: { email: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const rows: Event[] = events.map((e) => ({
    id: e.id,
    when: formatDate(e.createdAt, { hour: "2-digit", minute: "2-digit" }),
    actor: e.actor?.email ?? "system",
    action: e.action,
    detail: e.summary ?? "—",
  }));

  const columns: Column<Event>[] = [
    { key: "when", header: "When", className: "whitespace-nowrap" },
    { key: "actor", header: "Actor" },
    {
      key: "action",
      header: "Action",
      cell: (r) => <code className="text-xs text-ink">{r.action}</code>,
    },
    { key: "detail", header: "Detail", className: "text-ink-soft" },
  ];

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Audit Log"
        description="The 100 most recent security-relevant admin events — sign in, invitations, role changes and media uploads. Read-only."
      />
      <DataTable
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.id}
        empty={{ title: "No events recorded yet." }}
        caption="Admin audit log"
      />
    </div>
  );
}
