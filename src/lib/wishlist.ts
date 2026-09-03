import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { artKindFromRef } from "@/lib/art-ref";
import { stockStatusFromAvailable, rollupStatus } from "@/lib/inventory-status";
import { computeCatalogCardPricing, resolveVariantAvailability } from "@/lib/marketplace/buy-box-rule";
import type { CardOffer, StockOfferCandidate } from "@/lib/marketplace/types";
import type { ProductCardView } from "@/lib/types";

/**
 * Customer wishlist — server logic (Step 15).
 *
 * The wishlist is stored in PostgreSQL (`WishlistItem`, unique on
 * `(userId, productId)`) and is ALWAYS scoped to the authenticated user id
 * resolved server-side. The browser never supplies a userId, so there is no
 * IDOR surface. `localStorage` is not used as an authoritative store — the
 * client keeps only a thin mirror of the ids for instant heart toggles.
 */

export type WishlistCard = ProductCardView & {
  /** false when the product is archived / inactive — shown, but not purchasable (spec §19). */
  available: boolean;
  wishlistedAt: string;
};

export async function getWishlistProductIds(userId: string): Promise<string[]> {
  const rows = await prisma.wishlistItem.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { productId: true },
  });
  return rows.map((r) => r.productId);
}

const wishlistSelect = {
  createdAt: true,
  product: {
    select: {
      id: true,
      slug: true,
      name: true,
      brand: true,
      shortDescription: true,
      status: true,
      price: true,
      compareAtPrice: true,
      ratingAvg: true,
      ratingCount: true,
      soldCount: true,
      badges: true,
      freeShipping: true,
      createdAt: true,
      category: { select: { slug: true, name: true } },
      images: {
        orderBy: [{ optionValueId: { sort: "asc", nulls: "first" } }, { sortOrder: "asc" }, { id: "asc" }],
        take: 1,
        select: { url: true, alt: true },
      },
      options: {
        where: { name: "Colour" },
        select: { values: { orderBy: { sortOrder: "asc" }, select: { swatchHex: true } } },
      },
      variants: {
        where: { status: "ACTIVE" },
        select: {
          id: true,
          // Phase 9D-A: card selling price from the winning Axiaro FIRST_PARTY
          // Offer. Phase 9D-D: card stock/availability from that same offer's
          // OfferInventory. Nested — one query per load.
          offers: {
            select: {
              id: true,
              status: true,
              price: true,
              compareAtPrice: true,
              createdAt: true,
              seller: { select: { type: true, status: true } },
              inventory: { select: { quantity: true, reserved: true, reorderPoint: true } },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.WishlistItemSelect;

type WishlistOfferRow = {
  id: string;
  status: string;
  price: number;
  compareAtPrice: number | null;
  createdAt: Date;
  seller: { type: string; status: string };
  inventory: { quantity: number; reserved: number; reorderPoint: number } | null;
};

function toWishlistCardOffer(o: WishlistOfferRow): CardOffer {
  return {
    offerId: o.id,
    sellerId: "",
    sellerType: o.seller.type === "FIRST_PARTY" ? "FIRST_PARTY" : "THIRD_PARTY",
    sellerStatus: o.seller.status as CardOffer["sellerStatus"],
    offerStatus: o.status as CardOffer["offerStatus"],
    available: 0,
    price: o.price,
    createdAt: o.createdAt,
    compareAtPrice: o.compareAtPrice,
  };
}

/** Map a wishlist offer row onto the STOCK-AWARE availability input shape (9D-D). */
function toWishlistStockOffer(o: WishlistOfferRow): StockOfferCandidate {
  return {
    offerId: o.id,
    sellerId: "",
    sellerType: o.seller.type === "FIRST_PARTY" ? "FIRST_PARTY" : "THIRD_PARTY",
    sellerStatus: o.seller.status as StockOfferCandidate["sellerStatus"],
    offerStatus: o.status as StockOfferCandidate["offerStatus"],
    available: Math.max(0, (o.inventory?.quantity ?? 0) - (o.inventory?.reserved ?? 0)),
    reorderPoint: o.inventory?.reorderPoint ?? 0,
    price: o.price,
    createdAt: o.createdAt,
  };
}

function safeParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * The wishlist as product cards. Archived / non-ACTIVE products are NOT deleted
 * from the wishlist — they are returned with `available: false` so the UI can
 * show an "unavailable" state and block purchase (spec §19).
 */
export async function loadWishlist(userId: string): Promise<WishlistCard[]> {
  const rows = await prisma.wishlistItem.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: wishlistSelect,
  });

  return rows.map(({ createdAt, product: p }) => {
    const img = p.images[0] ?? { url: `art:accessory:${p.slug}`, alt: p.name };
    const swatches = (p.options[0]?.values ?? [])
      .map((v) => v.swatchHex)
      .filter((h): h is string => Boolean(h));
    const available = p.status === "ACTIVE";
    // Phase 9D-D: availability from the winning stock-bearing 1P Offer's
    // OfferInventory, per ACTIVE variant — same source as the storefront cards.
    const perVariantAvail = p.variants.map((v) =>
      resolveVariantAvailability(v.offers.map(toWishlistStockOffer)),
    );
    const inStock = available && perVariantAvail.some((a) => a.available > 0);
    const stockStatus = rollupStatus(
      perVariantAvail.map((a) => stockStatusFromAvailable(a.available, a.reorderPoint)),
    );
    // Card selling price from the winning 1P offers. A retired product (no ACTIVE
    // variant / no offer) legitimately falls back to its last-known
    // `Product.price` — that is the historical price for an item you can no
    // longer buy, not a migrated live card hiding a broken offer.
    const pricing = computeCatalogCardPricing(
      p.variants.map((v) => v.offers.map(toWishlistCardOffer)),
    );
    return {
      id: p.id,
      slug: p.slug,
      name: p.name,
      brand: p.brand,
      shortDescription: p.shortDescription,
      price: pricing.minPrice ?? p.price,
      compareAtPrice: pricing.minPrice != null ? pricing.minCompareAtPrice : p.compareAtPrice,
      priceFrom: pricing.isFrom,
      ratingAvg: p.ratingAvg,
      ratingCount: p.ratingCount,
      soldCount: p.soldCount,
      badges: safeParse<string[]>(p.badges, []),
      freeShipping: p.freeShipping,
      image: { url: img.url, alt: img.alt },
      art: artKindFromRef(img.url),
      categorySlug: p.category.slug,
      categoryName: p.category.name,
      colorSwatches: swatches,
      inStock,
      stockStatus,
      defaultVariantId: available && p.variants.length === 1 ? p.variants[0].id : null,
      createdAt: p.createdAt.toISOString(),
      available,
      wishlistedAt: createdAt.toISOString(),
    };
  });
}

/** Toggle a product in the user's wishlist. Returns the resulting state. */
export async function toggleWishlist(
  userId: string,
  productId: string,
): Promise<{ wished: boolean }> {
  const existing = await prisma.wishlistItem.findUnique({
    where: { userId_productId: { userId, productId } },
    select: { id: true },
  });
  if (existing) {
    await prisma.wishlistItem.delete({ where: { id: existing.id } });
    return { wished: false };
  }
  // Guard the FK — a stale client id must not 500.
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true } });
  if (!product) return { wished: false };
  await prisma.wishlistItem.upsert({
    where: { userId_productId: { userId, productId } },
    create: { userId, productId },
    update: {},
  });
  return { wished: true };
}

export async function removeFromWishlist(userId: string, productId: string): Promise<void> {
  await prisma.wishlistItem.deleteMany({ where: { userId, productId } });
}
