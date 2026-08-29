import type { ListingParams } from "@/lib/data";
import type { SortId } from "@/lib/constants";

export type RawSearchParams = Record<string, string | string[] | undefined>;

function str(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v || undefined;
}

function num(v: string | string[] | undefined): number | undefined {
  const s = str(v);
  if (s == null) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

export function parseListingParams(
  sp: RawSearchParams,
  opts: { categorySlug?: string; forceSale?: boolean; forceNew?: boolean } = {},
): ListingParams {
  const colors = str(sp.color)
    ?.split(",")
    .map((c) => c.trim())
    .filter(Boolean);

  let sort = (str(sp.sort) as SortId | undefined) ?? "relevance";
  if (opts.forceNew && !str(sp.sort)) sort = "newest";

  return {
    categorySlug: opts.categorySlug,
    query: str(sp.q),
    sort,
    minPrice: num(sp.min) != null ? Math.round(num(sp.min)! * 100) : undefined,
    maxPrice: num(sp.max) != null ? Math.round(num(sp.max)! * 100) : undefined,
    colors: colors?.length ? colors : undefined,
    onSale: opts.forceSale ? true : str(sp.sale) === "1",
    inStock: str(sp.stock) === "1",
    freeShipping: str(sp.ship) === "1",
    minRating: num(sp.rating),
    page: num(sp.page) ?? 1,
    perPage: 24,
  };
}

/** Build a query string, toggling/merging one change onto the current params. */
export function buildQuery(
  current: URLSearchParams,
  patch: Record<string, string | number | null | undefined>,
): string {
  const next = new URLSearchParams(current.toString());
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === "") next.delete(k);
    else next.set(k, String(v));
  }
  // reset pagination on any filter change (except explicit page change)
  if (!("page" in patch)) next.delete("page");
  const s = next.toString();
  return s ? `?${s}` : "";
}

export const ACTIVE_FILTER_KEYS = ["q", "min", "max", "color", "sale", "stock", "ship", "rating"] as const;

export function countActiveFilters(sp: URLSearchParams): number {
  let n = 0;
  for (const k of ACTIVE_FILTER_KEYS) {
    if (k === "color") {
      const c = sp.get("color");
      if (c) n += c.split(",").filter(Boolean).length;
    } else if (sp.get(k)) {
      n += 1;
    }
  }
  return n;
}
