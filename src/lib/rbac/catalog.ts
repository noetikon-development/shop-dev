/**
 * RBAC catalogue — the single source of truth for the INITIAL set of roles,
 * permissions and role→permission grants.
 *
 * This file only *defines* the starting data. At runtime the application reads
 * roles and permissions from the database (Role / Permission / UserRole /
 * RolePermission), so operators can add roles, add permissions, and re-grant
 * without touching code. Re-run `npm run db:seed:rbac` after editing this file
 * to sync the database (it adds/updates rows; it never deletes assignments).
 *
 * Safe to import from both server and edge/client code — it is plain data.
 */

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export type PermissionDef = {
  key: string;
  group: string;
  description: string;
};

/** Every granular permission, in display order, grouped for the admin UI. */
export const PERMISSIONS: PermissionDef[] = [
  // Dashboard
  { key: "view_dashboard", group: "Dashboard", description: "Open the admin dashboard" },

  // Analytics
  { key: "view_analytics", group: "Analytics", description: "View store analytics and reports" },

  // Products
  { key: "view_products", group: "Products", description: "View products" },
  { key: "create_products", group: "Products", description: "Create products" },
  { key: "edit_products", group: "Products", description: "Edit products" },
  { key: "delete_products", group: "Products", description: "Delete products" },
  { key: "manage_product_images", group: "Products", description: "Manage product images" },

  // Categories
  { key: "view_categories", group: "Categories", description: "View categories" },
  { key: "create_categories", group: "Categories", description: "Create categories" },
  { key: "edit_categories", group: "Categories", description: "Edit categories" },
  { key: "delete_categories", group: "Categories", description: "Delete categories" },

  // Inventory
  { key: "view_inventory", group: "Inventory", description: "View inventory" },
  { key: "manage_inventory", group: "Inventory", description: "Adjust stock and inventory settings" },

  // Orders
  { key: "view_orders", group: "Orders", description: "View orders" },
  { key: "manage_orders", group: "Orders", description: "Update order status and fulfilment" },
  { key: "cancel_orders", group: "Orders", description: "Cancel orders" },

  // Customers
  { key: "view_customers", group: "Customers", description: "View customer accounts" },
  { key: "manage_customers", group: "Customers", description: "Edit customer accounts" },

  // Payments
  { key: "view_payments", group: "Payments", description: "View payments" },
  { key: "manage_payments", group: "Payments", description: "Reconcile and update payments" },
  { key: "issue_refunds", group: "Payments", description: "Issue refunds" },

  // Shipping
  { key: "view_shipping", group: "Shipping", description: "View shipping" },
  { key: "manage_shipping", group: "Shipping", description: "Manage shipping methods and rates" },

  // Marketing
  { key: "view_coupons", group: "Marketing", description: "View coupons" },
  { key: "manage_coupons", group: "Marketing", description: "Create and edit coupons" },
  { key: "view_promotions", group: "Marketing", description: "View promotions" },
  { key: "manage_promotions", group: "Marketing", description: "Manage promotions" },

  // Reviews
  { key: "view_reviews", group: "Reviews", description: "View product reviews" },
  { key: "manage_reviews", group: "Reviews", description: "Moderate product reviews" },

  // CMS
  { key: "view_content", group: "Content", description: "View site content" },
  { key: "manage_content", group: "Content", description: "Edit site content" },

  // Settings
  { key: "view_settings", group: "Settings", description: "View store settings" },
  { key: "manage_settings", group: "Settings", description: "Change store settings" },

  // Admin users
  { key: "view_admin_users", group: "Admin Users", description: "View administrators" },
  { key: "invite_admin_users", group: "Admin Users", description: "Invite administrators" },
  { key: "manage_admin_roles", group: "Admin Users", description: "Assign and remove admin roles" },

  // System
  { key: "view_audit_logs", group: "System", description: "View the admin audit log" },
];

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

