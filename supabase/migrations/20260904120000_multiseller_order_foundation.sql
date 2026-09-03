-- ============================================================================
-- Marketplace — Parent Order + SellerOrder + Shipment foundation (Phase 9E-3C-1)
--
-- ADDITIVE ONLY. Companion to the Prisma schema change that adds the
-- SellerOrder + Shipment models and four NULLABLE columns to OrderItem
-- (sellerOrderId / sellerId / offerId / commissionRate).
--
-- It does NOT:
--   - drop or rename any column (the legacy Order shipping / courier / tracking
--     columns stay in place — retiring them is a later phase);
--   - change Order / OrderItem economics for any existing row;
--   - touch Product / Variant / Offer / OfferInventory / Cart / Payment;
--   - change the checkout writer, cancellation, returns or the webhook.
--
-- Every existing production order is Axiaro-owned. The companion backfill
-- (scripts/backfill-multiseller-9e3c1.ts) gives each one EXACTLY ONE SellerOrder
-- (the FIRST_PARTY seller) with historical economics copied verbatim.
--
-- marketplace.multiSellerCheckout stays FALSE. The presence of these tables
-- never auto-enables multi-seller checkout.
--
-- Idempotent — safe to re-run. Applied via:
--   node --env-file=.env scripts/apply-sql.mjs \
--     supabase/migrations/20260904120000_multiseller_order_foundation.sql
-- ============================================================================

BEGIN;

