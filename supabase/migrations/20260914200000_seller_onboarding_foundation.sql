-- ============================================================================
-- Seller Onboarding — schema foundation only (Phase 1)
--
-- ADDITIVE ONLY. Companion to the Prisma schema changes:
--   Seller.applicantUserId  String?   -- the applicant's User.id for a
--                                     -- self-service application; null for
--                                     -- today's only path (admin-created)
--   + new model SellerInvite (owner invitation/claim; inert until wired)
--
-- It does NOT:
--   - add a column to any table other than Seller;
--   - drop / rename / re-type any existing column;
--   - add or change a default, or touch any existing index / constraint on
--     Seller, SellerUser, or any other table;
--   - change any existing row. Every current Seller row keeps
--     "applicantUserId" NULL — NO BACKFILL. A NULL value reads exactly as
--     today's admin-created seller (no applicant to attribute).
--   - create any SellerInvite row.
--
-- The only new indexes/constraints belong to Seller.applicantUserId (one new
-- index) and the brand-new, empty SellerInvite table. SellerInvite carries no
-- RLS entry, matching Seller / SellerUser / Offer — these marketplace tables
-- are reached only through Prisma's own service connection, never through a
-- client-side Supabase (anon/authenticated) role (see
-- supabase/migrations/20260829140100_rls_and_grants.sql, which does not list
-- Seller or SellerUser either).
--
-- No change to: seller lifecycle transitions (PENDING/APPROVED/REJECTED/
-- SUSPENDED/CLOSED), transitionSellerAction, createSeller, the Seller Portal
-- session gate (src/lib/seller/session.ts), seller-lifecycle emails, any
-- storefront route, or any admin UI. Nothing in the application reads or
-- writes Seller.applicantUserId or SellerInvite yet — this migration lands
-- the tables ahead of the behavior that will use them in a later phase.
--
-- Idempotent — safe to re-run. Applied via:
--   node --env-file=.env scripts/apply-sql.mjs \
--     supabase/migrations/20260914200000_seller_onboarding_foundation.sql
-- ============================================================================

BEGIN;

-- 1. Seller — one additive nullable column -----------------------------------
ALTER TABLE "Seller"
  ADD COLUMN IF NOT EXISTS "applicantUserId" TEXT;

CREATE INDEX IF NOT EXISTS "Seller_applicantUserId_idx" ON "Seller" ("applicantUserId");

-- 2. SellerInvite — new, empty ------------------------------------------------
CREATE TABLE IF NOT EXISTS "SellerInvite" (
  "id"               TEXT NOT NULL,
  "sellerId"         TEXT NOT NULL,
  "email"            TEXT NOT NULL,
  "status"           TEXT NOT NULL DEFAULT 'PENDING',
  "invitedById"      TEXT,
  "acceptedByUserId" TEXT,
  "acceptedAt"       TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SellerInvite_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "SellerInvite"
    ADD CONSTRAINT "SellerInvite_sellerId_fkey"
    FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "SellerInvite"
    ADD CONSTRAINT "SellerInvite_invitedById_fkey"
    FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "SellerInvite"
    ADD CONSTRAINT "SellerInvite_acceptedByUserId_fkey"
    FOREIGN KEY ("acceptedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "SellerInvite_sellerId_idx" ON "SellerInvite" ("sellerId");
CREATE INDEX IF NOT EXISTS "SellerInvite_email_idx"    ON "SellerInvite" ("email");
CREATE INDEX IF NOT EXISTS "SellerInvite_status_idx"   ON "SellerInvite" ("status");

COMMIT;

-- Reversal (manual, not run here):
--   DROP TABLE IF EXISTS "SellerInvite";
--   ALTER TABLE "Seller" DROP COLUMN IF EXISTS "applicantUserId";
