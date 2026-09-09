-- ============================================================================
-- Marketplace — Seller Product Request: proposed condition (Phase 9F-36B)
--
-- ADDITIVE ONLY. Companion to the Prisma schema change that adds
-- `SellerProductRequest.proposedCondition String?`.
--
-- It does NOT:
--   - add a column to any other table;
--   - drop or rename any column;
--   - change any existing row (the new column is NULL for every current row —
--     no backfill; a legacy NULL is treated as "NEW" during approval);
--   - create a second condition enum/model — the value reuses the canonical
--     Offer.condition vocabulary (NEW | REFURBISHED | OPEN_BOX | USED_LIKE_NEW
--     | USED_GOOD), validated in the application layer;
--   - touch Offer / OfferInventory / Product / Variant / the checkout writer /
--     the storefront / PayMongo / settlement.
--
-- The proposed condition flows through approval into the proposing seller's
-- seeded THIRD_PARTY DRAFT offers (`seedSellerDraftOffers`). The Axiaro
-- FIRST_PARTY offer stays NEW.
--
-- marketplace.multiSellerCheckout is unaffected. No customer visibility.
--
-- Idempotent — safe to re-run. Applied via:
--   node --env-file=.env scripts/apply-sql.mjs \
--     supabase/migrations/20260909180000_seller_request_condition.sql
-- ============================================================================

BEGIN;

ALTER TABLE "SellerProductRequest"
  ADD COLUMN IF NOT EXISTS "proposedCondition" TEXT;

COMMIT;
