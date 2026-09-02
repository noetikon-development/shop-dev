-- ============================================================================
-- Marketplace — Seller + Offer foundation (Phase 9C)
--
-- Additive only. Companion to the Prisma `db push` that creates the tables
-- Seller / SellerUser / Offer / OfferInventory / OfferAdjustment.
--
-- Same security posture as every non-catalogue table in this store: RLS ON,
-- NO policy, and the public API roles (anon / authenticated) hold no grant.
-- The application reaches these tables only through the direct `postgres`
-- connection (BYPASSRLS); seller-scoped access is enforced in the application
-- layer (src/lib/marketplace/seller-repository.ts), not by an RLS policy.
--
-- Idempotent — safe to re-run.  Applied via:
--   npx prisma db execute --url "$DIRECT_URL" \
--     --file supabase/migrations/20260903120000_marketplace_offer_foundation.sql
-- ============================================================================

-- 1. RLS on, no policy -------------------------------------------------------
ALTER TABLE "Seller"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SellerUser"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Offer"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OfferInventory"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OfferAdjustment" ENABLE ROW LEVEL SECURITY;

-- 2. Deny the public API roles (belt-and-braces; ALTER DEFAULT PRIVILEGES in
--    the base RLS migration already covers new tables) ----------------------
REVOKE ALL ON
  "Seller", "SellerUser", "Offer", "OfferInventory", "OfferAdjustment"
FROM anon, authenticated;

-- 3. Stock + money invariants. The application also guards these
--    (src/lib/marketplace/seller-repository.ts), but the DB is the final
--    authority under concurrent writes — mirrors the Inventory constraints in
--    20260829140100_rls_and_grants.sql section 6.
ALTER TABLE "OfferInventory" DROP CONSTRAINT IF EXISTS offerinventory_quantity_nonneg;
ALTER TABLE "OfferInventory" ADD  CONSTRAINT offerinventory_quantity_nonneg  CHECK ("quantity" >= 0);
ALTER TABLE "OfferInventory" DROP CONSTRAINT IF EXISTS offerinventory_reserved_nonneg;
ALTER TABLE "OfferInventory" ADD  CONSTRAINT offerinventory_reserved_nonneg  CHECK ("reserved" >= 0);
ALTER TABLE "OfferInventory" DROP CONSTRAINT IF EXISTS offerinventory_available_nonneg;
ALTER TABLE "OfferInventory" ADD  CONSTRAINT offerinventory_available_nonneg CHECK ("quantity" >= "reserved");
ALTER TABLE "OfferInventory" DROP CONSTRAINT IF EXISTS offerinventory_reorder_nonneg;
ALTER TABLE "OfferInventory" ADD  CONSTRAINT offerinventory_reorder_nonneg   CHECK ("reorderPoint" >= 0);

ALTER TABLE "Offer" DROP CONSTRAINT IF EXISTS offer_price_nonneg;
ALTER TABLE "Offer" ADD  CONSTRAINT offer_price_nonneg          CHECK ("price" >= 0);
ALTER TABLE "Offer" DROP CONSTRAINT IF EXISTS offer_compareat_nonneg;
ALTER TABLE "Offer" ADD  CONSTRAINT offer_compareat_nonneg      CHECK ("compareAtPrice" IS NULL OR "compareAtPrice" >= 0);
ALTER TABLE "Offer" DROP CONSTRAINT IF EXISTS offer_cost_nonneg;
ALTER TABLE "Offer" ADD  CONSTRAINT offer_cost_nonneg           CHECK ("costPrice" IS NULL OR "costPrice" >= 0);
ALTER TABLE "Offer" DROP CONSTRAINT IF EXISTS offer_handling_nonneg;
ALTER TABLE "Offer" ADD  CONSTRAINT offer_handling_nonneg       CHECK ("handlingTimeDays" >= 0);

ALTER TABLE "Seller" DROP CONSTRAINT IF EXISTS seller_commission_bps_bounds;
ALTER TABLE "Seller" ADD  CONSTRAINT seller_commission_bps_bounds CHECK ("commissionRate" >= 0 AND "commissionRate" <= 10000);

-- 4. At most one FIRST_PARTY seller. A partial unique index enforces that the
--    Axiaro 1P seller can never be duplicated.
DROP INDEX IF EXISTS "seller_one_first_party";
CREATE UNIQUE INDEX "seller_one_first_party" ON "Seller" (("type")) WHERE "type" = 'FIRST_PARTY';

-- 5. OfferAdjustment history is append-only in spirit; no delete/update policy
--    is added here (RLS-on-no-policy already blocks the API roles, and the app
--    only ever INSERTs). Left as a note for the future.
