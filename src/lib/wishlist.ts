import "server-only";
import { prisma } from "@/lib/prisma";
import { artKindFromRef } from "@/lib/art-ref";
import { stockStatusFromAvailable, rollupStatus } from "@/lib/inventory-status";
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
      images: { orderBy: { sortOrder: "asc" as const }, take: 1, select: { url: true, alt: true } },
      options: {
        where: { name: "Colour" },
        select: { values: { orderBy: { sortOrder: "asc" as const }, select: { swatchHex: true } } },
      },
      variants: {
        where: { status: "ACTIVE" },
        select: { id: true, stock: true, inventory: { select: { reorderPoint: true } } },
      },
    },
  },
} as const;

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
    const inStock = available && p.variants.some((v) => v.stock > 0);
    const stockStatus = rollupStatus(
      p.variants.map((v) => stockStatusFromAvailable(v.stock, v.inventory?.reorderPoint ?? 0)),
    );
    return {
      id: p.id,
      slug: p.slug,
      name: p.name,
      brand: p.brand,
      shortDescription: p.shortDescription,
      price: p.price,
      compareAtPrice: p.compareAtPrice,
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
