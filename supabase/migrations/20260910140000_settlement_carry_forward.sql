-- ============================================================================
-- Marketplace — minimum-safe 3P settlement fix (Phase 9F-42B)
--
-- ADDITIVE ONLY. One new nullable column, companion to the Prisma schema change:
--   SellerSettlement.carryForwardAmount  Int?   -- unpaid clawback residual
--                                               -- carried to the seller's next
--                                               -- settlement (>= 0)
--
-- It does NOT:
--   - add a column to any other table;
--   - drop / rename / re-type any column;
--   - add a default, an index, a constraint or a trigger;
--   - change any existing row. Every current SellerSettlement row keeps
--     carryForwardAmount NULL — NO BACKFILL. NULL is read as 0.
--
-- The other 9F-42B fixes are pure application logic (settlement eligibility now
-- also requires Order.paymentStatus = 'PAID'; pre-settlement returned
-- merchandise value is deducted from the settlement receivable). They touch no
-- schema and no existing row.
--
-- No change to the return state machine, refund calculation, commission
-- calculation / timing / rounding, the post-settlement clawback mechanism, or
-- OfferInventory restock. Historical SellerSettlement rows are never mutated.
-- marketplace.multiSellerCheckout is unaffected. PayMongo stays dormant.
--
-- Idempotent — safe to re-run. Applied via:
--   node --env-file=.env scripts/apply-sql.mjs \
--     supabase/migrations/20260910140000_settlement_carry_forward.sql
-- ============================================================================

BEGIN;

ALTER TABLE "SellerSettlement"
  ADD COLUMN IF NOT EXISTS "carryForwardAmount" INTEGER;

COMMIT;
