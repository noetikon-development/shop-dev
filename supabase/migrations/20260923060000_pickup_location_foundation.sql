-- ============================================================================
-- Store Pickup location schema foundation (Phase 9F-49 schema step).
--
-- ADDITIVE ONLY. Companion to the Prisma schema changes:
--   PickupLocation            (new table) — a customer-collects-in-person
--                              location. sellerId NULL = Axiaro-owned/global;
--                              sellerId set = a THIRD_PARTY seller's own
--                              pickup point. No lat/lng in this first pass.
--   SellerOrder.pickupLocationId        Text?  -- FK -> PickupLocation, ON
--                                               DELETE SET NULL
--   SellerOrder.pickupLocationSnapshot  Jsonb? -- frozen name+address, written
--                                               once a real selection flow
--                                               exists (none does yet)
--
-- It does NOT:
--   - drop / rename / re-type any existing column;
--   - touch ShippingMethod, Order, Inventory, Shipment, Seller.originAddress,
--     Seller.returnAddress, or any RLS policy;
--   - create, modify, or delete any row's business data. Only the schema
--     shape changes; content is untouched. No PickupLocation row is created
--     by this migration — the table starts empty.
--
-- Existing-row behaviour:
--   - Every existing SellerOrder row: pickupLocationId = NULL,
--     pickupLocationSnapshot = NULL (no backfill, no placeholder).
--   - The PickupLocation table starts with ZERO rows. The current "Batangas
--     City" pickup text remains exactly where it is today —
--     ShippingMethod.description on the PICKUP row — untouched by this
--     migration.
--
-- No change to: checkout, ShippingMethod.description, PICKUP shipping-method
-- behaviour, order creation, the manual/Lalamove shipment workflow, Inventory,
-- or Seller.originAddress / Seller.returnAddress. No UI reads or writes these
-- columns yet.
--
-- Idempotent — safe to re-run.
--   node --env-file=.env scripts/apply-sql.mjs \
--     supabase/migrations/20260923060000_pickup_location_foundation.sql
-- ============================================================================

BEGIN;

-- 1. PickupLocation — new table ------------------------------------------------
CREATE TABLE IF NOT EXISTS "PickupLocation" (
    "id"           TEXT NOT NULL,
    "sellerId"     TEXT,
    "name"         TEXT NOT NULL,
    "recipient"    TEXT NOT NULL,
    "phone"        TEXT NOT NULL,
    "line1"        TEXT NOT NULL,
    "line2"        TEXT,
    "barangay"     TEXT,
    "city"         TEXT NOT NULL,
    "province"     TEXT NOT NULL,
    "postalCode"   TEXT NOT NULL,
    "country"      TEXT NOT NULL,
    "instructions" TEXT,
    "active"       BOOLEAN NOT NULL DEFAULT true,
    "sortOrder"    INTEGER NOT NULL DEFAULT 0,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PickupLocation_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "PickupLocation"
    ADD CONSTRAINT "PickupLocation_sellerId_fkey"
    FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "PickupLocation_sellerId_idx" ON "PickupLocation" ("sellerId");
CREATE INDEX IF NOT EXISTS "PickupLocation_active_idx"   ON "PickupLocation" ("active");

-- 2. SellerOrder — two additive nullable columns, no default -------------------
ALTER TABLE "SellerOrder"
  ADD COLUMN IF NOT EXISTS "pickupLocationId"       TEXT,
  ADD COLUMN IF NOT EXISTS "pickupLocationSnapshot" JSONB;

DO $$ BEGIN
  ALTER TABLE "SellerOrder"
    ADD CONSTRAINT "SellerOrder_pickupLocationId_fkey"
    FOREIGN KEY ("pickupLocationId") REFERENCES "PickupLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "SellerOrder_pickupLocationId_idx" ON "SellerOrder" ("pickupLocationId");

COMMIT;

-- Reversal (manual, not run here):
--   ALTER TABLE "SellerOrder" DROP CONSTRAINT IF EXISTS "SellerOrder_pickupLocationId_fkey";
--   DROP INDEX IF EXISTS "SellerOrder_pickupLocationId_idx";
--   ALTER TABLE "SellerOrder"
--     DROP COLUMN IF EXISTS "pickupLocationId", DROP COLUMN IF EXISTS "pickupLocationSnapshot";
--   DROP TABLE IF EXISTS "PickupLocation";
