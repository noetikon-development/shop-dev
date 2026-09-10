-- ============================================================================
-- Marketplace — additive shipping / courier-API integration foundation (9F-47B)
--
-- ADDITIVE ONLY. Companion to the Prisma schema changes:
--   Shipment.provider              String?     -- "MANUAL" implied for old rows
--   Shipment.externalShipmentId    String?
--   Shipment.externalOrderId       String?
--   Shipment.service               String?
--   Shipment.labelUrl              String?
--   Shipment.shippingCostAmount    Int?        -- integer MINOR units (centavos)
--   Shipment.shippingCostCurrency  String?     -- "PHP" when populated
--   Shipment.estimatedDeliveryAt   Timestamp?
--   Shipment.lastCarrierStatus     String?
--   Shipment.lastCarrierStatusAt   Timestamp?
--   Shipment.metadata              Jsonb?
--   + new model ShipmentEvent (inert until the 9F-47E webhook handler ships)
--
-- It does NOT:
--   - add a column to any table other than Shipment;
--   - drop / rename / re-type any existing column;
--   - add or change a default, or touch any existing index / constraint on
--     Shipment;
--   - change any existing row. Every current Shipment row keeps ALL eleven new
--     columns NULL — NO BACKFILL. A NULL / "MANUAL" `provider` is read as a
--     manually-entered shipment and behaves exactly as before 9F-47B.
--   - create any ShipmentEvent row.
--
-- The only new indexes/constraints belong to the brand-new, empty ShipmentEvent
-- table. `ShipmentEvent_provider_providerEventId_key` is the replay-safety
-- claim-by-unique guard (same posture as WebhookEvent.providerId).
--
-- No change to: the manual shipment workflow, Shipment validation
-- (resolveShipment), SellerOrder fulfilment transitions, hasShippableShipment,
-- rollUpParentOrder, cascadeSellerOrderFromParent, customer shipment emails,
-- Order / OrderItem / OfferInventory / OfferAdjustment / Payment / settlement
-- logic. `shipping.integrationEnabled` is NOT enabled. PayMongo stays dormant.
--
-- Idempotent — safe to re-run. Applied via:
--   node --env-file=.env scripts/apply-sql.mjs \
--     supabase/migrations/20260910160000_shipping_foundation.sql
-- ============================================================================

BEGIN;

-- 1. Shipment — eleven additive nullable columns -----------------------------
ALTER TABLE "Shipment"
  ADD COLUMN IF NOT EXISTS "provider"             TEXT,
  ADD COLUMN IF NOT EXISTS "externalShipmentId"   TEXT,
  ADD COLUMN IF NOT EXISTS "externalOrderId"      TEXT,
  ADD COLUMN IF NOT EXISTS "service"              TEXT,
  ADD COLUMN IF NOT EXISTS "labelUrl"             TEXT,
  ADD COLUMN IF NOT EXISTS "shippingCostAmount"   INTEGER,
  ADD COLUMN IF NOT EXISTS "shippingCostCurrency" TEXT,
  ADD COLUMN IF NOT EXISTS "estimatedDeliveryAt"  TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastCarrierStatus"    TEXT,
  ADD COLUMN IF NOT EXISTS "lastCarrierStatusAt"  TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "metadata"             JSONB;

-- 2. ShipmentEvent — new, empty ---------------------------------------------
CREATE TABLE IF NOT EXISTS "ShipmentEvent" (
  "id"              TEXT NOT NULL,
  "shipmentId"      TEXT NOT NULL,
  "provider"        TEXT NOT NULL,
  "providerEventId" TEXT NOT NULL,
  "rawStatus"       TEXT NOT NULL,
  "normStatus"      TEXT NOT NULL,
  "description"     TEXT,
  "occurredAt"      TIMESTAMP(3) NOT NULL,
  "payloadHash"     TEXT NOT NULL,
  "status"          TEXT NOT NULL DEFAULT 'RECEIVED',
  "receivedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt"     TIMESTAMP(3),
  "error"           TEXT,
  CONSTRAINT "ShipmentEvent_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "ShipmentEvent"
    ADD CONSTRAINT "ShipmentEvent_shipmentId_fkey"
    FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "ShipmentEvent_provider_providerEventId_key"
  ON "ShipmentEvent" ("provider", "providerEventId");
CREATE INDEX IF NOT EXISTS "ShipmentEvent_shipmentId_idx"  ON "ShipmentEvent" ("shipmentId");
CREATE INDEX IF NOT EXISTS "ShipmentEvent_normStatus_idx"  ON "ShipmentEvent" ("normStatus");
CREATE INDEX IF NOT EXISTS "ShipmentEvent_status_idx"      ON "ShipmentEvent" ("status");

COMMIT;

-- Reversal (manual, not run here):
--   DROP TABLE IF EXISTS "ShipmentEvent";
--   ALTER TABLE "Shipment"
--     DROP COLUMN IF EXISTS "provider", DROP COLUMN IF EXISTS "externalShipmentId",
--     DROP COLUMN IF EXISTS "externalOrderId", DROP COLUMN IF EXISTS "service",
--     DROP COLUMN IF EXISTS "labelUrl", DROP COLUMN IF EXISTS "shippingCostAmount",
--     DROP COLUMN IF EXISTS "shippingCostCurrency", DROP COLUMN IF EXISTS "estimatedDeliveryAt",
--     DROP COLUMN IF EXISTS "lastCarrierStatus", DROP COLUMN IF EXISTS "lastCarrierStatusAt",
--     DROP COLUMN IF EXISTS "metadata";
