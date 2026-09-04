/**
 * Seller-scoped permission catalogue (Phase 9C scaffolding).
 *
 * ISOLATED from the global admin RBAC. These keys are NOT rows in the
 * `Permission` table, are NOT in src/lib/rbac/catalog.ts, and do NOT affect
 * `/admin` authorization in any way. They exist only so `SellerContext` can
 * carry a resolved permission set for a future /seller surface (none exists in
 * Phase 9C).
 *
 * The seller plane is permission-driven (like the admin plane), but the
 * role → permission mapping lives here in code rather than in tables — a
 * `SellerRole` / `SellerPermission` table pair is a later, additive step only
 * if sellers need finer-grained control.
 */

import type { SellerUserRole } from "@/lib/marketplace/types";

export const SELLER_PERMISSIONS = [
  "view_offers",
  "manage_offers",
  "manage_offer_inventory",
  "view_seller_orders",
  "manage_seller_fulfillment",
  "manage_seller_returns",
  "manage_seller_settings",
  "manage_seller_users",
] as const;

export type SellerPermission = (typeof SELLER_PERMISSIONS)[number];

/** Starting grant per seller role. OWNER holds everything. */
export const SELLER_ROLE_PERMISSIONS: Record<SellerUserRole, SellerPermission[]> = {
  OWNER: [...SELLER_PERMISSIONS],
  MANAGER: [
    "view_offers",
    "manage_offers",
    "manage_offer_inventory",
    "view_seller_orders",
    "manage_seller_fulfillment",
    "manage_seller_returns",
    // 9F-4a: store profile / settings. NOT manage_seller_users (that stays
    // OWNER-only, pending 9F-4b seller-user management).
    "manage_seller_settings",
  ],
  STAFF: ["view_offers", "view_seller_orders", "manage_seller_fulfillment"],
};

export function permissionsForSellerRole(role: SellerUserRole): Set<string> {
  return new Set(SELLER_ROLE_PERMISSIONS[role] ?? []);
}
