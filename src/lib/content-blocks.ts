import { z } from "zod";

/**
 * Content-block type registry (Step 16). Plain data + Zod schemas — safe to
 * import from server and client. The storefront renders `area:"homepage"` blocks
 * that are `PUBLISHED`, ordered by `position`. This is a small fixed set of
 * typed blocks, NOT a free-form page builder.
 *
 * `ContentBlock.data` is a JSON string; every payload is parsed AND re-validated
 * with the matching schema before it is used, so a malformed row can never break
 * the storefront (it is skipped instead).
 */

export const CONTENT_AREAS = ["homepage", "global"] as const;
export type ContentArea = (typeof CONTENT_AREAS)[number];

export const BLOCK_STATUSES = ["DRAFT", "PUBLISHED"] as const;
export type BlockStatus = (typeof BLOCK_STATUSES)[number];

// --- shared field pieces --------------------------------------------------

const shortText = z.string().trim().max(200);
const longText = z.string().trim().max(2000);
/** Internal link (starts with "/") or a full https URL. */
export const linkHref = z
  .string()
  .trim()
  .max(2048)
  .refine(
    (v) => v === "" || v.startsWith("/") || /^https:\/\//i.test(v),
    "Use an internal path (/c/all) or a full https:// URL.",
  );
const mediaId = z.string().trim().max(40).regex(/^$|^[a-z0-9]{20,40}$/i, "Invalid image reference").default("");

// --- per-type payload schemas ------------------------------------------------

export const heroSchema = z.object({
  eyebrow: shortText.default(""),
  heading: shortText.default(""),
  body: longText.default(""),
  ctaLabel: shortText.default(""),
  ctaHref: linkHref.default(""),
  secondaryCtaLabel: shortText.default(""),
  secondaryCtaHref: linkHref.default(""),
  // Legacy single hero image — kept for backward compatibility. The storefront
  // only falls back to it when `heroImages` has no entries.
  imageMediaId: mediaId,
  // The four fixed hero panels (Living / Lighting / Kitchen & Dining / Wardrobe),
  // in order. Each entry is a MediaAsset id or "" (empty = keep the built-in
  // illustration for that panel). Always length 4 once saved from the editor.
  heroImages: z.array(mediaId).max(4).default([]),
  notes: z.array(shortText).max(6).default([]),
});

/** Fixed hero-panel labels — administration only, does not affect the storefront. */
export const HERO_PANEL_LABELS = [
  "Panel 1 — Living",
  "Panel 2 — Lighting",
  "Panel 3 — Kitchen & Dining",
  "Panel 4 — Wardrobe",
] as const;

export const featureItemSchema = z.object({
  eyebrow: shortText.default(""),
  title: shortText.default(""),
  body: longText.default(""),
  ctaLabel: shortText.default(""),
  href: linkHref.default(""),
  imageMediaId: mediaId,
});
export const featureGridSchema = z.object({
  items: z.array(featureItemSchema).max(4).default([]),
});

export const PRODUCT_RAIL_SOURCES = [
  "bestsellers",
  "new_arrivals",
  "on_sale",
  "category",
  "manual",
] as const;
export const productRailSchema = z.object({
  eyebrow: shortText.default(""),
  title: shortText.default(""),
  source: z.enum(PRODUCT_RAIL_SOURCES).default("bestsellers"),
  categorySlug: z.string().trim().max(120).default(""),
  productIds: z.array(z.string().trim().max(40)).max(24).default([]),
  actionLabel: shortText.default(""),
  actionHref: linkHref.default(""),
  limit: z.number().int().min(2).max(16).default(10),
});

export const valuePropsSchema = z.object({
  items: z
    .array(z.object({ icon: z.string().trim().max(30).default("check"), title: shortText, body: shortText.default("") }))
    .max(6)
    .default([]),
});

export const richTextSchema = z.object({
  heading: shortText.default(""),
  body: z.string().trim().max(8000).default(""),
});

