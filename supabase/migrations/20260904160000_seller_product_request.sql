-- ============================================================================
-- Marketplace — Seller Product Requests (Phase 9F-5b)
--
-- ADDITIVE ONLY. Companion to the Prisma schema change that adds the
-- SellerProductRequest + SellerProductRequestImage models.
--
-- It does NOT:
--   - add any column to "Product" / "Variant" / "Category" / "ProductImage"
--     (canonical catalog ownership is untouched — no sellerId anywhere on them);
--   - drop or rename any column;
--   - change any existing row (both tables are brand new and start empty);
--   - touch Offer / OfferInventory / OfferAdjustment / Inventory /
--     InventoryAdjustment / Variant.stock / StoreSetting / the checkout writer /
--     the storefront / PayMongo.
--
-- A seller product request is a SUBMISSION RECORD only. The admin review +
-- canonical Product creation land in 9F-5c; this migration just gives that
-- workflow its data shape (status / reviewNote / reviewedById / resultProductId).
--
-- marketplace.multiSellerCheckout stays FALSE. No customer visibility.
--
-- Idempotent — safe to re-run. Applied via:
--   node --env-file=.env scripts/apply-sql.mjs \
--     supabase/migrations/20260904160000_seller_product_request.sql
-- ============================================================================

BEGIN;

-- 1. SellerProductRequest -----------------------------------------------------
CREATE TABLE IF NOT EXISTS "SellerProductRequest" (
  "id"                  TEXT NOT NULL,
  "sellerId"            TEXT NOT NULL,
  "status"              TEXT NOT NULL DEFAULT 'DRAFT',
  "proposedName"        TEXT NOT NULL,
  "proposedBrand"       TEXT,
  "proposedShortDesc"   TEXT,
  "proposedDescription" TEXT,
  "proposedCategoryId"  TEXT,
  "categoryNote"        TEXT,
  "barcode"             TEXT,
  "proposedVariants"    JSONB,
  "sellerNote"          TEXT,
  "reviewStatusNote"    TEXT,
  "reviewedById"        TEXT,
  "reviewedAt"          TIMESTAMP(3),
  "submittedAt"         TIMESTAMP(3),
  "resultProductId"     TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SellerProductRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SellerProductRequest_sellerId_idx" ON "SellerProductRequest" ("sellerId");
CREATE INDEX IF NOT EXISTS "SellerProductRequest_status_idx"   ON "SellerProductRequest" ("status");

ALTER TABLE "SellerProductRequest" DROP CONSTRAINT IF EXISTS spr_status_bounds;
ALTER TABLE "SellerProductRequest" ADD  CONSTRAINT spr_status_bounds CHECK (
  "status" IN ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED')
);

ALTER TABLE "SellerProductRequest" DROP CONSTRAINT IF EXISTS "SellerProductRequest_sellerId_fkey";
ALTER TABLE "SellerProductRequest" ADD  CONSTRAINT "SellerProductRequest_sellerId_fkey"
  FOREIGN KEY ("sellerId") REFERENCES "Seller" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SellerProductRequest" DROP CONSTRAINT IF EXISTS "SellerProductRequest_proposedCategoryId_fkey";
ALTER TABLE "SellerProductRequest" ADD  CONSTRAINT "SellerProductRequest_proposedCategoryId_fkey"
  FOREIGN KEY ("proposedCategoryId") REFERENCES "Category" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SellerProductRequest" DROP CONSTRAINT IF EXISTS "SellerProductRequest_resultProductId_fkey";
ALTER TABLE "SellerProductRequest" ADD  CONSTRAINT "SellerProductRequest_resultProductId_fkey"
  FOREIGN KEY ("resultProductId") REFERENCES "Product" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- `reviewedById` is a plain snapshot string (no FK) — same pattern as OrderItem.sellerId.

-- 2. SellerProductRequestImage ----------------------------------------------
CREATE TABLE IF NOT EXISTS "SellerProductRequestImage" (
  "id"           TEXT NOT NULL,
  "requestId"    TEXT NOT NULL,
  "mediaAssetId" TEXT NOT NULL,
  "sortOrder"    INTEGER NOT NULL DEFAULT 0,
  "role"         TEXT NOT NULL DEFAULT 'gallery',
  CONSTRAINT "SellerProductRequestImage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SellerProductRequestImage_requestId_mediaAssetId_key"
  ON "SellerProductRequestImage" ("requestId", "mediaAssetId");
CREATE INDEX IF NOT EXISTS "SellerProductRequestImage_requestId_idx"    ON "SellerProductRequestImage" ("requestId");
CREATE INDEX IF NOT EXISTS "SellerProductRequestImage_mediaAssetId_idx" ON "SellerProductRequestImage" ("mediaAssetId");

ALTER TABLE "SellerProductRequestImage" DROP CONSTRAINT IF EXISTS "SellerProductRequestImage_requestId_fkey";
ALTER TABLE "SellerProductRequestImage" ADD  CONSTRAINT "SellerProductRequestImage_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "SellerProductRequest" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SellerProductRequestImage" DROP CONSTRAINT IF EXISTS "SellerProductRequestImage_mediaAssetId_fkey";
ALTER TABLE "SellerProductRequestImage" ADD  CONSTRAINT "SellerProductRequestImage_mediaAssetId_fkey"
  FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. Security posture — RLS on, no policy; deny the public API roles.
--    (Same as every non-catalogue table; the app reaches these only through
--    the direct `postgres` connection.)
ALTER TABLE "SellerProductRequest"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SellerProductRequestImage" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "SellerProductRequest", "SellerProductRequestImage" FROM anon, authenticated;

COMMIT;
