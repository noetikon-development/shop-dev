/**
 * The single canonical colour-presentation system for the storefront (9F-37B).
 * Client-safe — no server-only import.
 *
 * A colour's visible swatch is resolved, in order:
 *   1. an EXPLICIT `ProductOptionValue.swatchHex` (admin override, or a value
 *      stored by an earlier phase) — this ALWAYS wins and is never rewritten;
 *   2. the controlled palette below, matched on the NORMALISED full label,
 *      then the last word, then the first word (so multi-word names such as
 *      "Field tan" / "Natural oak" / "Black stained oak" resolve correctly —
 *      NOT a naive first-word-only lookup);
 *   3. an explicit NEUTRAL swatch — an unknown colour never renders "no dot"
 *      and never a raw `#ccc`; every surface shows the same neutral.
 *
 * Reuses `ProductOptionValue.swatchHex` (no new DB column). Nothing here writes
 * the database. 1P and 3P go through this same resolver against the same field.
 */

const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;

/**
 * The controlled neutral swatch for a colour we can't place. A soft warm grey
 * that reads as "unspecified" against the storefront's earthy palette — the
 * SAME value on the product card, PLP, wishlist, PDP and the colour facet.
 */
export const NEUTRAL_SWATCH_HEX = "#c8c4bb";

/**
 * Option names that denote a colour axis. Case-insensitive; exactly
 * colour / color / colours / colors — never "coloured trim", "Size", etc.
 */
const COLOUR_OPTION_NAME_RE = /^colou?rs?$/i;

/** Exact option names for a Prisma `{ name: { in: … } }` filter (paired with `mode: "insensitive"`). */
export const COLOUR_OPTION_NAMES = ["Colour", "Color", "Colours", "Colors"] as const;

export function isColourOptionName(name: string | null | undefined): boolean {
  return typeof name === "string" && COLOUR_OPTION_NAME_RE.test(name.trim());
}

/** lower-case, collapse any run of non-alphanumerics to a single space, trim. */
function normalizeColourLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Controlled colour → hex palette. Keys are NORMALISED labels (see
 * `normalizeColourLabel`). The single-word entries carry the original 9F-era
 * `SWATCH_HINTS` values verbatim (so no live swatch shifts); multi-word entries
 * and common synonyms are added so the resolver covers real furniture / apparel
 * colour names. Extend by adding a key — never rename or re-hex an existing one
 * without checking the storefront.
 */
export const COLOUR_PALETTE: Record<string, string> = {
  // ── original SWATCH_HINTS (unchanged hexes) ──────────────────────────────
  oak: "#c8a97e",
  walnut: "#6b4a32",
  oat: "#e8dfce",
  clay: "#b5533a",
  sage: "#7c8a71",
  ink: "#23211e",
  slate: "#4a4f57",
  black: "#262626",
  white: "#f2f0ea",
  natural: "#d8c8ab",
  charcoal: "#3d3d3f",
  cream: "#efece4",
  grey: "#9a9a93",
  gray: "#9a9a93",
  navy: "#22314a",
  green: "#3f5245",
  blue: "#5a6b74",
  terracotta: "#b06b4c",
  rust: "#a8583f",
  bone: "#e6e1d6",

  // ── common single-word colours the first-word-only lookup missed ─────────
  tan: "#c19a6b",
  beige: "#d9cbb3",
  brown: "#5b4636",
  sand: "#dcc9a6",
  stone: "#c3b8a3",
  taupe: "#a99a86",
  khaki: "#9a8f6b",
  olive: "#5b5b3a",
  mustard: "#c9a24b",
  camel: "#c19a6b",
  ecru: "#e4dccb",
  ivory: "#f3eee0",
  linen: "#e9e1d1",
  denim: "#3f5b73",
  teal: "#2f5d5b",
  mint: "#a9c8b6",
  coral: "#d9755b",
  burgundy: "#5a2733",
  wine: "#5a2733",
  red: "#9e3b34",
  orange: "#c06b3a",
  yellow: "#d8b24a",
  gold: "#b9975b",
  silver: "#c9c9c6",
  pink: "#d8a7ac",
  blush: "#e0c0bd",
  purple: "#5b4a6b",
  fog: "#c4c6c2",
  moss: "#6f7a5c",
  ash: "#b8b4ad",

  // ── explicit multi-word entries (the resolver also handles these via the
  //    last-word / first-word fallback, but pin the nuanced hex here) ───────
  "field tan": "#c19a6b",
  "sky blue": "#9fc0d4",
  "dark olive": "#4f4d31",
  "forest green": "#2f4739",
  "natural oak": "#c8a97e",
  "black stained oak": "#2c2a27",
  "black stained ash": "#2c2a27",
  "light oak": "#d7bd94",
  "dark walnut": "#4a3222",
  "off white": "#efece4",
};

/**
 * Resolve the swatch hex for a colour option value.
 *
 * @param label    the `ProductOptionValue.value` text, e.g. "Field tan"
 * @param explicit the stored `ProductOptionValue.swatchHex` (or null) — wins if set
 */
export function resolveSwatchHex(label: string, explicit?: string | null): string {
  const stored = typeof explicit === "string" ? explicit.trim() : "";
  if (HEX_RE.test(stored)) return stored;

  const norm = normalizeColourLabel(label);
  if (norm) {
    if (COLOUR_PALETTE[norm]) return COLOUR_PALETTE[norm];
    const words = norm.split(" ");
    const last = words[words.length - 1];
    if (last && COLOUR_PALETTE[last]) return COLOUR_PALETTE[last];
    const first = words[0];
    if (first && COLOUR_PALETTE[first]) return COLOUR_PALETTE[first];
  }
  return NEUTRAL_SWATCH_HEX;
}

/**
 * `{ hex, palette }` — `palette` is false when the neutral fallback was used
 * (an unknown colour). Handy where a caller wants to style the fallback
 * differently; most surfaces just use `.hex`.
 */
export function colourSwatch(
  label: string,
  explicit?: string | null,
): { hex: string; palette: boolean } {
  const hex = resolveSwatchHex(label, explicit);
  return { hex, palette: hex !== NEUTRAL_SWATCH_HEX };
}
