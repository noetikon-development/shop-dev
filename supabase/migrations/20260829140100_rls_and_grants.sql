-- ============================================================================
-- Row Level Security + API-role grants
--
-- The application connects to Postgres directly with the `postgres` role
-- (BYPASSRLS), so none of this affects Prisma queries. This locks down the
-- auto-generated PostgREST API (anon / authenticated roles + public anon key):
--   * catalogue tables  -> read-only for everyone
--   * everything else    -> no access at all (RLS on, no policy)
-- ============================================================================

-- 1. Drop Supabase's permissive default grants on the public API roles ---------
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;

-- 2. Enable RLS on every table ----------------------------------------------------
ALTER TABLE "User"                ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Address"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Category"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Product"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductImage"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductOption"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductOptionValue"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Variant"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VariantOptionValue"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Inventory"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Review"              ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WishlistItem"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Coupon"              ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Order"               ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrderItem"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrderEvent"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StoreSetting"        ENABLE ROW LEVEL SECURITY;

-- 3. Public, read-only catalogue via PostgREST -----------------------------------
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT ON
  "Category", "Product", "ProductImage", "ProductOption",
  "ProductOptionValue", "Variant", "VariantOptionValue", "Review"
TO anon, authenticated;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Category','Product','ProductImage','ProductOption',
    'ProductOptionValue','Variant','VariantOptionValue','Review'
  ] LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS "Public read %1$s" ON %1$I;
       CREATE POLICY "Public read %1$s" ON %1$I FOR SELECT TO anon, authenticated USING (true);',
      t
    );
  END LOOP;
END $$;

-- 4. Everything else: RLS is on with no policy => anon / authenticated get
--    zero rows and cannot write. No further statements required.
