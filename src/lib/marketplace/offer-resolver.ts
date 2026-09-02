import "server-only";
import { prisma } from "@/lib/prisma";
import {
  isEligibleCandidate,
  pickWinningOffer,
  rankOffers,
} from "@/lib/marketplace/buy-box-rule";
import type {
  OfferCandidate,
  ResolvedOffer,
  CatalogPriceRange,
  VariantAvailability,
  OfferResolutionContext,
  OfferCondition,
  FulfillmentType,
} from "@/lib/marketplace/types";

// Re-export the pure rule so callers have one import surface.
export { isEligibleCandidate, pickWinningOffer, rankOffers } from "@/lib/marketplace/buy-box-rule";

/**
 * Buy-box compatibility resolver (Phase 9C).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NOT WIRED. As of Phase 9C nothing in the storefront, cart, checkout, search,
 * PLP, PDP, rails or admin calls any function in this module. Every existing
 * price / stock reader still uses Product.price / Variant.price / Variant.stock
 * / Inventory exactly as before. This module exists so that a later,
 * separately-approved phase can migrate readers one surface at a time behind a
 * stable signature.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This module is READ-ONLY. It never reserves, deducts or mutates inventory,
 * price, Product, Variant, Offer, Order or Cart.
 *
 * MVP buy-box rule (approved Phase 9B / 9C):
 *   1. Offer.status == 'ACTIVE'
 *   2. Seller.status == 'APPROVED'
 *   3. OfferInventory.available (quantity - reserved) > 0
 *   4. lowest Offer.price
 *   5. FIRST_PARTY before THIRD_PARTY on a price tie
 *   6. Offer.createdAt ASC as the deterministic final tie-break
 * No eligible offer → null. Never returns a zero-price / inactive / suspended /
 * out-of-stock offer.
 */

// ---------------------------------------------------------------------------
// DB-backed reads (thin fetch + pure core). None mutate anything.
// ---------------------------------------------------------------------------

const OFFER_SELECT = {
  id: true,
  sellerId: true,
  variantId: true,
  price: true,
  compareAtPrice: true,
  condition: true,
  status: true,
  fulfillmentType: true,
  handlingTimeDays: true,
  createdAt: true,
  seller: { select: { type: true, status: true, displayName: true } },
  inventory: { select: { quantity: true, reserved: true } },
} as const;

type OfferRow = {
  id: string;
  sellerId: string;
  variantId: string;
  price: number;
  compareAtPrice: number | null;
  condition: string;
  status: string;
  fulfillmentType: string;
  handlingTimeDays: number;
  createdAt: Date;
  seller: { type: string; status: string; displayName: string };
  inventory: { quantity: number; reserved: number } | null;
};

function toCandidate(row: OfferRow): OfferCandidate {
  const available = Math.max(0, (row.inventory?.quantity ?? 0) - (row.inventory?.reserved ?? 0));
  return {
    offerId: row.id,
    sellerId: row.sellerId,
    sellerType: row.seller.type === "FIRST_PARTY" ? "FIRST_PARTY" : "THIRD_PARTY",
    sellerStatus: row.seller.status as OfferCandidate["sellerStatus"],
    offerStatus: row.status as OfferCandidate["offerStatus"],
    available,
    price: row.price,
    createdAt: row.createdAt,
  };
}

function toResolved(row: OfferRow): ResolvedOffer {
  const available = Math.max(0, (row.inventory?.quantity ?? 0) - (row.inventory?.reserved ?? 0));
  return {
    offerId: row.id,
    sellerId: row.sellerId,
    sellerType: row.seller.type === "FIRST_PARTY" ? "FIRST_PARTY" : "THIRD_PARTY",
    sellerDisplayName: row.seller.displayName,
    variantId: row.variantId,
    price: row.price,
    compareAtPrice: row.compareAtPrice,
    available,
    condition: row.condition as OfferCondition,
    fulfillmentType: row.fulfillmentType as FulfillmentType,
    handlingTimeDays: row.handlingTimeDays,
  };
}

/**
 * The winning offer for a catalog Variant, or `null` when none is eligible.
 * `ctx` is reserved for future buy-box signals and is currently ignored.
 */
export async function getWinningOffer(
  variantId: string,
  _ctx: OfferResolutionContext = {} as OfferResolutionContext,
): Promise<ResolvedOffer | null> {
  void _ctx;
  const rows = (await prisma.offer.findMany({
    where: { variantId },
    select: OFFER_SELECT,
  })) as OfferRow[];
  const winner = pickWinningOffer(rows.map(toCandidate));
  if (!winner) return null;
  const winRow = rows.find((r) => r.id === winner.offerId)!;
  return toResolved(winRow);
}

/** Alias kept for the Phase 9B naming. Identical behaviour to `getWinningOffer`. */
export function getSellableOffer(variantId: string): Promise<ResolvedOffer | null> {
  return getWinningOffer(variantId);
}

/** Every buy-box-eligible offer for a Variant EXCEPT the winner, in rank order. */
export async function listOtherOffers(variantId: string): Promise<ResolvedOffer[]> {
  const rows = (await prisma.offer.findMany({
    where: { variantId },
    select: OFFER_SELECT,
  })) as OfferRow[];
  const ranked = rankOffers(rows.map(toCandidate));
  return ranked.slice(1).map((c) => toResolved(rows.find((r) => r.id === c.offerId)!));
}

/** Availability summed across every buy-box-eligible offer on a Variant. */
export async function getVariantAvailability(variantId: string): Promise<VariantAvailability> {
  const rows = (await prisma.offer.findMany({
    where: { variantId },
    select: OFFER_SELECT,
  })) as OfferRow[];
  const eligible = rows.map(toCandidate).filter(isEligibleCandidate);
  return {
    available: eligible.reduce((n, c) => n + c.available, 0),
    offerCount: eligible.length,
  };
}

/**
 * Price range across every buy-box-eligible offer on every Variant of a Product
 * — for PLP "from ₱X" style copy. `{ min: null, max: null, offerCount: 0 }` when
 * nothing is eligible.
 */
export async function getCatalogPriceRange(productId: string): Promise<CatalogPriceRange> {
  const rows = (await prisma.offer.findMany({
    where: { variant: { productId } },
    select: OFFER_SELECT,
  })) as OfferRow[];
  const eligible = rows.map(toCandidate).filter(isEligibleCandidate);
  if (eligible.length === 0) return { min: null, max: null, offerCount: 0 };
  const prices = eligible.map((c) => c.price);
  return { min: Math.min(...prices), max: Math.max(...prices), offerCount: eligible.length };
}
