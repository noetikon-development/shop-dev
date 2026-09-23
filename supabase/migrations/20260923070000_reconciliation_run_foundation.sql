-- ============================================================================
-- Reconciliation execution/attempt tracking foundation.
--
-- ADDITIVE ONLY. Companion to the Prisma schema change:
--   ReconciliationRun (new table) — durable evidence that a reconciliation
--   invocation (scheduled CRON or a MANUAL CLI run) actually started, and
--   whether it later completed (PASS/WARN/FAIL) or hard-failed (ERROR).
--
-- Why this exists: AdminAuditLog's existing `reconciliation.run` row is only
-- ever written for a COMPLETED run — a hard execution failure (an exception
-- thrown before PASS/WARN/FAIL is determined) leaves zero durable trace
-- today. This table is the foundation for closing that gap. It does NOT
-- itself implement stale-run detection, alerting, a watchdog, or a dashboard
-- — those remain separate, future, explicitly-scoped work.
--
-- It does NOT:
--   - drop / rename / re-type any existing column or table;
--   - touch AdminAuditLog, WebhookEvent, Payment, PaymentRefund, Order,
--     SellerOrder, Shipment, SellerSettlement, Product, or Inventory;
--   - change any existing reconciliation rule, PASS/WARN/FAIL determination,
--     email-alert behavior, or HTTP response;
--   - create any row. The table starts empty.
--
-- Idempotent — safe to re-run.
--   node --env-file=.env scripts/apply-sql.mjs \
--     supabase/migrations/20260923070000_reconciliation_run_foundation.sql
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS "ReconciliationRun" (
    "id"               TEXT NOT NULL,
    "status"           TEXT NOT NULL DEFAULT 'RUNNING',
    "invocationSource" TEXT NOT NULL,
    "startedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt"      TIMESTAMP(3),
    "error"            TEXT,

    CONSTRAINT "ReconciliationRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ReconciliationRun_invocationSource_startedAt_idx"
  ON "ReconciliationRun" ("invocationSource", "startedAt");
CREATE INDEX IF NOT EXISTS "ReconciliationRun_status_idx"
  ON "ReconciliationRun" ("status");

COMMIT;

-- Reversal (manual, not run here):
--   DROP INDEX IF EXISTS "ReconciliationRun_status_idx";
--   DROP INDEX IF EXISTS "ReconciliationRun_invocationSource_startedAt_idx";
--   DROP TABLE IF EXISTS "ReconciliationRun";
