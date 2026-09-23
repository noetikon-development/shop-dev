import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Reconciliation execution/attempt tracking (foundation only — no stale-run
 * detection, alerting, watchdog, or dashboard is implemented here).
 *
 * Deliberately NOT `"server-only"`: this module is used both by the
 * Next.js cron route (`src/app/api/cron/reconciliation/route.ts`, via
 * `reconciliation-job.ts`) and by the plain-Node CLI scripts
 * (`scripts/reconcile-payments.ts`, `scripts/reconcile-marketplace.ts`),
 * which run outside the `--conditions=react-server` context and would crash
 * on import if this pulled in a `"server-only"`-guarded module.
 *
 * `ReconciliationRun` is durable evidence that an invocation STARTED —
 * distinct from `AdminAuditLog`'s `reconciliation.run` row, which is only
 * ever written for a COMPLETED run. `invocationSource` is always supplied
 * explicitly by the caller — CRON_SECRET authenticating a request is proof
 * of authorization, never proof of *origin*, so it is never used to infer
 * this value.
 */

type Client = Prisma.TransactionClient | PrismaClient;

export type ReconciliationInvocationSource = "CRON" | "MANUAL";
export type ReconciliationRunStatus = "RUNNING" | "PASS" | "WARN" | "FAIL" | "ERROR";

/** Strips known secret-shaped substrings (credentialed URLs, bearer tokens,
 *  API-key-looking tokens, secret/token/apikey query params) from a caught
 *  error's message before it is ever placed into an outbound email or a
 *  database row. Reads only `Error.message` — never `.stack`, never the
 *  original request/headers — so there is no path for a raw Authorization
 *  header or connection string to reach either destination. */
export function sanitizeReconciliationError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const MAX_LEN = 400;
  const redacted = raw
    .replace(/(\w+:\/\/)[^\s@/]+:[^\s@/]+@/g, "$1***:***@")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***")
    .replace(/\b(sk|pk)_(live|test)_[A-Za-z0-9]+/g, "$1_$2_***")
    .replace(/([?&](?:password|apikey|api_key|token|secret)=)[^&\s]+/gi, "$1***");
  return redacted.length > MAX_LEN ? `${redacted.slice(0, MAX_LEN)}…` : redacted;
}

/** Create the RUNNING execution record for a reconciliation attempt, before
 *  either reconciliation check runs. Best-effort, like `writeAudit` — a
 *  failure to record this is logged and swallowed rather than aborting the
 *  reconciliation attempt itself; returns `null` in that case, and every
 *  other function in this module is then a safe no-op given a `null` id. */
export async function startReconciliationRun(
  invocationSource: ReconciliationInvocationSource,
  client: Client = prisma,
): Promise<string | null> {
  try {
    const row = await client.reconciliationRun.create({
      data: { status: "RUNNING", invocationSource },
      select: { id: true },
    });
    return row.id;
  } catch (err) {
    console.error("[reconciliation-run] failed to record execution start", err);
    return null;
  }
}

/** Mark a RUNNING execution record as completed with its final PASS/WARN/FAIL
 *  status. No-op for a `null` id (the start record itself failed to write). */
export async function completeReconciliationRun(
  id: string | null,
  status: Extract<ReconciliationRunStatus, "PASS" | "WARN" | "FAIL">,
  client: Client = prisma,
): Promise<void> {
  if (!id) return;
  await client.reconciliationRun
    .update({ where: { id }, data: { status, completedAt: new Date() } })
    .catch((err) => console.error("[reconciliation-run] failed to record execution completion", err));
}

/** Mark a RUNNING execution record as ERROR (a hard execution failure — the
 *  attempt threw before a PASS/WARN/FAIL result could be determined).
 *  `error` is sanitized via `sanitizeReconciliationError` before storage —
 *  never a raw stack trace, header, or credential. No-op for a `null` id. */
export async function failReconciliationRun(
  id: string | null,
  error: unknown,
  client: Client = prisma,
): Promise<void> {
  if (!id) return;
  await client.reconciliationRun
    .update({
      where: { id },
      data: { status: "ERROR", completedAt: new Date(), error: sanitizeReconciliationError(error) },
    })
    .catch((err) => console.error("[reconciliation-run] failed to record execution failure", err));
}
