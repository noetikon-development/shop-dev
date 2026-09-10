-- ============================================================================
-- PayMongo — WebhookEvent raw-payload + reprocess support (Phase 9F-54)
--
-- ADDITIVE ONLY. Companion to the Prisma schema change:
--   WebhookEvent.payload        TEXT       -- raw, signature-verified body
--   WebhookEvent.reprocessedAt  Timestamp? -- last admin reprocess attempt
--
-- It does NOT:
--   - add a column to any table other than WebhookEvent;
--   - drop / rename / re-type any existing column;
--   - add or change a default, or touch any existing index / constraint;
--   - change any existing row. Production carries 0 WebhookEvent rows today, so
--     there is nothing to backfill; both new columns are NULL on any future
--     pre-9F-54 row and read as "no stored payload / never reprocessed".
--
-- `payload` holds the raw request body that was ALREADY verified against the
-- Paymongo-Signature before being stored — it is authenticated data, never a
-- credential. RLS on WebhookEvent already revokes anon / authenticated
-- (supabase/migrations/20260829140100_rls_and_grants.sql). It exists so a
-- `manage_payments` admin can reprocess a FAILED event through the SAME
-- idempotent handler (`reprocessWebhookEvent`) without a PayMongo re-send.
--
-- No change to: the payment state machine, checkout-session creation, COD
-- confirmation, settlement, return-window, inventory, or shipping logic.
-- PayMongo stays dormant in production (no PAYMONGO_* env there).
--
-- Idempotent — safe to re-run. Applied via:
--   node --env-file=.env scripts/apply-sql.mjs \
--     supabase/migrations/20260910180000_webhookevent_payload.sql
-- ============================================================================

BEGIN;

ALTER TABLE "WebhookEvent"
  ADD COLUMN IF NOT EXISTS "payload"       TEXT,
  ADD COLUMN IF NOT EXISTS "reprocessedAt" TIMESTAMP(3);

COMMIT;

-- Reversal (manual, not run here):
--   ALTER TABLE "WebhookEvent"
--     DROP COLUMN IF EXISTS "payload", DROP COLUMN IF EXISTS "reprocessedAt";
