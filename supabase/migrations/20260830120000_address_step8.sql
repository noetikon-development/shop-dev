-- ============================================================================
-- Step 8 — Customer Addresses
--
-- Evolves the existing "Address" table: splits `recipient` into
-- firstName/lastName, adds company / country / updatedAt, and replaces the
-- single `isDefault` flag with independent `defaultShipping` / `defaultBilling`
-- flags guarded by partial unique indexes (at most one of each per user).
--
-- Idempotent — safe to re-run. Apply with DIRECT_URL:
--   npx prisma db execute --url "$DIRECT_URL" --file supabase/migrations/20260830120000_address_step8.sql
-- ============================================================================

-- 1. New columns (nullable first so existing rows survive) ---------------------
ALTER TABLE "Address" ADD COLUMN IF NOT EXISTS "firstName"       TEXT;
ALTER TABLE "Address" ADD COLUMN IF NOT EXISTS "lastName"        TEXT;
ALTER TABLE "Address" ADD COLUMN IF NOT EXISTS "company"         TEXT;
ALTER TABLE "Address" ADD COLUMN IF NOT EXISTS "country"         TEXT;
ALTER TABLE "Address" ADD COLUMN IF NOT EXISTS "defaultShipping" BOOLEAN;
ALTER TABLE "Address" ADD COLUMN IF NOT EXISTS "defaultBilling"  BOOLEAN;
ALTER TABLE "Address" ADD COLUMN IF NOT EXISTS "updatedAt"       TIMESTAMP(3);

-- 2. Backfill from the previous shape ----------------------------------------
UPDATE "Address" SET
  "firstName" = COALESCE(NULLIF(split_part(trim("recipient"), ' ', 1), ''), trim("recipient"))
WHERE "firstName" IS NULL;

UPDATE "Address" SET
  "lastName" = COALESCE(
    NULLIF(regexp_replace(trim("recipient"), '^\S+\s*', ''), ''),
    '-'  -- placeholder when the saved name was a single token
  )
WHERE "lastName" IS NULL;

UPDATE "Address" SET "country"         = 'PH'          WHERE "country" IS NULL;
UPDATE "Address" SET "updatedAt"       = "createdAt"   WHERE "updatedAt" IS NULL;

-- The old single default maps to "default for both purposes".
UPDATE "Address" SET "defaultShipping" = COALESCE("isDefault", false) WHERE "defaultShipping" IS NULL;
UPDATE "Address" SET "defaultBilling"  = COALESCE("isDefault", false) WHERE "defaultBilling"  IS NULL;

-- 3. Lock the new columns down ----------------------------------------------
ALTER TABLE "Address" ALTER COLUMN "firstName"       SET NOT NULL;
ALTER TABLE "Address" ALTER COLUMN "lastName"        SET NOT NULL;
ALTER TABLE "Address" ALTER COLUMN "country"         SET NOT NULL;
ALTER TABLE "Address" ALTER COLUMN "country"         SET DEFAULT 'PH';
ALTER TABLE "Address" ALTER COLUMN "updatedAt"       SET NOT NULL;
ALTER TABLE "Address" ALTER COLUMN "defaultShipping" SET NOT NULL;
ALTER TABLE "Address" ALTER COLUMN "defaultShipping" SET DEFAULT false;
ALTER TABLE "Address" ALTER COLUMN "defaultBilling"  SET NOT NULL;
ALTER TABLE "Address" ALTER COLUMN "defaultBilling"  SET DEFAULT false;

-- 4. Drop the replaced flag ------------------------------------------------
ALTER TABLE "Address" DROP COLUMN IF EXISTS "isDefault";

-- 5. Integrity: at most one default of each type per customer -------------
DROP INDEX IF EXISTS "address_default_shipping_uniq";
CREATE UNIQUE INDEX "address_default_shipping_uniq"
  ON "Address" ("userId") WHERE "defaultShipping" = true;

DROP INDEX IF EXISTS "address_default_billing_uniq";
CREATE UNIQUE INDEX "address_default_billing_uniq"
  ON "Address" ("userId") WHERE "defaultBilling" = true;

-- Helpful lookup indexes (also declared in prisma/schema.prisma)
CREATE INDEX IF NOT EXISTS "Address_userId_defaultShipping_idx" ON "Address" ("userId", "defaultShipping");
CREATE INDEX IF NOT EXISTS "Address_userId_defaultBilling_idx"  ON "Address" ("userId", "defaultBilling");

-- 6. Non-empty guards on the required name fields ------------------------
ALTER TABLE "Address" DROP CONSTRAINT IF EXISTS address_names_present;
ALTER TABLE "Address" ADD  CONSTRAINT address_names_present
  CHECK (length(trim("firstName")) > 0 AND length(trim("lastName")) > 0);

-- 7. RLS (matches the rest of the app: on, no policy) --------------------
ALTER TABLE "Address" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "Address" FROM anon, authenticated;
