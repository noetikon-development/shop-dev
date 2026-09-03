/**
 * Buy-box selection rule (Phase 9C) — PURE and framework-free.
 *
 * Deterministic: the same set of candidates always yields the same winner,
 * regardless of input order. Unit-testable with fixtures and no database.
 *
 * MVP rule (approved Phase 9B / 9C):
 *   1. Offer.status == 'ACTIVE'
 *   2. Seller.status == 'APPROVED'
 *   3. available (quantity - reserved) > 0
 *   4. lowest price
 *   5. FIRST_PARTY before THIRD_PARTY on a price tie
 *   6. Offer.createdAt ASC as the deterministic final tie-break
 *      (then offerId, so the result never depends on input order)
 *
 * FUTURE (not applied here): seller rating, cancellation/late-shipment rate,
 * platform-fulfilled preference, landed cost incl. shipping, in-region stock,
 * price competitiveness, buy-box rotation, Axiaro-1P platform preference.
 */

import type {
  OfferCandidate,
  CardOffer,
  CatalogCardPricing,
  StockOfferCandidate,
  FullOfferCandidate,
  WinningOfferView,
} from "@/lib/marketplace/types";

/** True when a candidate is allowed into the buy box at all. */
export function isEligibleCandidate(c: OfferCandidate): boolean {
  return c.offerStatus === "ACTIVE" && c.sellerStatus === "APPROVED" && c.available > 0;
}

/**
 * Eligibility for the DISPLAYED PRODUCT-CARD PRICE only (Phase 9D-A).
 *
 * Deliberately STOCK-BLIND: the card price is "what the item costs", shown even
 * when out of stock, exactly as today's card shows `Product.price` under an
 * "Out of stock" overlay. Slice 1 does NOT migrate stock — availability stays on
 * `Variant.stock` / `Inventory` — so the card price must not depend on
 * `OfferInventory` (a frozen 9C copy that admin stock adjustments do not yet
 * touch). The ranking comparator (`compareCandidates`) is unchanged and shared;
 * only the eligibility filter differs from `isEligibleCandidate`.
 *
 * A later, separately-approved stock slice switches card pricing over to
 * `isEligibleCandidate` (which adds `available > 0`).
 */
export function isEligibleForDisplayPrice(c: OfferCandidate): boolean {
  return c.offerStatus === "ACTIVE" && c.sellerStatus === "APPROVED";
}

/** Ordering used for both the winner and the runner-up ("other offers") list. */
export function compareCandidates(a: OfferCandidate, b: OfferCandidate): number {
  if (a.price !== b.price) return a.price - b.price; // 4. lowest price
  const aFp = a.sellerType === "FIRST_PARTY" ? 0 : 1; // 5. FIRST_PARTY tie-break
  const bFp = b.sellerType === "FIRST_PARTY" ? 0 : 1;
  if (aFp !== bFp) return aFp - bFp;
  const at = a.createdAt.getTime(); // 6. oldest offer
  const bt = b.createdAt.getTime();
  if (at !== bt) return at - bt;
  return a.offerId < b.offerId ? -1 : a.offerId > b.offerId ? 1 : 0; // stable by id
}

/**
 * The winning offer for a set of candidates, or `null` when none is eligible.
 * Never returns an inactive offer, a suspended seller's offer, or an
 * out-of-stock offer.
 */
export function pickWinningOffer(candidates: OfferCandidate[]): OfferCandidate | null {
  const eligible = candidates.filter(isEligibleCandidate);
  if (eligible.length === 0) return null;
  return [...eligible].sort(compareCandidates)[0];
}

/** Every eligible candidate in rank order (winner first). */
export function rankOffers(candidates: OfferCandidate[]): OfferCandidate[] {
  return candidates.filter(isEligibleCandidate).sort(compareCandidates);
}

// ---------------------------------------------------------------------------
// Product-card price (Phase 9D-A) — pure, stock-blind
// ---------------------------------------------------------------------------

/** The display-price winner for one variant's offers, or null. */
function pickDisplayWinner(offers: CardOffer[]): CardOffer | null {
  const eligible = offers.filter(isEligibleForDisplayPrice);
  if (eligible.length === 0) return null;
  return [...eligible].sort(compareCandidates)[0];
}

