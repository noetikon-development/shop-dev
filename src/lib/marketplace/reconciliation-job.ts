/**
 * Automated reconciliation scheduling/alerting — the in-process job the
 * `/api/cron/reconciliation` route (and, in tests, a rolled-back transaction)
 * calls. Runs the two active, business-critical reconciliation checks
 * (payments, marketplace — NOT the legacy `reconcile:9e3d`), aggregates their
 * result, records ONE durable `AdminAuditLog` row per run (PASS included),
 * and — only for WARN/FAIL — sends one deduplicated ops alert email.
 *
 * Read-only against business data: the only write this ever performs is the
 * AdminAuditLog row (via the existing, best-effort `writeAudit` helper) plus
 * whatever `EmailLog` bookkeeping the existing email pipeline already does
 * for any outbound message. No Order / SellerOrder / Payment / PaymentRefund
 * / ReturnRequest / Seller / SellerSettlement / Product / inventory row is
 * ever touched.
 */
import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { runPaymentsReconciliation } from "./reconcile-payments-core";
import { runMarketplaceReconciliation } from "./reconcile-marketplace-core";
import { writeAudit } from "@/lib/admin/audit";
import { sendReconciliationAlertOps } from "@/lib/email/notifications";
import type { ReconciliationCheckResult } from "./reconciliation-types";
import {
  startReconciliationRun,
  completeReconciliationRun,
  failReconciliationRun,
  type ReconciliationInvocationSource,
} from "./reconciliation-run";

type Client = Prisma.TransactionClient | PrismaClient;

export type ReconciliationOverallStatus = "PASS" | "WARN" | "FAIL";

export type ReconciliationJobResult = {
  status: ReconciliationOverallStatus;
  runAt: string;
  payments: ReconciliationCheckResult;
  marketplace: ReconciliationCheckResult;
  auditLogId: string | null;
  /** The ReconciliationRun execution-tracking row for this attempt (see
   *  reconciliation-run.ts) — foundation for a future stale-run watchdog,
   *  distinct from auditLogId above. Null only if that row itself failed to
   *  write (best-effort, like writeAudit). */
  executionRunId: string | null;
  alertSent: boolean;
  alertDeduped: boolean;
};

const MAX_ALERT_DETAIL_LINES = 15;

function nonPassLines(result: ReconciliationCheckResult): string[] {
  return result.lines.filter((l) => l.level !== "PASS").map((l) => `[${result.name}] [${l.level}] ${l.message}`);
}

export async function runReconciliationJob(
  client: Client = prisma,
  invocationSource: ReconciliationInvocationSource = "MANUAL",
): Promise<ReconciliationJobResult> {
  const runAt = new Date();
  const executionRunId = await startReconciliationRun(invocationSource, client);

  let payments: ReconciliationCheckResult;
  let marketplace: ReconciliationCheckResult;
  try {
    payments = await runPaymentsReconciliation(client);
    marketplace = await runMarketplaceReconciliation(client);
  } catch (err) {
    // Hard execution failure — no PASS/WARN/FAIL result exists. Mark the
    // execution record ERROR, then rethrow unchanged so the caller's own
    // error handling (route.ts: console.error + sendReconciliationFailureAlertOps
    // + HTTP 500) fires exactly as it did before this record existed.
    await failReconciliationRun(executionRunId, err, client);
    throw err;
  }

  const status: ReconciliationOverallStatus =
    payments.fail > 0 || marketplace.fail > 0
      ? "FAIL"
      : payments.warn > 0 || marketplace.warn > 0
        ? "WARN"
        : "PASS";

  await completeReconciliationRun(executionRunId, status, client);

  const allDetails = [...nonPassLines(payments), ...nonPassLines(marketplace)];

  const auditLogId = await writeAudit(
    {
      actorUserId: null,
      action: "reconciliation.run",
      targetType: "reconciliation",
      targetId: null,
      summary: `Reconciliation ${status} — payments ${payments.pass}/${payments.warn}/${payments.fail}, marketplace ${marketplace.pass}/${marketplace.warn}/${marketplace.fail}`,
      meta: {
        status,
        runAt: runAt.toISOString(),
        payments: { pass: payments.pass, warn: payments.warn, fail: payments.fail, details: nonPassLines(payments) },
        marketplace: { pass: marketplace.pass, warn: marketplace.warn, fail: marketplace.fail, details: nonPassLines(marketplace) },
      },
    },
    client,
  );

  let alertSent = false;
  let alertDeduped = false;

  if (status !== "PASS") {
    const dateKey = runAt.toISOString().slice(0, 10);
    const shown = allDetails.slice(0, MAX_ALERT_DETAIL_LINES);
    const truncatedCount = allDetails.length - shown.length;
    // Only thread `client` through when it's genuinely a transaction client
    // (test callers running inside a rolled-back `prisma.$transaction`) — the
    // default singleton case lets `sendReconciliationAlertOps` fall back to
    // its own default, exactly like every other sender in notifications.ts.
    const emailClient = client === prisma ? undefined : (client as Prisma.TransactionClient);
    const result = await sendReconciliationAlertOps({
      status,
      runAt,
      dateKey,
      payments: { pass: payments.pass, warn: payments.warn, fail: payments.fail },
      marketplace: { pass: marketplace.pass, warn: marketplace.warn, fail: marketplace.fail },
      details: shown,
      truncatedCount,
      client: emailClient,
    });
    alertSent = result.ok && !result.deduped;
    alertDeduped = Boolean(result.deduped);
  }

  return {
    status,
    runAt: runAt.toISOString(),
    payments,
    marketplace,
    auditLogId,
    executionRunId,
    alertSent,
    alertDeduped,
  };
}
