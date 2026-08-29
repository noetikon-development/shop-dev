/**
 * The admin navigation model. Each section maps to a route under /admin and the
 * permission(s) that grant access. Shared by the sidebar (to decide what to
 * show) and by the route handlers (to enforce access). Plain data — safe to
 * import anywhere.
 *
 * In Step 3 every section except Dashboard / Admin Users / Audit Log renders a
 * placeholder; the management tools land in Step 4.
 */

export type AdminSection = {
  slug: string; // path segment under /admin ("" = the dashboard index)
  label: string;
  /** Access is granted to a Super Admin or anyone holding ANY of these. */
  accepts: string[];
  /** true when a real screen exists today; false = placeholder */
  live: boolean;
};

export const ADMIN_SECTIONS: AdminSection[] = [
  { slug: "", label: "Dashboard", accepts: ["view_dashboard"], live: true },
  { slug: "products", label: "Products", accepts: ["view_products"], live: false },
  { slug: "categories", label: "Categories", accepts: ["view_categories"], live: false },
  { slug: "inventory", label: "Inventory", accepts: ["view_inventory"], live: false },
  { slug: "orders", label: "Orders", accepts: ["view_orders"], live: false },
  { slug: "customers", label: "Customers", accepts: ["view_customers"], live: false },
  { slug: "payments", label: "Payments", accepts: ["view_payments"], live: false },
  { slug: "shipping", label: "Shipping", accepts: ["view_shipping"], live: false },
  {
    slug: "marketing",
    label: "Marketing",
    accepts: ["view_coupons", "view_promotions"],
    live: false,
  },
  { slug: "reviews", label: "Reviews", accepts: ["view_reviews"], live: false },
  { slug: "content", label: "Content", accepts: ["view_content"], live: false },
  { slug: "settings", label: "Settings", accepts: ["view_settings"], live: false },
  { slug: "users", label: "Admin Users", accepts: ["view_admin_users"], live: true },
  { slug: "audit", label: "Audit Log", accepts: ["view_audit_logs"], live: true },
];

/** Sections that have their own route folder (not served by the [section] placeholder). */
export const ADMIN_RESERVED_SLUGS = new Set(["", "login", "accept", "users", "audit"]);

export function findAdminSection(slug: string): AdminSection | undefined {
  return ADMIN_SECTIONS.find((s) => s.slug === slug);
}

/** Can this permission set open the section? (Super Admin is handled by callers.) */
export function sectionVisibleFor(section: AdminSection, permissions: Set<string>): boolean {
  return section.accepts.some((p) => permissions.has(p));
}
