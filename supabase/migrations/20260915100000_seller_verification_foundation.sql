-- ============================================================================
-- Seller Verification — schema foundation only (Phase 1)
--
-- ADDITIVE ONLY. Companion to the Prisma schema changes:
--   + new model SellerVerification (per-seller verification case; status +
--     submitted/reviewed bookkeeping; inert until wired)
--   + new model SellerVerificationDocument (per-document metadata only —
--     NEVER a public URL, NEVER a signed URL, NEVER document content/number)
--   + Seller.sellerVerifications — back-relation only, no column on Seller
--
-- It does NOT:
--   - add, drop, rename, or re-type any column on Seller, SellerUser,
--     SellerInvite, MediaAsset, or any other existing table;
--   - touch any existing index / constraint;
--   - change any existing row in any table;
--   - create any SellerVerification or SellerVerificationDocument row.
--
-- No change to: seller lifecycle transitions, Seller Onboarding
-- (submit/approve/reject/reopen/claim), the Seller Portal session gate, any
-- seller-lifecycle email, any storefront route, or any admin UI. Nothing in
-- the application reads or writes these tables yet — this migration lands
-- them ahead of the workflow that will use them in a later phase, exactly
-- like supabase/migrations/20260914200000_seller_onboarding_foundation.sql
-- did for Seller Onboarding's own Phase 1.
--
-- No RLS entry — matches Seller / SellerUser / SellerInvite (reached only
-- through Prisma's own service connection, never a client-side Supabase role;
-- see supabase/migrations/20260829140100_rls_and_grants.sql, which does not
-- list any of those tables either).
--
-- Idempotent — safe to re-run. Applied via:
--   node --env-file=.env scripts/apply-sql.mjs \
--     supabase/migrations/20260915100000_seller_verification_foundation.sql
-- ============================================================================

BEGIN;

-- 1. SellerVerification — new, empty ------------------------------------------
CREATE TABLE IF NOT EXISTS "SellerVerification" (
  "id"          TEXT NOT NULL,
  "sellerId"    TEXT NOT NULL,
  "status"      TEXT NOT NULL DEFAULT 'DRAFT',
  "submittedAt" TIMESTAMP(3),
  "reviewedAt"  TIMESTAMP(3),
  "reviewedBy"  TEXT,
  "reviewNote"  TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SellerVerification_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "SellerVerification"
    ADD CONSTRAINT "SellerVerification_sellerId_fkey"
    FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "SellerVerification_sellerId_idx" ON "SellerVerification" ("sellerId");
CREATE INDEX IF NOT EXISTS "SellerVerification_status_idx"   ON "SellerVerification" ("status");

-- 2. SellerVerificationDocument — new, empty -----------------------------------
CREATE TABLE IF NOT EXISTS "SellerVerificationDocument" (
  "id"                   TEXT NOT NULL,
  "sellerVerificationId" TEXT NOT NULL,
  "documentType"         TEXT NOT NULL,
  "bucket"               TEXT NOT NULL,
  "storagePath"          TEXT NOT NULL,
  "mimeType"             TEXT NOT NULL,
  "sizeBytes"            INTEGER NOT NULL,
  "status"               TEXT NOT NULL DEFAULT 'PENDING',
  "uploadedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt"           TIMESTAMP(3),
  "reviewedBy"           TEXT,
  "reviewNote"           TEXT,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SellerVerificationDocument_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "SellerVerificationDocument"
    ADD CONSTRAINT "SellerVerificationDocument_sellerVerificationId_fkey"
    FOREIGN KEY ("sellerVerificationId") REFERENCES "SellerVerification"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "SellerVerificationDocument_bucket_storagePath_key"
  ON "SellerVerificationDocument" ("bucket", "storagePath");
CREATE INDEX IF NOT EXISTS "SellerVerificationDocument_sellerVerificationId_idx" ON "SellerVerificationDocument" ("sellerVerificationId");
CREATE INDEX IF NOT EXISTS "SellerVerificationDocument_documentType_idx"         ON "SellerVerificationDocument" ("documentType");
CREATE INDEX IF NOT EXISTS "SellerVerificationDocument_status_idx"               ON "SellerVerificationDocument" ("status");

COMMIT;

-- Reversal (manual, not run here):
--   DROP TABLE IF EXISTS "SellerVerificationDocument";
--   DROP TABLE IF EXISTS "SellerVerification";
