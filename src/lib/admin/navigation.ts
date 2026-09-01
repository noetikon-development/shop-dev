/**
 * The admin information architecture — the single source of truth for:
 *   - the sidebar (grouped, permission-filtered)
 *   - breadcrumbs (derived from the current path)
 *   - route guards (each page/route enforces its own `accepts` permissions)
 *
 * Plain data — safe to import from server, client and edge code. Adding a
 * section is a one-line change here; the placeholder route and its guard pick
 * it up automatically.
 */

export type AdminRoute = {
  /** Full path, e.g. "/admin/marketing/coupons". "/admin" is the dashboard. */
  path: string;
  /** Label in the sidebar / breadcrumb / page header. */
  label: string;
  /** One-line description used on the foundation page's empty state. */
  description?: string;
  /** Sidebar group. Items with the same group are shown together under it. */
  group?: AdminGroupKey;
  /** Access is granted to a Super Admin or anyone holding ANY of these. */
  accepts: string[];
  /** Empty-state copy for the placeholder ("No products yet."). */
  emptyLabel?: string;
  /** true once a real screen exists (not a foundation placeholder). */
  live?: boolean;
  /** Hide from the sidebar (still routable + breadcrumbed). */
  hideInNav?: boolean;
};

export type AdminGroupKey = "catalog" | "marketing" | "content" | "admin";

export const ADMIN_GROUPS: Record<AdminGroupKey, { label: string; indexPath?: string }> = {
  catalog: { label: "Catalog" },
  marketing: { label: "Marketing", indexPath: "/admin/marketing" },
  content: { label: "Content", indexPath: "/admin/content" },
  admin: { label: "Admin" },
};

export const ADMIN_ROUTES: AdminRoute[] = [
  {
    path: "/admin",
    label: "Dashboard",
    description: "An overview of the store. Live metrics are wired in later steps.",
    accepts: ["view_dashboard"],
    live: true,
  },
  {
    path: "/admin/analytics",
    label: "Analytics",
    description: "Database-backed sales, product, customer, coupon and inventory reporting.",
    accepts: ["view_analytics"],
    emptyLabel: "No analytics to show yet.",
    live: true,
  },

  // Catalog
  {
    path: "/admin/products",
    label: "Products",
    description: "Create and manage the products in your catalog.",
    group: "catalog",
    accepts: ["view_products"],
    emptyLabel: "No products to manage here yet.",
    live: true,
  },
  {
    path: "/admin/categories",
    label: "Categories",
    description: "Organise the catalog into a browsable category tree.",
    group: "catalog",
    accepts: ["view_categories"],
    emptyLabel: "No categories to manage here yet.",
    live: true,
  },
  {
    path: "/admin/variants",
    label: "Variants",
    description: "Every product variant, with its SKU, price and status.",
    group: "catalog",
    accepts: ["view_products"],
    emptyLabel: "No variants to manage here yet.",
    live: true,
  },

  // Standalone sections
  {
    path: "/admin/inventory",
    label: "Inventory",
    description: "Stock levels, low-stock thresholds and adjustment history.",
    accepts: ["view_inventory"],
    emptyLabel: "No inventory records to show yet.",
    live: true,
  },
  {
    path: "/admin/orders",
    label: "Orders",
    description: "Review and fulfil customer orders.",
    accepts: ["view_orders"],
    emptyLabel: "No orders to manage here yet.",
    live: true,
  },
  {
    path: "/admin/returns",
    label: "Returns",
    description: "Review return requests, receive items and record refunds.",
    accepts: ["manage_returns"],
    emptyLabel: "No return requests yet.",
    live: true,
  },
  {
    path: "/admin/customers",
    label: "Customers",
    description: "Look up customer accounts, addresses and order history.",
    accepts: ["view_customers"],
    emptyLabel: "No customers to manage here yet.",
  },
  {
    path: "/admin/payments",
    label: "Payments",
    description: "Provider payment records, refund status and reconciliation.",
    accepts: ["view_payments"],
    emptyLabel: "No payment records yet.",
    live: true,
  },
  {
    path: "/admin/shipping",
    label: "Shipping",
    description: "Delivery methods and rates shown at checkout.",
    accepts: ["view_shipping"],
    emptyLabel: "No shipping methods yet.",
    live: true,
  },

  // Marketing
  {
    path: "/admin/marketing",
    label: "Marketing",
    description: "Coupons and promotional campaigns.",
    group: "marketing",
    accepts: ["view_coupons", "view_promotions"],
    hideInNav: true,
  },
  {
    path: "/admin/marketing/coupons",
    label: "Coupons",
    description: "Create and manage discount codes.",
    group: "marketing",
    accepts: ["view_coupons"],
    emptyLabel: "No coupons to manage here yet.",
    live: true,
  },
  {
    path: "/admin/marketing/promotions",
    label: "Promotions",
    description: "Run storewide and category promotions.",
    group: "marketing",
    accepts: ["view_promotions"],
    emptyLabel: "No promotions to manage here yet.",
  },

  {
    path: "/admin/reviews",
    label: "Reviews",
    description: "Moderate product reviews and ratings.",
    accepts: ["view_reviews"],
    emptyLabel: "No reviews to moderate yet.",
    live: true,
  },
  {
    path: "/admin/reviews/questions",
    label: "Q&A",
    description: "Moderate product questions and post official answers.",
    accepts: ["view_reviews"],
    emptyLabel: "No questions to moderate yet.",
    live: true,
    hideInNav: true,
  },

  // Content / CMS
  {
    path: "/admin/content",
    label: "Content",
    description: "Manage the storefront's editable content.",
    group: "content",
    accepts: ["view_content"],
    live: true,
  },
  {
    path: "/admin/content/homepage",
    label: "Homepage",
    description: "Arrange the homepage sections and their content.",
    group: "content",
    accepts: ["view_content"],
    emptyLabel: "No homepage sections defined yet.",
    live: true,
  },
  {
    path: "/admin/content/footer",
    label: "Footer",
    description: "The site-wide footer — brand text, link columns, newsletter copy and copyright.",
    group: "content",
    accepts: ["view_content"],
    emptyLabel: "The footer is using its built-in defaults.",
    live: true,
  },
  {
    path: "/admin/content/pages",
    label: "Pages",
    description: "Standalone content pages (About, policies, guides).",
    group: "content",
    accepts: ["view_content"],
    emptyLabel: "No content pages created yet.",
    live: true,
  },
  {
    path: "/admin/content/banners",
    label: "Banners",
    description: "Promotional banners are managed as homepage sections.",
    group: "content",
    accepts: ["view_content"],
    hideInNav: true,
  },
  {
    path: "/admin/content/collections",
    label: "Collections",
    description: "Curated product collections are managed as homepage product rails.",
    group: "content",
    accepts: ["view_content"],
    hideInNav: true,
  },
  {
    path: "/admin/media",
    label: "Media",
    description: "Images and files for products, categories and content.",
    group: "content",
    accepts: ["view_content"],
    emptyLabel: "No media uploaded yet.",
    live: true,
  },

  // Admin
  {
    path: "/admin/users",
    label: "Admin Users",
    description: "Invite administrators and manage their roles.",
    group: "admin",
    accepts: ["view_admin_users"],
    live: true,
  },
  {
    path: "/admin/email",
    label: "Email Log",
    description: "Transactional email delivery status.",
    group: "admin",
    accepts: ["view_audit_logs"],
    live: true,
  },
  {
    path: "/admin/audit",
    label: "Audit Log",
    description: "A record of security-relevant admin activity.",
    group: "admin",
    accepts: ["view_audit_logs"],
    live: true,
  },

  {
    path: "/admin/settings",
    label: "Settings",
    description: "Store identity, contact details, regional and integration settings.",
    accepts: ["view_settings"],
    live: true,
  },
];

