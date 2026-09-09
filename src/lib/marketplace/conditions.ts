/**
 * The single canonical definition of the marketplace product-condition
 * vocabulary (9F-36B). Client-safe — no server-only import.
 *
 * Every place that lists, validates, or labels a condition MUST source it here,
 * so the vocabulary can never drift between:
 *   - the seller Offer create / edit forms
 *   - the seller Product Request form (9F-36B)
 *   - `Offer.condition` validation (`seller-repository.ts`)
 *   - the Axiaro FIRST_PARTY (1P) Offer schema (`catalog-schemas.ts`)
 *   - the display helper `conditionLabel()` (`src/lib/seller/format.ts`)
 *
 * These are the SAME values already stored on `Offer.condition` /
 * `OrderItem.condition` — this is NOT a second enum. `Offer.condition` stays
 * `String @default("NEW")` in the schema; this module is the app-layer authority.
 *
 * Labels are the incumbent storefront wording (product card chip, PDP, order
 * pages / emails) — unchanged by 9F-36B.
 */

export const OFFER_CONDITIONS = [
  "NEW",
  "REFURBISHED",
  "OPEN_BOX",
  "USED_LIKE_NEW",
  "USED_GOOD",
] as const;

export type OfferCondition = (typeof OFFER_CONDITIONS)[number];

export const CONDITION_LABELS: Record<OfferCondition, string> = {
  NEW: "New",
  REFURBISHED: "Refurbished",
  OPEN_BOX: "Open box",
  USED_LIKE_NEW: "Used — like new",
  USED_GOOD: "Used — good",
};

/** `[{ value, label }]` in display order — for `<Select>` option lists. */
export const CONDITION_OPTIONS: { value: OfferCondition; label: string }[] = OFFER_CONDITIONS.map(
  (value) => ({ value, label: CONDITION_LABELS[value] }),
);

export function isOfferCondition(value: unknown): value is OfferCondition {
  return typeof value === "string" && (OFFER_CONDITIONS as readonly string[]).includes(value);
}

/** The display label for a stored condition value; echoes an unknown value unchanged. */
export function conditionLabel(condition: string): string {
  return CONDITION_LABELS[condition as OfferCondition] ?? condition;
}
