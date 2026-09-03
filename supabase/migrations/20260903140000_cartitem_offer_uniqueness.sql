-- ============================================================================
-- Marketplace — CartItem multi-seller uniqueness (Phase 9E-2)
--
-- Companion to the Prisma schema change:
--   CartItem.offerId  String?  ->  String  (REQUIRED)
--   FK CartItem.offerId  ON DELETE SET NULL  ->  ON DELETE CASCADE
--   @@unique([cartId, variantId])  ->  @@unique([cartId, offerId])
--
-- This lets one Cart hold two lines for the SAME Variant when they are
-- different Sellers' Offers, while keeping at most one line per Offer.
--
-- ⚠️  DEPLOY BOUNDARY — apply this migration ATOMICALLY with the 9E-2 application
--     release, NOT before. The pre-9E-2 code (`9d4c82c`) does
--     `INSERT … ON CONFLICT ("cartId","variantId")`; dropping that unique index
--     while the old code is live breaks add-to-cart. dev + prod share ONE DB.
--
-- Pre-flight (must all hold before running — see scripts/reconcile-cartitem-offer-9e2.ts):
--   • CartItem.offerId          NULL count = 0
--   • duplicate (cartId, offerId) = 0
--   • every offerId references an ACTIVE Offer whose variantId = CartItem.variantId
--   • no THIRD_PARTY ACTIVE Offer exists
--
-- Does NOT touch: Order, OrderItem, Inventory, OfferInventory, Seller, Payment,
-- Cart. No column dropped or renamed. `variantId` is retained.
--
-- Idempotent. Applied via:
--   npx prisma db execute --url "$DIRECT_URL" \
--     --file supabase/migrations/20260903140000_cartitem_offer_uniqueness.sql
-- ============================================================================

BEGIN;

-- 1. offerId becomes REQUIRED (all rows already populated by the 9E-1 backfill).
ALTER TABLE "CartItem" ALTER COLUMN "offerId" SET NOT NULL;

-- 2. FK ON DELETE SET NULL -> CASCADE (a NOT-NULL column can't be nulled).
ALTER TABLE "CartItem" DROP CONSTRAINT IF EXISTS "CartItem_offerId_fkey";
ALTER TABLE "CartItem" ADD  CONSTRAINT "CartItem_offerId_fkey"
  FOREIGN KEY ("offerId") REFERENCES "Offer" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. Uniqueness: (cartId, variantId) -> (cartId, offerId).
--    Add the new one FIRST so there is never a window with no cart-line
--    uniqueness guard, then drop the old.
CREATE UNIQUE INDEX IF NOT EXISTS "CartItem_cartId_offerId_key"
  ON "CartItem" ("cartId", "offerId");
DROP INDEX IF EXISTS "CartItem_cartId_variantId_key";

-- 4. Plain indexes @@index([cartId]) / @@index([variantId]) / @@index([offerId])
--    are unchanged (the 9E-1 migration created CartItem_offerId_idx).

COMMIT;
