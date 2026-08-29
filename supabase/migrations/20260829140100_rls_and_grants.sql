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
-- Cart (Step 7, 2026-08-30). Guest + customer carts are only ever read/written
-- through the app's direct `postgres` connection with server-side ownership
-- checks. Same posture: RLS on, no policy.
ALTER TABLE "Cart"               ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CartItem"           ENABLE ROW LEVEL SECURITY;
-- Shipping methods (Step 11, 2026-08-30). Read only by the app's direct
-- `postgres` connection. Same posture: RLS on, no policy.
ALTER TABLE "ShippingMethod"     ENABLE ROW LEVEL SECURITY;

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
  "ContentPage", "ContentBlock", "MediaAsset", "InventoryAdjustment",
  "Cart", "CartItem", "ShippingMethod"
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

-- ============================================================================
-- 7. Cart invariants (Step 7). src/lib/cart.ts also guards these; the DB is the
--    final authority under concurrent writes.
-- ============================================================================
-- Exactly one ACTIVE cart per signed-in customer.
DROP INDEX IF EXISTS "cart_active_user_uniq";
CREATE UNIQUE INDEX "cart_active_user_uniq"
  ON "Cart" ("userId")
  WHERE "userId" IS NOT NULL AND "status" = 'ACTIVE';

-- Every cart must have an owner (a customer or a guest token).
ALTER TABLE "Cart" DROP CONSTRAINT IF EXISTS cart_has_owner;
ALTER TABLE "Cart" ADD  CONSTRAINT cart_has_owner
  CHECK ("userId" IS NOT NULL OR "token" IS NOT NULL);

-- Line quantities are always positive and bounded.
ALTER TABLE "CartItem" DROP CONSTRAINT IF EXISTS cartitem_quantity_positive;
ALTER TABLE "CartItem" ADD  CONSTRAINT cartitem_quantity_positive
  CHECK ("quantity" > 0 AND "quantity" <= 99);

-- Snapshot price is never negative.
ALTER TABLE "CartItem" DROP CONSTRAINT IF EXISTS cartitem_price_nonneg;
ALTER TABLE "CartItem" ADD  CONSTRAINT cartitem_price_nonneg
  CHECK ("priceSnapshot" >= 0);

-- ============================================================================
-- 8. Customer address integrity (Step 8). At most one default shipping and one
--    default billing address per customer. The column transformation (split
--    recipient, drop isDefault, …) is a one-off in
--    supabase/migrations/20260830120000_address_step8.sql; this section is the
--    re-runnable integrity guard.
-- ============================================================================
DROP INDEX IF EXISTS "address_default_shipping_uniq";
CREATE UNIQUE INDEX "address_default_shipping_uniq"
  ON "Address" ("userId") WHERE "defaultShipping" = true;

DROP INDEX IF EXISTS "address_default_billing_uniq";
CREATE UNIQUE INDEX "address_default_billing_uniq"
  ON "Address" ("userId") WHERE "defaultBilling" = true;

ALTER TABLE "Address" DROP CONSTRAINT IF EXISTS address_names_present;
ALTER TABLE "Address" ADD  CONSTRAINT address_names_present
  CHECK (length(trim("firstName")) > 0 AND length(trim("lastName")) > 0);

REVOKE ALL ON "Address" FROM anon, authenticated;

-- ============================================================================
-- 9. Order-number sequence (Step 9). Collision-free order numbers under
--    concurrent checkout — replaces the old Math.random() 4-digit suffix.
--    Order numbers are AX-<YYMMDD>-<nextval, zero-padded to 5>. Started above
--    every existing/seed order number.
-- ============================================================================
CREATE SEQUENCE IF NOT EXISTS "order_number_seq" AS bigint INCREMENT BY 1 MINVALUE 100001 START WITH 100001;

-- ============================================================================
-- 10. Shipping method invariants (Step 11). src/lib/shipping.ts also guards
--     these; the DB is the final authority.
-- ============================================================================
ALTER TABLE "ShippingMethod" DROP CONSTRAINT IF EXISTS shippingmethod_rate_nonneg;
ALTER TABLE "ShippingMethod" ADD  CONSTRAINT shippingmethod_rate_nonneg CHECK ("rate" >= 0);
