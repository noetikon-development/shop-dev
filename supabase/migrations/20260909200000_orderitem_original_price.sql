-- ============================================================================
-- Marketplace — OrderItem historical discount snapshot (Phase 9F-38B)
--
-- ADDITIVE ONLY. Companion to the Prisma schema change that adds
-- `OrderItem.originalUnitPrice Int?`.
--
-- Purpose: preserve the original / compare-at ("was") price that existed at the
-- exact moment of purchase, so historical orders, receipts, and
-- order-confirmation emails can show the markdown the customer actually
-- received — even after the bound Offer's `compareAtPrice` changes or the Offer
-- is deleted. The checkout writer (src/lib/checkout.ts) begins populating it as
-- `boundOffer.compareAtPrice` (NULL when the Offer has no compare-at).
--
-- It does NOT:
--   - add a column to any other table;
--   - drop or rename any column;
--   - add a default or an index;
--   - change any existing row. Every current OrderItem row keeps
--     originalUnitPrice = NULL. See the BACKFILL note below.
--
-- DISPLAY / HISTORY ONLY. `originalUnitPrice` is NEVER added to any total. The
-- customer always pays `OrderItem.unitPrice`. Refund arithmetic
-- (unitPrice * quantity), commission (SellerOrder.commissionAmount /
-- OrderItem.commissionRate), settlement (sellerReceivable), and coupon
-- economics (discountFundedBy / discountAllocated) are all unchanged by this
-- migration and by 9F-38B.
--
-- ── BACKFILL: intentionally NONE. DO NOT backfill historical rows. ──
--   The compare-at price *at the time each historical order was placed* is
--   genuinely unrecoverable: the bound Offer's `compareAtPrice` may have changed
--   since, and `OrderItem.offerId` may be NULL after an Offer delete. Reading
--   the *current* Offer.compareAtPrice would fabricate a markdown that may never
--   have existed for that order — worse than NULL. Display code MUST treat NULL
--   as "no historical discount snapshot" and render exactly as it does today
--   (selling price / line total only, no "was" price, no percentage).
--
-- marketplace.multiSellerCheckout is unaffected.
--
-- Idempotent — safe to re-run. Applied via:
--   node --env-file=.env scripts/apply-sql.mjs \
--     supabase/migrations/20260909200000_orderitem_original_price.sql
-- ============================================================================

BEGIN;

ALTER TABLE "OrderItem"
  ADD COLUMN IF NOT EXISTS "originalUnitPrice" INTEGER;

COMMIT;
