import "server-only";
import { prisma } from "@/lib/prisma";
import {
  isEligibleCandidate,
  pickWinningOffer,
  rankOffers,
  computeCatalogCardPricing,
} from "@/lib/marketplace/buy-box-rule";
import type {
  OfferCandidate,
  CardOffer,
  CatalogCardPricing,
  ResolvedOffer,
  CatalogPriceRange,
  VariantAvailability,
  OfferResolutionContext,
  OfferCondition,
  FulfillmentType,
} from "@/lib/marketplace/types";

// Re-export the pure rule so callers have one import surface.
export {
  isEligibleCandidate,
  isEligibleForDisplayPrice,
  pickWinningOffer,
  rankOffers,
  computeCatalogCardPricing,
} from "@/lib/marketplace/buy-box-rule";

/**
 * Buy-box compatibility resolver.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 9D-A wires ONLY the product-card selling-price path
 * (`resolveCatalogCard` / `computeCatalogCardPricing`, consumed by
 * `src/lib/data.ts` `toCard()` and `src/lib/wishlist.ts`). Everything else in
 * this module — `getWinningOffer`, `getVariantAvailability`, `getCatalogPriceRange`,
 * `listOtherOffers`, `resolveWinningOffers` — remains UNWIRED and is reserved for
 * the PDP / search / cart slices. Stock, cart, checkout and PDP all still read
 * Product.price / Variant.price / Variant.stock / Inventory exactly as before.
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

function toCandidateFields(row: {
  id: string;
  status: string;
  price: number;
  createdAt: Date;
  seller: { type: string; status: string };
  inventory: { quantity: number; reserved: number } | null;
}): OfferCandidate {
  return {
    offerId: row.id,
    sellerId: "",
    sellerType: row.seller.type === "FIRST_PARTY" ? "FIRST_PARTY" : "THIRD_PARTY",
    sellerStatus: row.seller.status as OfferCandidate["sellerStatus"],
    offerStatus: row.status as OfferCandidate["offerStatus"],
    available: Math.max(0, (row.inventory?.quantity ?? 0) - (row.inventory?.reserved ?? 0)),
    price: row.price,
    createdAt: row.createdAt,
  };
}

/**
 * Pure helper: group a flat list of offer rows by `variantId` and return one
 * `CardOffer[]` per variant id (variants with no offers get an empty array).
 * Used by the batch card resolvers below and callable directly by
 * `src/lib/data.ts` on rows it already loaded via a nested include (so the PLP
 * pays no extra query).
 */
export function groupCardOffers<
  R extends {
    id: string;
    variantId: string;
    status: string;
    price: number;
    compareAtPrice: number | null;
    createdAt: Date;
    seller: { type: string; status: string };
    inventory: { quantity: number; reserved: number } | null;
  },
>(rows: R[], variantIds: string[]): Map<string, CardOffer[]> {
  const byVariant = new Map<string, CardOffer[]>();
  for (const id of variantIds) byVariant.set(id, []);
  for (const r of rows) {
    const arr = byVariant.get(r.variantId);
    if (!arr) continue;
    arr.push({ ...toCandidateFields(r), compareAtPrice: r.compareAtPrice });
  }
  return byVariant;
}

// ---------------------------------------------------------------------------
// Batch primitives (Phase 9D-A) — one query, then the shared pure rule.
// `resolveWinningOffers` uses the FULL buy-box rule (stock-aware) and is
// reserved for the PDP/search slices. `resolveCatalogCard(s)` use the
// stock-blind card-price rule and ARE wired (via the pure core) in Slice 1.
// ---------------------------------------------------------------------------

/**
 * The winning offer for many Variants in ONE database read. Returns a map keyed
 * by variant id; a variant with no eligible offer maps to `null`.
 *
 * NOT WIRED in Phase 9D-A — reserved for the PDP / search slices so they never
 * call `getWinningOffer` in a loop.
 */
export async function resolveWinningOffers(
  variantIds: string[],
): Promise<Map<string, ResolvedOffer | null>> {
  const ids = [...new Set(variantIds)];
  const out = new Map<string, ResolvedOffer | null>(ids.map((id) => [id, null]));
  if (ids.length === 0) return out;

  const rows = (await prisma.offer.findMany({
    where: { variantId: { in: ids } },
    select: OFFER_SELECT,
  })) as OfferRow[];

  const byVariant = new Map<string, OfferRow[]>();
  for (const r of rows) {
    const arr = byVariant.get(r.variantId) ?? [];
    arr.push(r);
    byVariant.set(r.variantId, arr);
  }
  for (const [variantId, group] of byVariant) {
    const winner = pickWinningOffer(group.map(toCandidate));
    out.set(variantId, winner ? toResolved(group.find((r) => r.id === winner.offerId)!) : null);
  }
  return out;
}

/**
 * Composite card pricing for many Products in ONE database read — the
 * batch-safe form used to avoid N+1 on the PLP / rails.
 */
export async function resolveCatalogCards(
  productIds: string[],
): Promise<Map<string, CatalogCardPricing>> {
  const ids = [...new Set(productIds)];
  const out = new Map<string, CatalogCardPricing>();
  if (ids.length === 0) return out;

  const variants = await prisma.variant.findMany({
    where: { productId: { in: ids }, status: "ACTIVE" },
    select: {
      id: true,
      productId: true,
      offers: {
        select: {
          id: true,
          status: true,
          price: true,
          compareAtPrice: true,
          createdAt: true,
          seller: { select: { type: true, status: true } },
        },
      },
    },
  });

  const groupsByProduct = new Map<string, CardOffer[][]>();
  for (const id of ids) groupsByProduct.set(id, []);
  for (const v of variants) {
    const group: CardOffer[] = v.offers.map((o) => ({
      offerId: o.id,
      sellerId: "",
      sellerType: o.seller.type === "FIRST_PARTY" ? "FIRST_PARTY" : "THIRD_PARTY",
      sellerStatus: o.seller.status as CardOffer["sellerStatus"],
      offerStatus: o.status as CardOffer["offerStatus"],
      available: 0, // stock-blind — the card-price rule ignores this
      price: o.price,
      createdAt: o.createdAt,
      compareAtPrice: o.compareAtPrice,
    }));
    groupsByProduct.get(v.productId)?.push(group);
  }
  for (const [productId, groups] of groupsByProduct) {
    out.set(productId, computeCatalogCardPricing(groups));
  }
  return out;
}

/** Single-product convenience wrapper around `resolveCatalogCards`. */
export async function resolveCatalogCard(productId: string): Promise<CatalogCardPricing> {
  const map = await resolveCatalogCards([productId]);
  return (
    map.get(productId) ?? {
      minPrice: null,
      minCompareAtPrice: null,
      isFrom: false,
      onSale: false,
      eligibleVariantCount: 0,
    }
  );
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
