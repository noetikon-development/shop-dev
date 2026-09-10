import type { Metadata } from "next";
import { requirePermission, hasPermission } from "@/lib/admin/rbac";
import {
  listAdminPayments,
  getPaymentsAdminConfig,
  listStuckPayments,
  listRecentWebhookEvents,
} from "@/lib/admin/payments";
import { getPaymongoDiagnostics } from "@/lib/payments/diagnostics";
import { PageHeader, FilterBar, SearchInput, FilterSelect, Pagination, Card } from "@/components/admin/ui";
import { PaymentsTable } from "@/components/admin/payments/payments-table";
import { ReprocessWebhookButton } from "@/components/admin/payments/reprocess-webhook-button";
import { PAYMENT_STATUSES, paymentStatusLabel } from "@/lib/payments/status";

export const metadata: Metadata = { title: "Payments" };

const RANGE_OPTIONS = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
];

export default async function AdminPaymentsPage({ searchParams }: PageProps<"/admin/payments">) {
  const admin = await requirePermission("view_payments");
  const canManage = hasPermission(admin, "manage_payments");
  const sp = await searchParams;
  const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

  const [{ rows, total, pageCount, page: current }, config, stuck, diag, webhooks] = await Promise.all([
    listAdminPayments({
      q: str(sp.q),
      status: str(sp.status),
      range: str(sp.range),
      page: Number(sp.page ?? 1) || 1,
    }),
    getPaymentsAdminConfig(),
    listStuckPayments(),
    getPaymongoDiagnostics(),
    listRecentWebhookEvents(25),
  ]);

  const failedWebhooks = webhooks.filter((w) => w.status === "FAILED").length;
  const searching = Boolean(str(sp.q) || str(sp.status) || str(sp.range));

  return (
    <div>
      <PageHeader
        title="Payments"
        description="PayMongo payment records and their refund status. Order payment state is only ever advanced by a signature-verified provider webhook — never from this screen."
      />

      {/* PayMongo config diagnostics — booleans / enums only, no secret values. */}
      <Card className="mb-5 text-sm">
        <p className="font-medium text-ink">PayMongo configuration</p>
        <dl className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
          {(
            [
              ["Sessions can be created", diag.secretKeyPresent && !diag.modeMismatch && config.sessionsEnabled ? "yes" : "no"],
              ["Webhook confirmation live", diag.onlinePaymentEnabled ? "yes" : "no"],
              ["Secret key", diag.secretKeyPresent ? "configured" : "not set"],
              ["Webhook secret", diag.webhookSecretPresent ? "configured" : "not set"],
              ["Key mode (from prefix)", diag.detectedMode],
              ["Configured mode", diag.configuredMode],
              ["Mode mismatch", diag.modeMismatch ? "YES — feature disabled" : "no"],
              ["API base", diag.apiBase],
              ["Runtime", diag.nodeEnv],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 border-b border-line/60 py-1">
              <dt className="text-ink-faint">{k}</dt>
              <dd className="text-right font-medium text-ink">{String(v)}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-xs text-ink-faint">{diag.summary}</p>
      </Card>

      {!config.onlinePaymentEnabled && (
        <Card className="mb-5 border-l-4 border-l-clay bg-clay-50/40 text-sm">
          <p className="font-medium text-ink">
            {config.sessionsEnabled
              ? "Payment sessions are live, but the webhook is not yet confirming payments."
              : "Online payment is currently disabled."}
          </p>
          <p className="mt-1 text-ink-soft">
            {config.sessionsEnabled
              ? "Customers can be redirected to PayMongo, but an order will not move to PAID until PAYMONGO_WEBHOOK_SECRET is configured and the PayMongo webhook is created."
              : "Checkout places orders as awaiting payment with no payment step, exactly as before."}
          </p>
        </Card>
      )}

      {stuck.length > 0 && (
        <Card className="mb-5 border-l-4 border-l-clay text-sm">
          <p className="font-medium text-ink">
            {stuck.length} payment{stuck.length === 1 ? "" : "s"} awaiting confirmation for over 24h
          </p>
          <p className="mt-1 text-ink-soft">
            A provider webhook may have been missed. Open the order and use “Re-check with PayMongo”.
          </p>
        </Card>
      )}

      <FilterBar>
        <SearchInput placeholder="Provider ref, order # or email…" />
        <FilterSelect
          label="Status"
          paramKey="status"
          options={PAYMENT_STATUSES.map((s) => ({ value: s, label: paymentStatusLabel(s) }))}
        />
        <FilterSelect label="Created" paramKey="range" options={RANGE_OPTIONS} allLabel="Any time" />
      </FilterBar>

      <p className="mb-3 mt-4 text-xs text-ink-faint">
        {total} payment record{total === 1 ? "" : "s"}
        {searching && " match this filter"}
      </p>

      <PaymentsTable rows={rows} searching={searching} />

      <div className="mt-4">
        <Pagination page={current} totalPages={pageCount} />
      </div>

      {/* 9F-54 — recent PayMongo webhook events. FAILED events (a transient
          error, a since-fixed bug) can be reprocessed through the same
          idempotent handler from their stored raw payload. */}
      <Card className="mt-8 text-sm">
        <div className="flex items-center justify-between">
          <p className="font-medium text-ink">Recent webhook events</p>
          {failedWebhooks > 0 && (
            <span className="rounded-sm bg-clay-50 px-2 py-0.5 text-xs font-medium text-clay">
              {failedWebhooks} FAILED
            </span>
          )}
        </div>
        {webhooks.length === 0 ? (
          <p className="mt-2 text-xs text-ink-faint">No webhook events yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-ink-faint">
                <tr className="border-b border-line/60 text-left">
                  <th className="py-1 pr-3 font-medium">Received</th>
                  <th className="py-1 pr-3 font-medium">Type</th>
                  <th className="py-1 pr-3 font-medium">Provider id</th>
                  <th className="py-1 pr-3 font-medium">Status</th>
                  <th className="py-1 pr-3 font-medium">Note</th>
                  <th className="py-1 font-medium" />
                </tr>
              </thead>
              <tbody>
                {webhooks.map((w) => (
                  <tr key={w.id} className="border-b border-line/40 align-top">
                    <td className="py-1.5 pr-3 tabular-nums text-ink-faint">
                      {w.receivedAt.toISOString().slice(0, 16).replace("T", " ")}
                    </td>
                    <td className="py-1.5 pr-3 text-ink">{w.type}</td>
                    <td className="py-1.5 pr-3 font-mono text-ink-soft">{w.providerId}</td>
                    <td className="py-1.5 pr-3">
                      <span
                        className={
                          w.status === "PROCESSED"
                            ? "text-fern"
                            : w.status === "FAILED"
                              ? "font-medium text-clay"
                              : "text-ink-faint"
                        }
                      >
                        {w.status}
                        {w.reprocessedAt ? " · reprocessed" : ""}
                      </span>
                    </td>
                    <td className="py-1.5 pr-3 text-ink-faint">{w.error ?? "—"}</td>
                    <td className="py-1.5 text-right">
                      {w.status === "FAILED" && canManage && (
                        <ReprocessWebhookButton webhookEventId={w.id} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