-- 1. SellerOrder ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "SellerOrder" (
  "id"                      TEXT NOT NULL,
  "orderId"                 TEXT NOT NULL,
  "sellerId"                TEXT NOT NULL,
  "sellerName"              TEXT NOT NULL,
  "sellerType"              TEXT NOT NULL,
  "supportEmail"            TEXT NOT NULL,
  "commissionRate"          INTEGER NOT NULL DEFAULT 0,
  "shippingMethodCode"      TEXT,
  "shippingMethodName"      TEXT,
  "shippingFee"             INTEGER NOT NULL DEFAULT 0,
  "platformShippingSubsidy" INTEGER NOT NULL DEFAULT 0,
  "freeShippingApplied"     BOOLEAN,
  "merchandiseSubtotal"     INTEGER NOT NULL DEFAULT 0,
  "discountAllocated"       INTEGER NOT NULL DEFAULT 0,
  "discountFundedBy"        TEXT NOT NULL DEFAULT 'PLATFORM',
  "commissionAmount"        INTEGER NOT NULL DEFAULT 0,
  "total"                   INTEGER NOT NULL DEFAULT 0,
  "status"                  TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
  "settlementStatus"        TEXT NOT NULL DEFAULT 'PENDING_CAPTURE',
  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SellerOrder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SellerOrder_orderId_sellerId_key" ON "SellerOrder" ("orderId", "sellerId");
CREATE INDEX IF NOT EXISTS "SellerOrder_orderId_idx"          ON "SellerOrder" ("orderId");
CREATE INDEX IF NOT EXISTS "SellerOrder_sellerId_idx"         ON "SellerOrder" ("sellerId");
CREATE INDEX IF NOT EXISTS "SellerOrder_status_idx"           ON "SellerOrder" ("status");
CREATE INDEX IF NOT EXISTS "SellerOrder_settlementStatus_idx" ON "SellerOrder" ("settlementStatus");

ALTER TABLE "SellerOrder" DROP CONSTRAINT IF EXISTS "SellerOrder_orderId_fkey";
ALTER TABLE "SellerOrder" ADD  CONSTRAINT "SellerOrder_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SellerOrder" DROP CONSTRAINT IF EXISTS "SellerOrder_sellerId_fkey";
ALTER TABLE "SellerOrder" ADD  CONSTRAINT "SellerOrder_sellerId_fkey"
  FOREIGN KEY ("sellerId") REFERENCES "Seller" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Money / commission invariants (mirrors the Offer / Inventory CHECKs in
-- 20260903120000). The DB is the final authority under concurrent writes.
ALTER TABLE "SellerOrder" DROP CONSTRAINT IF EXISTS sellerorder_money_nonneg;
ALTER TABLE "SellerOrder" ADD  CONSTRAINT sellerorder_money_nonneg CHECK (
  "merchandiseSubtotal" >= 0 AND "discountAllocated" >= 0 AND "shippingFee" >= 0
  AND "platformShippingSubsidy" >= 0 AND "commissionAmount" >= 0 AND "total" >= 0
);
ALTER TABLE "SellerOrder" DROP CONSTRAINT IF EXISTS sellerorder_commission_bps_bounds;
ALTER TABLE "SellerOrder" ADD  CONSTRAINT sellerorder_commission_bps_bounds CHECK (
  "commissionRate" >= 0 AND "commissionRate" <= 10000
);
-- 9E-3B §15: total reconciles to the centavo, always.
ALTER TABLE "SellerOrder" DROP CONSTRAINT IF EXISTS sellerorder_total_reconciles;
ALTER TABLE "SellerOrder" ADD  CONSTRAINT sellerorder_total_reconciles CHECK (
  "total" = "merchandiseSubtotal" - "discountAllocated" + "shippingFee"
);

-- 2. Shipment -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "Shipment" (
  "id"             TEXT NOT NULL,
  "sellerOrderId"  TEXT NOT NULL,
  "carrier"        TEXT,
  "carrierName"    TEXT,
  "trackingNumber" TEXT,
  "trackingUrl"    TEXT,
  "status"         TEXT NOT NULL DEFAULT 'PENDING',
  "shippedAt"      TIMESTAMP(3),
  "deliveredAt"    TIMESTAMP(3),
  "note"           TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Shipment_sellerOrderId_idx" ON "Shipment" ("sellerOrderId");
CREATE INDEX IF NOT EXISTS "Shipment_status_idx"        ON "Shipment" ("status");
CREATE INDEX IF NOT EXISTS "Shipment_carrier_idx"       ON "Shipment" ("carrier");

ALTER TABLE "Shipment" DROP CONSTRAINT IF EXISTS "Shipment_sellerOrderId_fkey";
ALTER TABLE "Shipment" ADD  CONSTRAINT "Shipment_sellerOrderId_fkey"
  FOREIGN KEY ("sellerOrderId") REFERENCES "SellerOrder" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. OrderItem — four NULLABLE marketplace snapshot columns ---------------
ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "sellerOrderId"  TEXT;
ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "sellerId"       TEXT;
ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "offerId"        TEXT;
ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "commissionRate" INTEGER;

CREATE INDEX IF NOT EXISTS "OrderItem_sellerOrderId_idx" ON "OrderItem" ("sellerOrderId");
CREATE INDEX IF NOT EXISTS "OrderItem_sellerId_idx"      ON "OrderItem" ("sellerId");
CREATE INDEX IF NOT EXISTS "OrderItem_offerId_idx"       ON "OrderItem" ("offerId");

ALTER TABLE "OrderItem" DROP CONSTRAINT IF EXISTS "OrderItem_sellerOrderId_fkey";
ALTER TABLE "OrderItem" ADD  CONSTRAINT "OrderItem_sellerOrderId_fkey"
  FOREIGN KEY ("sellerOrderId") REFERENCES "SellerOrder" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OrderItem" DROP CONSTRAINT IF EXISTS "OrderItem_offerId_fkey";
ALTER TABLE "OrderItem" ADD  CONSTRAINT "OrderItem_offerId_fkey"
  FOREIGN KEY ("offerId") REFERENCES "Offer" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- `sellerId` is a plain snapshot string (no FK) — same pattern as OrderItem.productId.

ALTER TABLE "OrderItem" DROP CONSTRAINT IF EXISTS orderitem_commission_bps_bounds;
ALTER TABLE "OrderItem" ADD  CONSTRAINT orderitem_commission_bps_bounds CHECK (
  "commissionRate" IS NULL OR ("commissionRate" >= 0 AND "commissionRate" <= 10000)
);

-- 4. Security posture — RLS on, no policy; deny the public API roles.
--    (Same as every non-catalogue table; the app reaches these only through
--    the direct `postgres` connection.)
ALTER TABLE "SellerOrder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Shipment"    ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "SellerOrder", "Shipment" FROM anon, authenticated;

COMMIT;