/** Ordered list of permission groups as they appear in `PERMISSIONS`. */
export const PERMISSION_GROUPS: string[] = [...new Set(PERMISSIONS.map((p) => p.group))];

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export type RoleKey =
  | "SUPER_ADMIN"
  | "ADMIN"
  | "STAFF"
  | "SUPPORT"
  | "CONTENT_MANAGER"
  | "FINANCE";

export type RoleDef = {
  key: RoleKey;
  name: string;
  description: string;
};

export const ROLES: RoleDef[] = [
  { key: "SUPER_ADMIN", name: "Super Admin", description: "Unrestricted access, including admin user and role management." },
  { key: "ADMIN", name: "Admin", description: "General store management. No admin-user, refund, settings-write or audit access." },
  { key: "STAFF", name: "Staff", description: "Day-to-day operations across catalogue, inventory, orders and reviews." },
  { key: "SUPPORT", name: "Support", description: "Customer and order support." },
  { key: "CONTENT_MANAGER", name: "Content Manager", description: "Site content and review moderation." },
  { key: "FINANCE", name: "Finance", description: "Payments, refunds and financial visibility." },
];

export const ROLE_KEYS = ROLES.map((r) => r.key);

// ---------------------------------------------------------------------------
// Role → permission grants (the INITIAL mapping)
// ---------------------------------------------------------------------------

const ADMIN_PERMS: string[] = [
  "view_dashboard",
  "view_analytics",
  "view_products",
  "create_products",
  "edit_products",
  "delete_products",
  "manage_product_images",
  "view_categories",
  "create_categories",
  "edit_categories",
  "delete_categories",
  "view_inventory",
  "manage_inventory",
  "view_orders",
  "manage_orders",
  "cancel_orders",
  "view_customers",
  "manage_customers",
  "view_payments",
  "manage_payments",
  "view_shipping",
  "manage_shipping",
  "view_coupons",
  "manage_coupons",
  "manage_promotions",
  "view_reviews",
  "manage_reviews",
  "view_content",
  "manage_content",
  "view_settings",
];

const STAFF_PERMS: string[] = [
  "view_dashboard",
  "view_products",
  "edit_products",
  "manage_product_images",
  "view_categories",
  "view_inventory",
  "manage_inventory",
  "view_orders",
  "manage_orders",
  "view_customers",
  "view_shipping",
  "manage_shipping",
  "view_reviews",
  "manage_reviews",
];

const SUPPORT_PERMS: string[] = [
  "view_dashboard",
  "view_orders",
  "manage_orders",
  "view_customers",
  "manage_customers",
  "view_shipping",
  "view_reviews",
];

const CONTENT_MANAGER_PERMS: string[] = [
  "view_dashboard",
  "view_products",
  "view_categories",
  "view_content",
  "manage_content",
  "view_reviews",
  "manage_reviews",
  "view_promotions",
];

const FINANCE_PERMS: string[] = [
  "view_dashboard",
  "view_analytics",
  "view_orders",
  "view_payments",
  "manage_payments",
  "issue_refunds",
  "view_customers",
  "view_settings",
];

/**
 * The starting grant for each role. SUPER_ADMIN always receives every
 * permission in the catalogue (computed, so new permissions are covered
 * automatically).
 */
export const ROLE_PERMISSIONS: Record<RoleKey, string[]> = {
  SUPER_ADMIN: [...PERMISSION_KEYS],
  ADMIN: ADMIN_PERMS,
  STAFF: STAFF_PERMS,
  SUPPORT: SUPPORT_PERMS,
  CONTENT_MANAGER: CONTENT_MANAGER_PERMS,
  FINANCE: FINANCE_PERMS,
};

// Fail fast on a typo in the lists above.
for (const [role, keys] of Object.entries(ROLE_PERMISSIONS)) {
  for (const k of keys) {
    if (!PERMISSION_KEYS.includes(k)) {
      throw new Error(`RBAC catalogue: role ${role} references unknown permission "${k}"`);
    }
  }
}
