/**
 * The seller-portal information architecture — the single source of truth for
 * the `/seller` sidebar and breadcrumbs. Plain data; safe to import anywhere.
 *
 * Deliberately small in 9F-1: the portal foundation is Dashboard + Offers. Seller
 * orders / fulfilment / returns / settings / users land in later phases and are
 * added here one line at a time.
 */

export type SellerRoute = {
  path: string;
  label: string;
  /** shown when the visitor lacks the permission — still routable, gated per page */
  accepts?: string;
  /** true once a real screen exists */
  live?: boolean;
};

export const SELLER_ROUTES: SellerRoute[] = [
  { path: "/seller", label: "Dashboard", live: true },
  { path: "/seller/offers", label: "My Offers", accepts: "view_offers", live: true },
  { path: "/seller/orders", label: "Orders", accepts: "view_seller_orders", live: true },
  { path: "/seller/returns", label: "Returns", accepts: "manage_seller_returns", live: true },
  { path: "/seller/settings", label: "Settings", accepts: "manage_seller_settings", live: true },
];

export function sellerNav(permissions: Set<string>, role: string): SellerRoute[] {
  const can = (p?: string) => !p || role === "OWNER" || permissions.has(p);
  return SELLER_ROUTES.filter((r) => can(r.accepts));
}

const CRUMB_LABELS: Record<string, string> = {
  seller: "Seller",
  offers: "My Offers",
  new: "New offer",
  orders: "Orders",
  returns: "Returns",
  settings: "Settings",
};

export function sellerBreadcrumbs(pathname: string): { label: string; href?: string }[] {
  const parts = pathname.split("/").filter(Boolean); // ["seller", "offers", "abc"]
  const crumbs: { label: string; href?: string }[] = [];
  let acc = "";
  parts.forEach((part, i) => {
    acc += `/${part}`;
    const isLast = i === parts.length - 1;
    // an id segment (cuid-ish) shows contextually
    const idLabel =
      parts[i - 1] === "orders" ? "Order" : parts[i - 1] === "returns" ? "Return" : "Offer";
    const label = CRUMB_LABELS[part] ?? (/^[a-z0-9]{20,}$/i.test(part) ? idLabel : part);
    crumbs.push({ label, href: isLast ? undefined : acc });
  });
  return crumbs;
}
