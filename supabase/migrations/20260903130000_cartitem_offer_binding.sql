-- ============================================================================
-- Marketplace — CartItem → Offer binding foundation (Phase 9E-1)
--
-- ADDITIVE ONLY. Companion to the Prisma schema change that adds
-- `CartItem.offerId String?` + relation `offer Offer?` (onDelete: SetNull).
--
-- This is the smallest reversible marketplace slice: a nullable column that
-- records which specific Offer a newly-created cart line is bound to. All
-- current ACTIVE offers belong to the Axiaro FIRST_PARTY seller, so this
-- migration changes NO customer-visible behaviour.
--
-- It does NOT:
--   - change CartItem uniqueness (@@unique([cartId, variantId]) is untouched)
--   - drop or rename any column
--   - touch Order / OrderItem / Inventory / OfferInventory / Seller / Cart rows
--
-- The currently deployed application keeps working unchanged whether or not it
-- reads `offerId`.
--
-- Idempotent — safe to re-run. Applied via:
--   npx prisma db execute --url "$DIRECT_URL" \
--     --file supabase/migrations/20260903130000_cartitem_offer_binding.sql
-- ============================================================================

-- 1. Nullable column -------------------------------------------------------
ALTER TABLE "CartItem" ADD COLUMN IF NOT EXISTS "offerId" TEXT;

-- 2. Index (matches Prisma's @@index([offerId])) --------------------------
CREATE INDEX IF NOT EXISTS "CartItem_offerId_idx" ON "CartItem" ("offerId");

-- 3. Foreign key → Offer(id), ON DELETE SET NULL -------------------------
--    A deleted Offer nulls the binding; the CartItem, its variantId, its
--    quantity and its priceSnapshot all remain intact.
ALTER TABLE "CartItem" DROP CONSTRAINT IF EXISTS "CartItem_offerId_fkey";
ALTER TABLE "CartItem" ADD  CONSTRAINT "CartItem_offerId_fkey"
  FOREIGN KEY ("offerId") REFERENCES "Offer" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 4. CartItem is RLS-on / no-policy (see 20260829140100_rls_and_grants.sql);
--    the new column needs no grant change — the app reaches CartItem only
--    through the direct postgres connection.
