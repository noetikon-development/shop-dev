import "server-only";
import { getCategoryTree } from "@/lib/data";
import { getNavBlock, getPublishedPageSlugs } from "@/lib/content";
import {
  NAV_DEFAULTS,
  NAV_SPECIAL_SLUGS,
  NAV_UTILITY_LABELS,
  NAV_UTILITY_ROUTES,
} from "@/lib/nav-defaults";
import type { NavData } from "@/lib/content-blocks";
import type {
  CategoryNode,
  ResolvedNav,
  ResolvedNavChild,
  ResolvedNavItem,
} from "@/lib/types";

/**
 * Phase 5C — the single navigation resolver.
 *
 * Turns the `nav.primary` ContentBlock (or the built-in fallback) into fully
 * resolved, safe data for the header, mega-menu and mobile menu. Desktop and
 * mobile consume the SAME output — there is no separate hardcoded content.
 *
 * Rules:
 *  - An item / child that references a category slug always resolves its
 *    destination to `/c/<slug>`; the CMS controls only the label. If the slug
 *    is neither a real category nor a known virtual collection, the item is
 *    dropped (it can never render a broken link).
 *  - A manual `href` is allowed only if it is a safe internal path, a link to a
 *    PUBLISHED content page, or an approved `https://` URL.
 *  - An item with explicit `children` uses exactly those; an item with none
 *    derives its dropdown from the referenced category's sub-categories, or
 *    renders as a plain link when the category has none.
 *  - If nothing resolves, the built-in navigation is used — the header never
 *    loses its menu.
 */

/** Flatten the category tree to `slug -> node` (roots and children). */
function flattenBySlug(tree: CategoryNode[]): Map<string, CategoryNode> {
  const map = new Map<string, CategoryNode>();
  const walk = (n: CategoryNode) => {
    map.set(n.slug, n);
    n.children.forEach(walk);
  };
  tree.forEach(walk);
  return map;
}

const SPECIAL = new Set<string>(NAV_SPECIAL_SLUGS);

/**
 * Validate a manual destination. Allows internal routes and approved external
 * https URLs; a `/pages/<slug>` link is allowed only when that page is
 * published. Returns the href, or null when it is unsafe / unavailable.
 */
export function safeStorefrontHref(
  href: string,
  publishedPageSlugs: Set<string>,
): string | null {
  const v = (href ?? "").trim();
  if (!v) return null;
  if (v.startsWith("/pages/")) {
    return publishedPageSlugs.has(v.slice("/pages/".length)) ? v : null;
  }
  if (v.startsWith("/") && !v.startsWith("//")) return v;
  if (/^https:\/\/[^\s]+$/i.test(v)) return v;
  return null;
}

/**
 * Resolve a category/collection reference OR a manual href to a safe
 * destination. A slug reference wins and is never overridden by `href`.
 */
function resolveDestination(
  categorySlug: string,
  href: string,
  bySlug: Map<string, CategoryNode>,
  publishedPageSlugs: Set<string>,
): string | null {
  if (categorySlug) {
    if (bySlug.has(categorySlug) || SPECIAL.has(categorySlug)) {
      return `/c/${categorySlug}`;
    }
    return null; // unknown reference — drop rather than render a broken link
  }
  return safeStorefrontHref(href, publishedPageSlugs);
}

function resolveNav(
  data: NavData,
  bySlug: Map<string, CategoryNode>,
  publishedPageSlugs: Set<string>,
): ResolvedNav {
  const items: ResolvedNavItem[] = [];

  for (const item of data.items) {
    if (!item.enabled) continue;
    const cat = item.categorySlug ? bySlug.get(item.categorySlug) : undefined;
    const href = resolveDestination(item.categorySlug, item.href, bySlug, publishedPageSlugs);
    if (!href) continue;
    const label = (item.label || cat?.name || "").trim();
    if (!label) continue;

    let children: ResolvedNavChild[] = [];
    if (item.children.length > 0) {
      for (const child of item.children) {
        if (!child.enabled) continue;
        const childCat = child.categorySlug ? bySlug.get(child.categorySlug) : undefined;
        const childHref = resolveDestination(
          child.categorySlug,
          child.href,
          bySlug,
          publishedPageSlugs,
        );
        if (!childHref) continue;
        const childLabel = (child.label || childCat?.name || "").trim();
        if (!childLabel) continue;
        children.push({ label: childLabel, href: childHref, productCount: childCat?.productCount });
      }
    } else if (cat) {
      children = cat.children.map((c) => ({
        label: c.name,
        href: `/c/${c.slug}`,
        productCount: c.productCount,
      }));
    }

    items.push({
      label,
      href,
      description: cat?.description ?? null,
      heroColor: cat?.heroColor ?? null,
      imageUrl: cat?.imageUrl ?? null,
      isSale: href === "/c/sale",
      children,
    });
  }

  const utility = data.utility
    .filter((u) => u.enabled && NAV_UTILITY_ROUTES[u.key])
    .map((u) => ({
      label: (u.label || NAV_UTILITY_LABELS[u.key]).trim(),
      href: NAV_UTILITY_ROUTES[u.key],
    }));

  return { items, utility };
}

export async function getResolvedNav(): Promise<ResolvedNav> {
  const [block, tree, pageSlugs] = await Promise.all([
    getNavBlock(),
    getCategoryTree(),
    getPublishedPageSlugs(),
  ]);
  const bySlug = flattenBySlug(tree);
  const published = new Set(pageSlugs);

  const source: NavData = block && block.items.length > 0 ? block : NAV_DEFAULTS;
  let resolved = resolveNav(source, bySlug, published);

  // Last-resort guard: a misconfigured block that resolves to nothing falls
  // back to the built-in navigation so the header keeps its menu.
  if (resolved.items.length === 0 && source !== NAV_DEFAULTS) {
    resolved = resolveNav(NAV_DEFAULTS, bySlug, published);
  }
  if (resolved.utility.length === 0) {
    resolved = { ...resolved, utility: resolveNav(NAV_DEFAULTS, bySlug, published).utility };
  }

  return resolved;
}
