/** Shared result shape for the reconciliation core modules and the job that
 *  aggregates them (Phase — automated reconciliation scheduling/alerting).
 *  Pure types only — no I/O, no Prisma import. */

export type ReconciliationLevel = "PASS" | "WARN" | "FAIL";

export type ReconciliationLine = { level: ReconciliationLevel; message: string };

/** One reconciliation script's outcome (e.g. "payments" or "marketplace"). */
export type ReconciliationCheckResult = {
  name: string;
  pass: number;
  warn: number;
  fail: number;
  lines: ReconciliationLine[];
};