/**
 * Derive a Product's card pricing from its ACTIVE variants' offers.
 *
 * `variantOfferGroups` is one array of offers per ACTIVE variant. Rule (approved
 * Phase 9D / 9D-A):
 *   1. per variant, pick the display-price winner (`isEligibleForDisplayPrice`
 *      + the shared `compareCandidates` ranking)
 *   2. ignore variants with no winner
 *   3. `minPrice` = lowest winning price across the remaining variants
 *   4. `minCompareAtPrice` = the winner-at-minPrice's compareAt, only if it
 *      exceeds minPrice; never borrowed from another variant
 *   5. `isFrom` = the winning prices are not all identical
 *   6. no winner anywhere → all-null / not on sale
 */
export function computeCatalogCardPricing(variantOfferGroups: CardOffer[][]): CatalogCardPricing {
  const winners: { price: number; compareAtPrice: number | null }[] = [];
  let onSale = false;

  for (const group of variantOfferGroups) {
    const w = pickDisplayWinner(group);
    if (!w) continue;
    winners.push({ price: w.price, compareAtPrice: w.compareAtPrice });
    for (const o of group) {
      if (isEligibleForDisplayPrice(o) && o.compareAtPrice != null) onSale = true;
    }
  }

  if (winners.length === 0) {
    return { minPrice: null, minCompareAtPrice: null, isFrom: false, onSale: false, eligibleVariantCount: 0 };
  }

  const minPrice = Math.min(...winners.map((w) => w.price));
  const minWinner = winners.find((w) => w.price === minPrice)!;
  const minCompareAtPrice =
    minWinner.compareAtPrice != null && minWinner.compareAtPrice > minPrice ? minWinner.compareAtPrice : null;

  return {
    minPrice,
    minCompareAtPrice,
    isFrom: new Set(winners.map((w) => w.price)).size > 1,
    onSale,
    eligibleVariantCount: winners.length,
  };
}

// ---------------------------------------------------------------------------
// Variant availability (Phase 9D-D) — pure, STOCK-AWARE
// ---------------------------------------------------------------------------

/**
 * The available units + reorder point of the STOCK-BEARING winning offer for one
 * variant (Phase 9D-D). Uses the FULL stock-aware buy-box rule
 * (`pickWinningOffer` → `isEligibleCandidate`, which requires `available > 0`),
 * so the offer that supplies availability is the SAME offer that supplies the
 * price. When no offer is eligible AND in stock → `{ available: 0 }` → the
 * storefront shows out-of-stock; it never falls back to `Variant.stock`.
 */
export function resolveVariantAvailability(offers: StockOfferCandidate[]): {
  available: number;
  reorderPoint: number;
} {
  const view = resolveWinningOfferView(offers.map((o) => ({ ...o, compareAtPrice: null })));
  return view
    ? { available: view.available, reorderPoint: view.reorderPoint }
    : { available: 0, reorderPoint: 0 };
}

// ---------------------------------------------------------------------------
// Winning-offer view (Phase 9D-E) — pure, STOCK-AWARE, single source
// ---------------------------------------------------------------------------

/**
 * The one winning offer for a variant, reduced to `{ price, compareAtPrice,
 * available, reorderPoint }` — all four from the SAME offer (`pickWinningOffer`).
 * `null` when no offer is ACTIVE + APPROVED-seller + in stock. Callers must NOT
 * fall back to `Variant.price` / `Inventory` on `null` — the line is unavailable.
 *
 * This is the shared core behind the cart line DTO / cart validation (9D-E) and
 * the PDP per-variant price + stock (9D-B / 9D-D), so the two can never diverge.
 */
export function resolveWinningOfferView(offers: FullOfferCandidate[]): WinningOfferView | null {
  const winner = pickWinningOffer(offers);
  if (!winner) return null;
  const row = offers.find((o) => o.offerId === winner.offerId)!;
  return {
    offerId: winner.offerId,
    price: row.price,
    compareAtPrice: row.compareAtPrice,
    available: winner.available,
    reorderPoint: row.reorderPoint,
  };
}
