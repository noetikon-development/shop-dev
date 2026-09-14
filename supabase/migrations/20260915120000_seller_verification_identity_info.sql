-- ============================================================================
-- Seller Verification — identity/business information columns (Phase 2)
--
-- ADDITIVE ONLY. Companion to the Prisma schema changes: new nullable columns
-- on the existing "SellerVerification" table only (no new table this time).
--
-- It does NOT:
--   - add, drop, rename, or re-type any column on Seller, SellerUser,
--     SellerInvite, SellerVerificationDocument, MediaAsset, or any other
--     existing table;
--   - touch any existing column on SellerVerification itself (id, sellerId,
--     status, submittedAt, reviewedAt, reviewedBy, reviewNote, createdAt,
--     updatedAt all untouched);
--   - change any existing row — every column added here is nullable with no
--     default, so every current SellerVerification row (there are none yet —
--     Phase 1 shipped schema-only) is unaffected either way;
--   - create any SellerVerification or SellerVerificationDocument row.
--
-- No change to: seller lifecycle transitions, Seller Onboarding
-- (submit/approve/reject/reopen/claim), the Seller Portal session gate, any
-- seller-lifecycle email, any storefront route, or any admin UI. No document
-- upload, no government-ID-number column, no verification email, no gating
-- of Seller.status / SellerInvite / OWNER claim / Seller Portal access.
--
-- No RLS entry — matches every other seller-plane table (reached only
-- through Prisma's own service connection).
--
-- Idempotent — safe to re-run. Applied via:
--   node --env-file=.env scripts/apply-sql.mjs \
--     supabase/migrations/20260915120000_seller_verification_identity_info.sql
-- ============================================================================

BEGIN;

ALTER TABLE "SellerVerification"
  ADD COLUMN IF NOT EXISTS "legalName"                  TEXT,
  ADD COLUMN IF NOT EXISTS "phone"                      TEXT,
  ADD COLUMN IF NOT EXISTS "phoneVerifiedAt"             TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "addressLine1"                TEXT,
  ADD COLUMN IF NOT EXISTS "addressLine2"                TEXT,
  ADD COLUMN IF NOT EXISTS "barangay"                    TEXT,
  ADD COLUMN IF NOT EXISTS "city"                        TEXT,
  ADD COLUMN IF NOT EXISTS "province"                    TEXT,
  ADD COLUMN IF NOT EXISTS "postalCode"                  TEXT,
  ADD COLUMN IF NOT EXISTS "country"                     TEXT,
  ADD COLUMN IF NOT EXISTS "businessType"                TEXT,
  ADD COLUMN IF NOT EXISTS "businessName"                TEXT,
  ADD COLUMN IF NOT EXISTS "businessRegistrationNumber"  TEXT,
  ADD COLUMN IF NOT EXISTS "dtiRegistrationNumber"       TEXT,
  ADD COLUMN IF NOT EXISTS "secRegistrationNumber"       TEXT,
  ADD COLUMN IF NOT EXISTS "tin"                         TEXT;

COMMIT;

-- Reversal (manual, not run here):
--   ALTER TABLE "SellerVerification"
--     DROP COLUMN IF EXISTS "legalName",
--     DROP COLUMN IF EXISTS "phone",
--     DROP COLUMN IF EXISTS "phoneVerifiedAt",
--     DROP COLUMN IF EXISTS "addressLine1",
--     DROP COLUMN IF EXISTS "addressLine2",
--     DROP COLUMN IF EXISTS "barangay",
--     DROP COLUMN IF EXISTS "city",
--     DROP COLUMN IF EXISTS "province",
--     DROP COLUMN IF EXISTS "postalCode",
--     DROP COLUMN IF EXISTS "country",
--     DROP COLUMN IF EXISTS "businessType",
--     DROP COLUMN IF EXISTS "businessName",
--     DROP COLUMN IF EXISTS "businessRegistrationNumber",
--     DROP COLUMN IF EXISTS "dtiRegistrationNumber",
--     DROP COLUMN IF EXISTS "secRegistrationNumber",
--     DROP COLUMN IF EXISTS "tin";
