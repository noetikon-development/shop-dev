-- ============================================================================
-- Marketplace — Seller Settlement / Payout Recording (Phase 9F-8e)
--
-- ADDITIVE ONLY. Companion to the Prisma schema change that adds the
-- SellerSettlement model and two nullable columns on SellerOrder
-- (settlementId, settlementClawbackAmount).
--
-- It does NOT:
--   - add SellerOrder.deliveredAt (eligibility keys off the parent Order);
--   - drop or rename any column;
--   - change any existing row (the new table starts empty; the two new
--     SellerOrder columns default to NULL / 0 for every existing row, which
--     means "never settled, nothing clawed back" — the correct starting state);
--   - touch Product / Variant / Offer / OfferInventory / Inventory / the
--     checkout writer / the commission calculation / the storefront / PayMongo /
--     scripts/seed-rbac.ts.
--
-- SETTLEMENT IS BOOKKEEPING-ONLY. An authorized admin (manage_payments) records
-- that a payment was made to a THIRD_PARTY seller outside the system. No real
-- bank / GCash / PayMongo transfer. `SellerOrder.settlementStatus` (already on
-- the model) is reused: PENDING_CAPTURE -> SETTLED -> CLAWED_BACK.
--
-- marketplace.multiSellerCheckout stays FALSE. No customer visibility change.
--
-- Idempotent — safe to re-run. Applied via:
--   node --env-file=.env scripts/apply-sql.mjs \
--     supabase/migrations/20260907120000_seller_settlement.sql
-- ============================================================================

BEGIN;

-- 1. SellerSettlement --------------------------------------------------------
CREATE TABLE IF NOT EXISTS "SellerSettlement" (
  "id"               TEXT NOT NULL,
  "sellerId"         TEXT NOT NULL,
  "sellerName"       TEXT NOT NULL,
  "status"           TEXT NOT NULL DEFAULT 'PAID',
  "grossReceivable"  INTEGER NOT NULL DEFAULT 0,
  "commissionAmount" INTEGER NOT NULL DEFAULT 0,
  "clawbackAmount"   INTEGER NOT NULL DEFAULT 0,
  "netAmount"        INTEGER NOT NULL DEFAULT 0,
  "orderCount"       INTEGER NOT NULL DEFAULT 0,
  "clawbackCount"    INTEGER NOT NULL DEFAULT 0,
  "paidAt"           TIMESTAMP(3) NOT NULL,
  "paymentReference" TEXT,
  "paymentMethod"    TEXT,
  "note"             TEXT,
  "createdById"      TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SellerSettlement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SellerSettlement_sellerId_idx" ON "SellerSettlement" ("sellerId");
CREATE INDEX IF NOT EXISTS "SellerSettlement_paidAt_idx"   ON "SellerSettlement" ("paidAt");

ALTER TABLE "SellerSettlement" DROP CONSTRAINT IF EXISTS "SellerSettlement_sellerId_fkey";
ALTER TABLE "SellerSettlement" ADD  CONSTRAINT "SellerSettlement_sellerId_fkey"
  FOREIGN KEY ("sellerId") REFERENCES "Seller" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- `createdById` is a plain snapshot string (no FK) — same pattern as OrderItem.sellerId.

-- 2. SellerOrder settlement columns ----------------------------------------
ALTER TABLE "SellerOrder" ADD COLUMN IF NOT EXISTS "settlementId"             TEXT;
ALTER TABLE "SellerOrder" ADD COLUMN IF NOT EXISTS "settlementClawbackAmount" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "SellerOrder_settlementId_idx" ON "SellerOrder" ("settlementId");

ALTER TABLE "SellerOrder" DROP CONSTRAINT IF EXISTS "SellerOrder_settlementId_fkey";
ALTER TABLE "SellerOrder" ADD  CONSTRAINT "SellerOrder_settlementId_fkey"
  FOREIGN KEY ("settlementId") REFERENCES "SellerSettlement" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 3. Security posture — RLS on, no policy; deny the public API roles.
ALTER TABLE "SellerSettlement" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "SellerSettlement" FROM anon, authenticated;

COMMIT;
