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
-- RBAC / admin (Step 3, 2026-08-30). Deny-all to the public API roles: the app
-- reads these only through the direct `postgres` connection (BYPASSRLS).
ALTER TABLE "Role"                ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Permission"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserRole"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RolePermission"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdminInvite"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdminAuditLog"       ENABLE ROW LEVEL SECURITY;
-- Admin Panel / CMS foundation (Step 4, 2026-08-30). Same posture.
ALTER TABLE "ContentPage"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ContentBlock"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MediaAsset"          ENABLE ROW LEVEL SECURITY;
-- Inventory adjustment history (Step 6, 2026-08-30). Same posture.
ALTER TABLE "InventoryAdjustment" ENABLE ROW LEVEL SECURITY;

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

-- 5. Belt-and-braces: explicitly strip any grants on the RBAC tables in case a
--    later CREATE TABLE picked up a default grant before step 1's ALTER DEFAULT
--    PRIVILEGES took effect.
REVOKE ALL ON
  "Role", "Permission", "UserRole", "RolePermission", "AdminInvite", "AdminAuditLog",
  "ContentPage", "ContentBlock", "MediaAsset", "InventoryAdjustment"
FROM anon, authenticated;

-- ============================================================================
-- 6. Inventory invariants (Step 6). The application (src/lib/inventory.ts) also
--    guards these, but the DB is the final authority under concurrent writes.
-- ============================================================================
ALTER TABLE "Inventory" DROP CONSTRAINT IF EXISTS inventory_quantity_nonneg;
ALTER TABLE "Inventory" ADD  CONSTRAINT inventory_quantity_nonneg  CHECK ("quantity" >= 0);
ALTER TABLE "Inventory" DROP CONSTRAINT IF EXISTS inventory_reserved_nonneg;
ALTER TABLE "Inventory" ADD  CONSTRAINT inventory_reserved_nonneg  CHECK ("reserved" >= 0);
ALTER TABLE "Inventory" DROP CONSTRAINT IF EXISTS inventory_available_nonneg;
ALTER TABLE "Inventory" ADD  CONSTRAINT inventory_available_nonneg CHECK ("quantity" >= "reserved");
ALTER TABLE "Inventory" DROP CONSTRAINT IF EXISTS inventory_reorder_nonneg;
ALTER TABLE "Inventory" ADD  CONSTRAINT inventory_reorder_nonneg   CHECK ("reorderPoint" >= 0);
