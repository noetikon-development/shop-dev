import type { Metadata } from "next";
import { requirePermission } from "@/lib/admin/rbac";
import { getEmailConfig } from "@/lib/email/config";
import {
  listEmailLogs,
  getEmailLogCounts,
  EMAIL_TYPES,
  EMAIL_STATUSES,
} from "@/lib/admin/email-logs";
import {
  PageHeader,
  FilterBar,
  SearchInput,
  FilterSelect,
  Pagination,
  StatusBadge,
  Card,
} from "@/components/admin/ui";
import { EmailLogsTable } from "@/components/admin/email/email-logs-table";

export const metadata: Metadata = { title: "Email log" };

const TYPE_OPTIONS = EMAIL_TYPES.map((t) => ({
  value: t,
  label: t.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
}));
const STATUS_OPTIONS = EMAIL_STATUSES.map((s) => ({ value: s, label: s[0] + s.slice(1).toLowerCase() }));

export default async function AdminEmailLogPage({ searchParams }: PageProps<"/admin/email">) {
  const admin = await requirePermission("view_audit_logs");
  const canRetry = admin.isSuperAdmin || admin.permissions.has("view_audit_logs");
  const sp = await searchParams;

  const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const q = str(sp.q);
  const type = str(sp.type);
  const status = str(sp.status);
  const page = Number(sp.page ?? 1) || 1;

  const [{ rows, total, pageCount, page: current }, counts, cfg] = await Promise.all([
    listEmailLogs({ q, type, status, page }),
    getEmailLogCounts(),
    Promise.resolve(getEmailConfig()),
  ]);
  const searching = Boolean(q || type || status);

  return (
    <div>
      <PageHeader
        title="Email log"
        description="Every transactional email the store tried to send. Delivery status is separate from order, payment and shipping status. Message bodies are not stored."
        actions={
          <StatusBadge tone={cfg.configured ? "success" : "neutral"}>
            {cfg.configured ? "Provider: SMTP" : cfg.mode === "log" ? "Mode: log (not sending)" : "No provider configured"}
          </StatusBadge>
        }
      />

      {!cfg.configured && (
        <Card className="mb-4 text-xs text-ink-soft">
          No SMTP provider is configured, so emails are <b>recorded but not sent</b> (status{" "}
          <StatusBadge tone="neutral">SKIPPED</StatusBadge>). Set the <code>EMAIL_HOST</code>,{" "}
          <code>EMAIL_USER</code> and <code>EMAIL_PASSWORD</code> environment variables to enable
          delivery — no code change needed.
        </Card>
      )}

      <div className="mb-4 flex flex-wrap gap-2 text-xs">
        {["ALL", "SENT", "SKIPPED", "FAILED", "PENDING", "SENDING"].map((k) => (
          <span key={k} className="rounded-full bg-surface-sunken px-2.5 py-1 text-ink-soft">
            {k === "ALL" ? "Total" : k[0] + k.slice(1).toLowerCase()}: <b>{counts[k] ?? 0}</b>
          </span>
        ))}
      </div>

      <FilterBar>
        <SearchInput placeholder="Recipient, subject or order…" />
        <FilterSelect label="Type" paramKey="type" options={TYPE_OPTIONS} />
        <FilterSelect label="Status" paramKey="status" options={STATUS_OPTIONS} />
      </FilterBar>

      <p className="mb-3 mt-4 text-xs text-ink-faint">
        {total} email{total === 1 ? "" : "s"}
        {searching && " match this filter"}
      </p>

      <EmailLogsTable rows={rows} canRetry={canRetry} searching={searching} />

      <div className="mt-4">
        <Pagination page={current} totalPages={pageCount} />
      </div>
    </div>
  );
}
