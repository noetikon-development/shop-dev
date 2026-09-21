-- ============================================================================
-- Carrier-integration prerequisite data model (Phase 9F-47 foundation, Step 1)
--
-- ADDITIVE ONLY. Companion to the Prisma schema changes:
--   Seller.originAddress     Jsonb?      -- structured forward-shipment pickup
--                                        -- address, same shape as returnAddress
--   Product.lengthCm         Int?        -- PACKED shipping dimensions (cm) —
--   Product.widthCm          Int?           NOT the bare product's own size.
--   Product.heightCm         Int?           No placeholder default, unlike
--                                           weightGrams — NULL until a real
--                                           packed measurement is supplied.
--   Shipment.direction       Text        NOT NULL DEFAULT 'FORWARD'
--   Shipment.returnRequestId Text?       -- FK -> ReturnRequest, ON DELETE SET NULL
--   + ReturnRequest gets the Shipment[] back-relation (no column — Prisma
--     relation only, nothing to create here)
--
-- It does NOT:
--   - drop / rename / re-type any existing column;
--   - change any existing default other than adding Shipment.direction's own
--     (which every existing Shipment row receives as 'FORWARD' — see below);
--   - touch ProductImage, ProductOption, ProductOptionValue, Variant, Order,
--     SellerOrder, ShippingMethod, Payment, or any RLS policy;
--   - create, modify, or delete any row's business data. Only the schema
--     shape changes; content is untouched.
--
-- Existing-row behaviour:
--   - Every existing Seller row: originAddress = NULL (no seller has one yet).
--   - Every existing Product row: lengthCm / widthCm / heightCm = NULL (no
--     backfill, no placeholder — deliberately unlike weightGrams's @default).
--   - Every existing Shipment row (1 in Production today): direction becomes
--     'FORWARD' via the column default applied at ADD COLUMN time (a single
--     fast metadata-level rewrite on Postgres — no row-by-row UPDATE), and
--     returnRequestId = NULL. This is exactly the existing row's real
--     behaviour today (an outbound shipment) — no behavioural change.
--
-- No change to: the manual shipment workflow, resolveManualShipment,
-- saveSellerShipment (still enforces one Shipment per SellerOrder), the
-- ShippingProvider registry (still fails closed to MANUAL), SellerOrder
-- fulfilment transitions, Order.status transitions, checkout pricing,
-- free-shipping behaviour, customer tracking display, or the returns
-- workflow (ReturnRequest / ReturnItem / refund bookkeeping). No carrier
-- provider is registered, no environment variable is read, no return-
-- shipment workflow exists yet — this migration only prepares columns that
-- nothing in the application reads or writes.
--
-- Idempotent — safe to re-run. NOT applied by this task. Apply later, as a
-- separate explicit step, via:
--   node --env-file=.env scripts/apply-sql.mjs \
--     supabase/migrations/20260922070000_shipping_prerequisite_foundation.sql
-- ============================================================================

BEGIN;

-- 1. Seller — one additive nullable column -----------------------------------
ALTER TABLE "Seller"
  ADD COLUMN IF NOT EXISTS "originAddress" JSONB;

-- 2. Product — three additive nullable columns, NO default --------------------
ALTER TABLE "Product"
  ADD COLUMN IF NOT EXISTS "lengthCm" INTEGER,
  ADD COLUMN IF NOT EXISTS "widthCm"  INTEGER,
  ADD COLUMN IF NOT EXISTS "heightCm" INTEGER;

-- 3. Shipment — direction (defaulted, so every existing row reads as the
--    outbound shipment it already is) + nullable return-request link --------
ALTER TABLE "Shipment"
  ADD COLUMN IF NOT EXISTS "direction"       TEXT NOT NULL DEFAULT 'FORWARD',
  ADD COLUMN IF NOT EXISTS "returnRequestId" TEXT;

DO $$ BEGIN
  ALTER TABLE "Shipment"
    ADD CONSTRAINT "Shipment_returnRequestId_fkey"
    FOREIGN KEY ("returnRequestId") REFERENCES "ReturnRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "Shipment_direction_idx"       ON "Shipment" ("direction");
CREATE INDEX IF NOT EXISTS "Shipment_returnRequestId_idx" ON "Shipment" ("returnRequestId");

COMMIT;

-- Reversal (manual, not run here):
--   ALTER TABLE "Shipment" DROP CONSTRAINT IF EXISTS "Shipment_returnRequestId_fkey";
--   DROP INDEX IF EXISTS "Shipment_direction_idx";
--   DROP INDEX IF EXISTS "Shipment_returnRequestId_idx";
--   ALTER TABLE "Shipment"
--     DROP COLUMN IF EXISTS "direction", DROP COLUMN IF EXISTS "returnRequestId";
--   ALTER TABLE "Product"
--     DROP COLUMN IF EXISTS "lengthCm", DROP COLUMN IF EXISTS "widthCm", DROP COLUMN IF EXISTS "heightCm";
--   ALTER TABLE "Seller" DROP COLUMN IF EXISTS "originAddress";
