/**
 * Reconciliation stale-run watchdog — an independent check, scheduled daily
 * at 10:30 UTC (one hour after the 09:30 UTC reconciliation cron; the
 * current Vercel Hobby plan does not permit a sub-daily cron schedule), for
 * a `ReconciliationRun` row that started but never finished. This is the
 * one gap the job's own execution-failure alert
 * (`sendReconciliationFailureAlertOps`, see reconciliation-job.ts /
 * api/cron/reconciliation/route.ts) cannot cover: that alert only fires from
 * inside the job's own try/catch. If the Vercel function is killed (timeout,
 * OOM, deploy interruption) before either catch runs, the row is left at
 * RUNNING forever with no alert ever sent. This module is that missing
 * observer — see docs/reconciliation.md for the full design.
 *
 * Scope: `invocationSource = "CRON"` only. A long-running `MANUAL` invocation
 * (an operator's own CLI/admin-triggered run) is not evidence of an
 * infrastructure failure and must never be auto-flagged.
 *
 * Concurrency: every transition uses a guarded `updateMany` scoped by
 * `id` + `status: "RUNNING"`. If the real job (or a previous watchdog pass)
 * already moved the row to a terminal status before this update runs, the
 * guarded update matches 0 rows and this pass treats that row as already
 * resolved — no alert, no audit log, no overwrite of a legitimate result.
 *
 * This module never touches Order / SellerOrder / Payment / PaymentRefund /
 * ReturnRequest / Seller / SellerSettlement / Product / inventory data — its
 * only writes are the guarded `ReconciliationRun` transition, one
 * `AdminAuditLog` row, and whatever `EmailLog` bookkeeping the existing email
 * pipeline already does for the alert it sends.
 */
import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/lib/admin/audit";
import { sendReconciliationStaleRunAlertOps } from "@/lib/email/notifications";

type Client = Prisma.TransactionClient | PrismaClient;

/** Locked design decision — see docs/reconciliation.md. */
export const STALE_THRESHOLD_MINUTES = 30;

export type WatchdogResult = {
  checkedAt: string;
  staleFound: number;
  transitioned: number;
  alreadyResolved: number;
};

function staleMessage(): string {
  return `Stale RUNNING row detected by watchdog after ${STALE_THRESHOLD_MINUTES} minutes — reconciliation process likely terminated before completion.`;
}

export async function runReconciliationWatchdog(client: Client = prisma): Promise<WatchdogResult> {
  const checkedAt = new Date();
  const cutoff = new Date(checkedAt.getTime() - STALE_THRESHOLD_MINUTES * 60_000);

  const staleRuns = await client.reconciliationRun.findMany({
    where: { invocationSource: "CRON", status: "RUNNING", startedAt: { lt: cutoff } },
    select: { id: true, startedAt: true },
  });

  let transitioned = 0;
  let alreadyResolved = 0;

  for (const run of staleRuns) {
    // Guarded transition — only succeeds if the row is STILL RUNNING at the
    // moment of this write. A 0-row result means the real job (or a
    // concurrent watchdog pass) already resolved it since we read it above.
    const { count } = await client.reconciliationRun.updateMany({
      where: { id: run.id, status: "RUNNING" },
      data: { status: "ERROR", completedAt: checkedAt, error: staleMessage() },
    });

    if (count === 0) {
      alreadyResolved++;
      continue;
    }
    transitioned++;

    await writeAudit(
      {
        actorUserId: null,
        action: "reconciliation.stale_run_detected",
        targetType: "reconciliation_run",
        targetId: run.id,
        summary: `Reconciliation run ${run.id} marked ERROR by the stale-run watchdog (started ${run.startedAt.toISOString()}, exceeded the ${STALE_THRESHOLD_MINUTES}-minute threshold)`,
        meta: {
          reconciliationRunId: run.id,
          invocationSource: "CRON",
          startedAt: run.startedAt.toISOString(),
          detectedAt: checkedAt.toISOString(),
          staleThresholdMinutes: STALE_THRESHOLD_MINUTES,
        },
      },
      client,
    );

    // Only thread `client` through when it's genuinely a transaction client
    // (test callers running inside a rolled-back `prisma.$transaction`) — the
    // default singleton case lets the sender fall back to its own default,
    // exactly like every other sender in notifications.ts.
    const emailClient = client === prisma ? undefined : (client as Prisma.TransactionClient);
    await sendReconciliationStaleRunAlertOps({
      reconciliationRunId: run.id,
      startedAt: run.startedAt,
      detectedAt: checkedAt,
      staleThresholdMinutes: STALE_THRESHOLD_MINUTES,
      client: emailClient,
    });
  }

  return {
    checkedAt: checkedAt.toISOString(),
    staleFound: staleRuns.length,
    transitioned,
    alreadyResolved,
  };
}