const BY_PATH = new Map(ADMIN_ROUTES.map((r) => [r.path, r]));

export function getAdminRoute(path: string): AdminRoute | undefined {
  return BY_PATH.get(normalizePath(path));
}

function normalizePath(path: string): string {
  if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
  return path;
}

/** Can a permission set open this route? Super Admin is handled by callers. */
export function routeAllowed(route: AdminRoute, permissions: Set<string>): boolean {
  return route.accepts.some((p) => permissions.has(p));
}

export type Breadcrumb = { label: string; href?: string };

/** Dashboard → [group] → current page. The last crumb has no href. */
export function breadcrumbsFor(path: string): Breadcrumb[] {
  const route = getAdminRoute(path);
  const crumbs: Breadcrumb[] = [{ label: "Dashboard", href: "/admin" }];
  if (!route || route.path === "/admin") {
    return route ? [{ label: "Dashboard" }] : crumbs;
  }
  if (route.group) {
    const group = ADMIN_GROUPS[route.group];
    crumbs.push(
      group.indexPath
        ? { label: group.label, href: group.indexPath }
        : { label: group.label },
    );
  }
  crumbs.push({ label: route.label });
  return crumbs;
}

/** The sidebar model: grouped items + standalone items, in display order. */
export type SidebarEntry =
  | { kind: "item"; route: AdminRoute }
  | { kind: "group"; key: AdminGroupKey; label: string; items: AdminRoute[] };

export function buildSidebar(
  isSuperAdmin: boolean,
  permissions: Set<string>,
): SidebarEntry[] {
  const visible = (r: AdminRoute) =>
    !r.hideInNav && (isSuperAdmin || routeAllowed(r, permissions));

  const entries: SidebarEntry[] = [];
  const emittedGroups = new Set<AdminGroupKey>();

  for (const route of ADMIN_ROUTES) {
    if (!route.group) {
      if (visible(route)) entries.push({ kind: "item", route });
      continue;
    }
    if (emittedGroups.has(route.group)) continue;
    emittedGroups.add(route.group);
    const items = ADMIN_ROUTES.filter((r) => r.group === route.group && visible(r));
    if (items.length > 0) {
      entries.push({
        kind: "group",
        key: route.group,
        label: ADMIN_GROUPS[route.group].label,
        items,
      });
    }
  }
  return entries;
}
