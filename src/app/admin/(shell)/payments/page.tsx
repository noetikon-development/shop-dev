import type { Metadata } from "next";
import { requirePermission } from "@/lib/admin/rbac";
import { listAdminPayments, getPaymentsAdminConfig, listStuckPayments } from "@/lib/admin/payments";
import { getPaymongoDiagnostics } from "@/lib/payments/diagnostics";
import { PageHeader, FilterBar, SearchInput, FilterSelect, Pagination, Card } from "@/components/admin/ui";
import { PaymentsTable } from "@/components/admin/payments/payments-table";
import { PAYMENT_STATUSES, paymentStatusLabel } from "@/lib/payments/status";

export const metadata: Metadata = { title: "Payments" };

const RANGE_OPTIONS = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
];

export default async function AdminPaymentsPage({ searchParams }: PageProps<"/admin/payments">) {
  await requirePermission("view_payments");
  const sp = await searchParams;
  const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

  const [{ rows, total, pageCount, page: current }, config, stuck, diag] = await Promise.all([
    listAdminPayments({
      q: str(sp.q),
      status: str(sp.status),
      range: str(sp.range),
      page: Number(sp.page ?? 1) || 1,
    }),
    getPaymentsAdminConfig(),
    listStuckPayments(),
    getPaymongoDiagnostics(),
  ]);

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
    </div>
  );
}
