/**
 * Purchasable-variant resolution for the product page.
 *
 * A Variant is the ONLY source of truth for a purchasable option combination.
 * Selections are resolved by option-value id — never by display text, filename,
 * slug or list position. A combination that has no Variant row is not
 * purchasable, even if every individual option value exists elsewhere.
 *
 * Pure and framework-free so it can be unit-tested and shared.
 */

export type MatchOption = { id: string };

export type MatchVariant = {
  id: string;
  status: string; // "ACTIVE" | "ARCHIVED"
  stock: number; // available = Inventory.quantity - Inventory.reserved
  optionValueIds: string[];
};

/**
 * The exact Variant for a selection, or `null`.
 *
 * Requires EVERY option to have a selected value and a single Variant whose
 * option-value set is exactly that selection. A product with no options has one
 * Variant, which is always the match.
 */
export function matchVariant<V extends MatchVariant>(
  options: MatchOption[],
  variants: V[],
  selected: Record<string, string>,
): V | null {
  if (options.length === 0) return variants[0] ?? null;

  const chosen = options.map((o) => selected[o.id]).filter(Boolean) as string[];
  if (chosen.length !== options.length) return null; // selection incomplete

  const chosenSet = new Set(chosen);
  return (
    variants.find(
      (v) =>
        v.optionValueIds.length === chosen.length &&
        v.optionValueIds.every((id) => chosenSet.has(id)),
    ) ?? null
  );
}

/**
 * Does a purchasable (ACTIVE, in-stock) Variant exist that includes every id in
 * `requiredValueIds`? Used to enable/disable individual option chips — e.g. "is
 * size 41 buyable in the currently selected colour?".
 */
export function hasPurchasableVariant<V extends MatchVariant>(
  variants: V[],
  requiredValueIds: string[],
): boolean {
  return variants.some(
    (v) =>
      v.status === "ACTIVE" &&
      v.stock > 0 &&
      requiredValueIds.every((id) => v.optionValueIds.includes(id)),
  );
}

/**
 * Does ANY Variant (any status, any stock) include every id in
 * `requiredValueIds`? Distinguishes "this combination is sold but out of stock"
 * from "this combination does not exist".
 */
export function variantCombinationExists<V extends MatchVariant>(
  variants: V[],
  requiredValueIds: string[],
): boolean {
  return variants.some((v) => requiredValueIds.every((id) => v.optionValueIds.includes(id)));
}
