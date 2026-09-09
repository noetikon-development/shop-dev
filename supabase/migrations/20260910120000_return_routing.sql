-- ============================================================================
-- Marketplace — 3P return routing / seller return address (Phase 9F-41B)
--
-- ADDITIVE ONLY. Companion to the Prisma schema changes:
--   Seller.returnAddress            Json?   -- structured 3P return destination
--   ReturnRequest.returnDestination Json?   -- the frozen snapshot given to the
--   ReturnRequest.returnDestinationSetAt Timestamp? -- customer at approval
--
-- It does NOT:
--   - add a column to any other table;
--   - drop / rename / re-type any column;
--   - add a default, an index, a constraint or a trigger;
--   - change any existing row. Every current Seller row keeps returnAddress
--     NULL; every current ReturnRequest row keeps returnDestination /
--     returnDestinationSetAt NULL — NO BACKFILL.
--
-- `Seller.returnAddress` is part of the existing moderated profile bundle
-- (contentStatus DRAFT → PENDING → APPROVED); it is only consulted, once
-- APPROVED, by the return-routing snapshot written in `approveReturnAction`.
-- The snapshot is immutable — a later `Seller.returnAddress` or
-- `returns.instructions` edit never changes an already-approved return.
--
-- No change to the return state machine, refund calculation, commission
-- correction, settlement blocking / clawback, or OfferInventory restock.
-- marketplace.multiSellerCheckout is unaffected. PayMongo stays dormant.
--
-- Idempotent — safe to re-run. Applied via:
--   node --env-file=.env scripts/apply-sql.mjs \
--     supabase/migrations/20260910120000_return_routing.sql
-- ============================================================================

BEGIN;

ALTER TABLE "Seller"
  ADD COLUMN IF NOT EXISTS "returnAddress" JSONB;

ALTER TABLE "ReturnRequest"
  ADD COLUMN IF NOT EXISTS "returnDestination" JSONB;

ALTER TABLE "ReturnRequest"
  ADD COLUMN IF NOT EXISTS "returnDestinationSetAt" TIMESTAMP(3);

COMMIT;
