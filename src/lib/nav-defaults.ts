import type { NavData, NavUtilityKey } from "@/lib/content-blocks";

/** The single primary-navigation ContentBlock. */
export const NAV_BLOCK_KEY = "nav.primary";

export type NavActionState = { ok?: boolean; error?: string };

/**
 * Header utility links (Track order / Promotions / All categories). The route
 * is owned by the app — the CMS only controls the label and visibility. The
 * key → route map lives here so nothing can point a utility link somewhere
 * unexpected.
 */
export const NAV_UTILITY_ROUTES: Record<NavUtilityKey, string> = {
  track: "/track",
  promotions: "/promotions",
  "all-categories": "/c/all",
};

export const NAV_UTILITY_LABELS: Record<NavUtilityKey, string> = {
  track: "Track order",
  promotions: "Promotions",
  "all-categories": "All categories",
};

/**
 * Virtual-collection slugs that resolve to `/c/<slug>` but are NOT `Category`
 * rows (handled by `SPECIAL` in the `/c/[slug]` route). They are valid nav /
 * footer destinations.
 */
export const NAV_SPECIAL_SLUGS = ["new", "sale", "all"] as const;

/**
 * Built-in primary navigation (Phase 5C).
 *
 * Used as the storefront fallback when the `nav.primary` ContentBlock is
 * absent / unpublished / unreadable / empty, and offered in the admin editor
 * as the "reset to defaults" starting point. It mirrors the pre-5C hardcoded
 * header exactly:
 *   New In · Living · Bedroom · Kitchen & Dining · Textiles · Lighting ·
 *   Decor · Wardrobe · Bags & Accessories · Sale
 * Category items carry a blank label so they follow `Category.name`; their
 * dropdowns are derived from the category's sub-categories.
 */
export const NAV_DEFAULTS: NavData = {
  items: [
    { label: "New In", categorySlug: "new", href: "", enabled: true, children: [] },
    { label: "", categorySlug: "living", href: "", enabled: true, children: [] },
    { label: "", categorySlug: "bedroom", href: "", enabled: true, children: [] },
    { label: "", categorySlug: "kitchen-dining", href: "", enabled: true, children: [] },
    { label: "", categorySlug: "textiles", href: "", enabled: true, children: [] },
    { label: "", categorySlug: "lighting", href: "", enabled: true, children: [] },
    { label: "", categorySlug: "decor", href: "", enabled: true, children: [] },
    { label: "", categorySlug: "wardrobe", href: "", enabled: true, children: [] },
    { label: "", categorySlug: "bags-accessories", href: "", enabled: true, children: [] },
    { label: "Sale", categorySlug: "sale", href: "", enabled: true, children: [] },
  ],
  utility: [
    { key: "track", label: "Track order", enabled: true },
    { key: "promotions", label: "Promotions", enabled: true },
    { key: "all-categories", label: "All categories", enabled: true },
  ],
};
