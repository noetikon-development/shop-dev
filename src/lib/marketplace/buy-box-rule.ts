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

import type { OfferCandidate } from "@/lib/marketplace/types";

/** True when a candidate is allowed into the buy box at all. */
export function isEligibleCandidate(c: OfferCandidate): boolean {
  return c.offerStatus === "ACTIVE" && c.sellerStatus === "APPROVED" && c.available > 0;
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