export const categoryTilesSchema = z.object({
  eyebrow: shortText.default(""),
  heading: shortText.default(""),
});

// --- footer (Phase 5A) -----------------------------------------------------
//
// A single `area:"global"` block (`footer.default`). Structured, editable
// wording + link lists for the site-wide footer. Authoritative business values
// (support email, social URLs, legal name) are NOT stored here — the footer
// component reads those from Store Settings and merges them in.

export const footerLinkSchema = z.object({
  label: shortText.default(""),
  href: linkHref.default(""),
  /** Hidden from the storefront when false — kept so it can be re-enabled. */
  enabled: z.boolean().default(true),
});

export const footerColumnSchema = z.object({
  heading: shortText.default(""),
  links: z.array(footerLinkSchema).max(12).default([]),
});

export const footerSchema = z.object({
  brandDescription: longText.default(""),
  newsletter: z
    .object({
      heading: shortText.default(""),
      body: shortText.default(""),
      ctaLabel: shortText.default(""),
      successText: longText.default(""),
    })
    .default({ heading: "", body: "", ctaLabel: "", successText: "" }),
  shopColumn: footerColumnSchema.default({ heading: "", links: [] }),
  helpColumn: footerColumnSchema.default({ heading: "", links: [] }),
  companyColumn: footerColumnSchema.default({ heading: "", links: [] }),
  legalLinks: z.array(footerLinkSchema).max(8).default([]),
  /** `{year}` and `{brand}` tokens are substituted at render time. */
  copyright: shortText.default(""),
});

export type FooterData = z.infer<typeof footerSchema>;

// --- registry --------------------------------------------------------------

export type BlockTypeKey =
  | "hero"
  | "feature_grid"
  | "product_rail"
  | "value_props"
  | "rich_text"
  | "category_tiles"
  | "footer";

export const BLOCK_TYPES: Record<
  BlockTypeKey,
  { label: string; description: string; schema: z.ZodTypeAny }
> = {
  hero: { label: "Hero", description: "The large banner at the top of the homepage.", schema: heroSchema },
  category_tiles: { label: "Category tiles", description: "Grid of shop-by-category tiles.", schema: categoryTilesSchema },
  product_rail: { label: "Product rail", description: "A horizontal strip of products (bestsellers, new, sale, a category, or a hand-picked list).", schema: productRailSchema },
  feature_grid: { label: "Feature cards", description: "Two or more editorial cards linking into the catalogue.", schema: featureGridSchema },
  value_props: { label: "Value props", description: "The row of short reassurance points (shipping, returns…).", schema: valuePropsSchema },
  rich_text: { label: "Rich text", description: "A heading and a block of formatted text.", schema: richTextSchema },
  footer: { label: "Footer", description: "The site-wide footer — brand text, link columns, newsletter copy and copyright.", schema: footerSchema },
};

export const BLOCK_TYPE_KEYS = Object.keys(BLOCK_TYPES) as BlockTypeKey[];

/** Block types an admin can add as a homepage section (footer is site-wide, edited on its own page). */
export const HOMEPAGE_BLOCK_TYPE_KEYS = BLOCK_TYPE_KEYS.filter(
  (k) => k !== "footer",
) as Exclude<BlockTypeKey, "footer">[];

export function isBlockType(v: string): v is BlockTypeKey {
  return v in BLOCK_TYPES;
}

/** Parse + validate a stored block payload. Returns defaults on any failure. */
export function parseBlockData(type: string, raw: string): Record<string, unknown> {
  if (!isBlockType(type)) return {};
  let json: unknown = {};
  try {
    json = JSON.parse(raw || "{}");
  } catch {
    json = {};
  }
  const result = BLOCK_TYPES[type].schema.safeParse(json ?? {});
  return result.success ? (result.data as Record<string, unknown>) : (BLOCK_TYPES[type].schema.parse({}) as Record<string, unknown>);
}
