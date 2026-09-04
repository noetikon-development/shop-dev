-- ============================================================================
-- Marketplace — Seller store profile + seller-owned media (Phase 9F-4a)
--
-- ADDITIVE ONLY. Companion to the Prisma schema change that adds the seller
-- store-profile columns to "Seller" and a nullable "sellerId" to "MediaAsset".
--
-- It does NOT:
--   - drop or rename any column;
--   - change any existing Seller / MediaAsset row (every new column is nullable
--     or defaulted — contentStatus defaults to 'DRAFT', which is the correct
--     starting state for the one real seller (Axiaro) and the dev sandbox);
--   - touch Product / Variant / Offer / OfferInventory / Order / Inventory /
--     InventoryAdjustment / StoreSetting / the checkout writer / the storefront;
--   - grant any customer-facing visibility — nothing reads these columns on the
--     storefront in 9F-4a.
--
-- marketplace.multiSellerCheckout stays FALSE. PayMongo stays dormant.
--
-- Idempotent — safe to re-run. Applied via:
--   node --env-file=.env scripts/apply-sql.mjs \
--     supabase/migrations/20260904140000_seller_profile_foundation.sql
-- ============================================================================

BEGIN;

-- 1. Seller — store-profile columns --------------------------------------------
ALTER TABLE "Seller" ADD COLUMN IF NOT EXISTS "bio"                TEXT;
ALTER TABLE "Seller" ADD COLUMN IF NOT EXISTS "logoMediaId"        TEXT;
ALTER TABLE "Seller" ADD COLUMN IF NOT EXISTS "bannerMediaId"      TEXT;
ALTER TABLE "Seller" ADD COLUMN IF NOT EXISTS "returnPolicy"       TEXT;
ALTER TABLE "Seller" ADD COLUMN IF NOT EXISTS "shippingPolicy"     TEXT;
ALTER TABLE "Seller" ADD COLUMN IF NOT EXISTS "shipFromCity"       TEXT;
ALTER TABLE "Seller" ADD COLUMN IF NOT EXISTS "shipFromCountry"    TEXT;
ALTER TABLE "Seller" ADD COLUMN IF NOT EXISTS "socialLinks"        JSONB;
ALTER TABLE "Seller" ADD COLUMN IF NOT EXISTS "notifyEmail"        TEXT;
ALTER TABLE "Seller" ADD COLUMN IF NOT EXISTS "contentStatus"      TEXT NOT NULL DEFAULT 'DRAFT';
ALTER TABLE "Seller" ADD COLUMN IF NOT EXISTS "contentSubmittedAt" TIMESTAMP(3);
ALTER TABLE "Seller" ADD COLUMN IF NOT EXISTS "contentReviewedAt"  TIMESTAMP(3);
ALTER TABLE "Seller" ADD COLUMN IF NOT EXISTS "contentReviewedBy"  TEXT;
ALTER TABLE "Seller" ADD COLUMN IF NOT EXISTS "contentReviewNote"  TEXT;

-- Moderation state machine is DRAFT → PENDING → APPROVED. The DB is the final
-- authority under concurrent writes.
ALTER TABLE "Seller" DROP CONSTRAINT IF EXISTS seller_content_status_bounds;
ALTER TABLE "Seller" ADD  CONSTRAINT seller_content_status_bounds CHECK (
  "contentStatus" IN ('DRAFT', 'PENDING', 'APPROVED')
);

CREATE INDEX IF NOT EXISTS "Seller_contentStatus_idx" ON "Seller" ("contentStatus");

-- 2. MediaAsset — nullable owner column ---------------------------------------
ALTER TABLE "MediaAsset" ADD COLUMN IF NOT EXISTS "sellerId" TEXT;
CREATE INDEX IF NOT EXISTS "MediaAsset_sellerId_idx" ON "MediaAsset" ("sellerId");

ALTER TABLE "MediaAsset" DROP CONSTRAINT IF EXISTS "MediaAsset_sellerId_fkey";
ALTER TABLE "MediaAsset" ADD  CONSTRAINT "MediaAsset_sellerId_fkey"
  FOREIGN KEY ("sellerId") REFERENCES "Seller" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 3. Seller.logoMediaId / bannerMediaId → MediaAsset (SET NULL) ----------------
ALTER TABLE "Seller" DROP CONSTRAINT IF EXISTS "Seller_logoMediaId_fkey";
ALTER TABLE "Seller" ADD  CONSTRAINT "Seller_logoMediaId_fkey"
  FOREIGN KEY ("logoMediaId") REFERENCES "MediaAsset" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Seller" DROP CONSTRAINT IF EXISTS "Seller_bannerMediaId_fkey";
ALTER TABLE "Seller" ADD  CONSTRAINT "Seller_bannerMediaId_fkey"
  FOREIGN KEY ("bannerMediaId") REFERENCES "MediaAsset" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
