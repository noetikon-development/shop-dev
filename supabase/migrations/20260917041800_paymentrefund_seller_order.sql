-- ============================================================================
-- PaymentRefund — seller attribution schema foundation (multi-seller refund
-- design, Option A). SCHEMA ONLY — no refund logic reads or writes this yet.
--
-- ADDITIVE ONLY. Companion to the Prisma schema change:
--   PaymentRefund.sellerOrderId  String?  -- nullable FK -> SellerOrder.id
--
-- It does NOT:
--   - add a column to any table other than PaymentRefund;
--   - alter Payment, ReturnRequest, or any SellerOrder field/column
--     (SellerOrder.paymentRefunds on the Prisma side is a VIRTUAL back-relation
--     only, computed from this FK — it adds no column/table to SellerOrder);
--   - add a PaymentRefundAllocation table (rejected for this phase — a single
--     nullable FK is sufficient for the currently-implemented
--     one-seller-per-refund-action model; see the architecture audit);
--   - drop / rename / re-type any existing column;
--   - change any existing row. Production carries 0 PaymentRefund rows today
--     (confirmed at authoring time), so there is nothing to backfill; the new
--     column is NULL on every existing and future pre-this-phase row.
--   - implement PayMongo refund logic, change refundRouteForOrder() /
--     initiateProviderRefund(), change cancellation / returns / settlement /
--     inventory / commission logic, or activate PayMongo in any environment.
--
-- NULL is the intentional, permanent state for:
--   - every row created before this phase (none exist in production today);
--   - a legacy / pre-marketplace order with no SellerOrder to attribute to;
--   - any future refund that genuinely cannot be attributed to one seller;
--   - every bookkeeping-only refund (ReturnRequest.refundAmount / refundMethod
--     / refundReference / refundInitiatedAt / refundCompletedAt) — that model
--     is completely separate and NEVER creates a PaymentRefund row, so this
--     column has no bearing on it whatsoever.
--
-- ON DELETE SET NULL: deleting a SellerOrder must never cascade-delete a
-- payment/refund record — the refund's own history (amount, provider id,
-- status, timestamps) must survive independently, exactly like
-- OrderItem.sellerOrderId's existing ON DELETE SET NULL behavior on the same
-- relationship shape.
--
-- PayMongo stays dormant in production (no PAYMONGO_* env there) — this
-- migration changes nothing about that; it only prepares a column no code path
-- populates yet.
--
-- Idempotent — safe to re-run. Applied via:
--   node --env-file=.env scripts/apply-sql.mjs \
--     supabase/migrations/20260917041800_paymentrefund_seller_order.sql
--
-- NOT applied to any database as part of authoring this file. An authorized
-- operator runs the command above explicitly, against whichever DATABASE_URL
-- their .env points at, when ready.
-- ============================================================================

BEGIN;

ALTER TABLE "PaymentRefund"
  ADD COLUMN IF NOT EXISTS "sellerOrderId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PaymentRefund_sellerOrderId_fkey'
  ) THEN
    ALTER TABLE "PaymentRefund"
      ADD CONSTRAINT "PaymentRefund_sellerOrderId_fkey"
      FOREIGN KEY ("sellerOrderId") REFERENCES "SellerOrder"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "PaymentRefund_sellerOrderId_idx"
  ON "PaymentRefund"("sellerOrderId");

COMMIT;

-- Reversal (manual, not run here):
--   ALTER TABLE "PaymentRefund" DROP CONSTRAINT IF EXISTS "PaymentRefund_sellerOrderId_fkey";
--   DROP INDEX IF EXISTS "PaymentRefund_sellerOrderId_idx";
--   ALTER TABLE "PaymentRefund" DROP COLUMN IF EXISTS "sellerOrderId";
