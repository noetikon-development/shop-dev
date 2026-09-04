import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  listSellerOffers,
  countSellerOffersWhere,
  getOfferForSeller,
  sellerOfferStatusCounts,
  sellerLowStockCount,
  type SellerOfferListOptions,
} from "@/lib/marketplace/seller-repository";
import type { SellerContext } from "@/lib/marketplace/types";

type Client = Prisma.TransactionClient | typeof prisma;

/**
 * Read models for the `/seller` pages. Every function takes the established
 * `SellerContext` and delegates to the seller-scoped repository — there is no
 * unscoped query here.
 */

const PAGE_SIZE = 20;

type OfferRow = Awaited<ReturnType<typeof listSellerOffers>>[number];

function optionLabel(v: OfferRow["variant"]): string {
  return v.optionValues
    .slice()
    .sort((a, b) => a.optionValue.option.sortOrder - b.optionValue.option.sortOrder)
    .map((ov) => ov.optionValue.value)
    .join(" · ");
}

export type SellerOfferView = {
  id: string;
  productId: string;
  productName: string;
  productSlug: string;
  optionLabel: string;
  variantSku: string;
  sellerSku: string | null;
  condition: string;
  status: string;
  price: number;
  compareAtPrice: number | null;
  handlingTimeDays: number;
  quantity: number;
  reserved: number;
  available: number;
  reorderPoint: number;
  lowStock: boolean;
  updatedAt: Date;
};

function toView(o: OfferRow): SellerOfferView {
  const quantity = o.inventory?.quantity ?? 0;
  const reserved = o.inventory?.reserved ?? 0;
  const reorderPoint = o.inventory?.reorderPoint ?? 0;
  const available = Math.max(0, quantity - reserved);
  return {
    id: o.id,
    productId: o.variant.product.id,
    productName: o.variant.product.name,
    productSlug: o.variant.product.slug,
    optionLabel: optionLabel(o.variant) || "Default",
    variantSku: o.variant.sku,
    sellerSku: o.sellerSku,
    condition: o.condition,
    status: o.status,
    price: o.price,
    compareAtPrice: o.compareAtPrice,
    handlingTimeDays: o.handlingTimeDays,
    quantity,
    reserved,
    available,
    reorderPoint,
    lowStock: o.status !== "ARCHIVED" && available <= reorderPoint,
    updatedAt: o.updatedAt,
  };
}

export async function getSellerDashboard(ctx: SellerContext) {
  const [statusCounts, lowStock, recent] = await Promise.all([
    sellerOfferStatusCounts(ctx),
    sellerLowStockCount(ctx),
    listSellerOffers(ctx, { take: 5 }),
  ]);
  const total = statusCounts.DRAFT + statusCounts.ACTIVE + statusCounts.INACTIVE + statusCounts.ARCHIVED;
  return {
    statusCounts,
    lowStock,
    totalOffers: total,
    recent: recent.map(toView),
  };
}

export async function listSellerOffersPage(
  ctx: SellerContext,
  opts: { q?: string; status?: string; page?: number } = {},
) {
  const page = Math.max(1, opts.page ?? 1);
  const where: Pick<SellerOfferListOptions, "q" | "status"> = {};
  if (opts.q?.trim()) where.q = opts.q.trim();
  if (opts.status && opts.status !== "ALL") where.status = opts.status;

  const [rows, total] = await Promise.all([
    listSellerOffers(ctx, { ...where, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
    countSellerOffersWhere(ctx, where),
  ]);

  return {
    rows: rows.map(toView),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}

export async function getSellerOfferDetail(
  ctx: SellerContext,
  offerId: string,
): Promise<SellerOfferView | null> {
  const o = await getOfferForSeller(ctx, offerId);
  return o ? toView(o) : null;
}

export type ListableVariant = {
  variantId: string;
  productName: string;
  optionLabel: string;
  sku: string;
  catalogPrice: number;
  categoryName: string;
};

const OFFER_CONDITIONS = ["NEW", "REFURBISHED", "USED_LIKE_NEW", "USED_GOOD"] as const;
export type OfferCondition = (typeof OFFER_CONDITIONS)[number];

/**
 * Catalog Variants this seller could still list against — ACTIVE variant of an
 * ACTIVE/DRAFT product, excluding variants where the seller already has an offer
 * for the given `condition`. Optional `q` (product name / SKU) and `categoryId`
 * narrow the set; `categoryId` matches the product's own category OR any of its
 * descendant categories.
 *
 * Read-only against the shared catalog — the seller can pick a Variant to attach
 * an Offer to, never see or change Product / Variant data.
 */
export async function findListableVariants(
  ctx: SellerContext,
  opts: { q?: string; condition?: string; categoryId?: string; limit?: number } = {},
  client: Client = prisma,
): Promise<ListableVariant[]> {
  const q = opts.q?.trim();
  const condition = opts.condition ?? "NEW";
  const limit = Math.min(opts.limit ?? 20, 50);

  const existing = await client.offer.findMany({
    where: { sellerId: ctx.sellerId, condition },
    select: { variantId: true },
  });
  const taken = new Set(existing.map((e) => e.variantId));

  const categoryIds = opts.categoryId ? await categoryWithDescendants(opts.categoryId, client) : null;

  const variants = await client.variant.findMany({
    where: {
      status: "ACTIVE",
      product: {
        status: { in: ["ACTIVE", "DRAFT"] },
        ...(categoryIds ? { categoryId: { in: categoryIds } } : {}),
        ...(q ? { name: { contains: q, mode: "insensitive" } } : {}),
      },
      ...(q && !categoryIds
        ? {
            OR: [
              { sku: { contains: q, mode: "insensitive" } },
              { product: { name: { contains: q, mode: "insensitive" } } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      sku: true,
      price: true,
      product: { select: { name: true, category: { select: { name: true } } } },
      optionValues: {
        select: { optionValue: { select: { value: true, option: { select: { sortOrder: true } } } } },
      },
    },
    orderBy: [{ product: { name: "asc" } }, { sku: "asc" }],
    take: limit + taken.size + 5,
  });

  return variants
    .filter((v) => !taken.has(v.id))
    .slice(0, limit)
    .map((v) => ({
      variantId: v.id,
      productName: v.product.name,
      categoryName: v.product.category?.name ?? "Uncategorised",
      optionLabel:
        v.optionValues
          .slice()
          .sort((a, b) => a.optionValue.option.sortOrder - b.optionValue.option.sortOrder)
          .map((ov) => ov.optionValue.value)
          .join(" · ") || "Default",
      sku: v.sku,
      catalogPrice: v.price,
    }));
}

/** One category id + all of its descendant ids (the catalog tree is shallow). */
async function categoryWithDescendants(rootId: string, client: Client = prisma): Promise<string[]> {
  const all = await client.category.findMany({ select: { id: true, parentId: true } });
  const childrenOf = new Map<string, string[]>();
  for (const c of all) {
    if (!c.parentId) continue;
    const list = childrenOf.get(c.parentId) ?? [];
    list.push(c.id);
    childrenOf.set(c.parentId, list);
  }
  const out = new Set<string>([rootId]);
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    for (const child of childrenOf.get(id) ?? []) {
      if (!out.has(child)) {
        out.add(child);
        stack.push(child);
      }
    }
  }
  return [...out];
}

export type ListingCategory = {
  id: string;
  name: string;
  parentName: string | null;
  productCount: number;
};

/**
 * Active catalog categories for the "browse by category" step, each with a
 * count of ACTIVE/DRAFT products carrying at least one ACTIVE variant. Public
 * catalog data — no seller scoping needed.
 */
export async function listListingCategories(client: Client = prisma): Promise<ListingCategory[]> {
  const cats = await client.category.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      parent: { select: { name: true } },
      _count: {
        select: {
          products: { where: { status: { in: ["ACTIVE", "DRAFT"] }, variants: { some: { status: "ACTIVE" } } } },
        },
      },
    },
  });
  return cats
    .map((c) => ({
      id: c.id,
      name: c.name,
      parentName: c.parent?.name ?? null,
      productCount: c._count.products,
    }))
    .filter((c) => c.productCount > 0);
}

export type ListableVariantState =
  | {
      state: "ok";
      variantId: string;
      productName: string;
      productSlug: string;
      categoryName: string;
      optionLabel: string;
      sku: string;
      catalogPrice: number;
      catalogCompareAt: number | null;
      /** conditions the seller already lists for this variant — disabled in the form */
      takenConditions: OfferCondition[];
    }
  | { state: "archived"; productName: string; reason: string }
  | { state: "not_found" };

/**
 * Resolve one catalog Variant for the "create listing" step. Returns:
 *   - `ok` with the canonical facts + which conditions the seller already lists;
 *   - `archived` when the variant or its product is archived (a listing can't be
 *     created — the caller shows a read-only explanation);
 *   - `not_found` when the id doesn't resolve at all.
 */
export async function getListableVariantState(
  ctx: SellerContext,
  variantId: string,
  client: Client = prisma,
): Promise<ListableVariantState> {
  const v = await client.variant.findUnique({
    where: { id: variantId },
    select: {
      id: true,
      sku: true,
      price: true,
      compareAtPrice: true,
      status: true,
      product: {
        select: { name: true, slug: true, status: true, category: { select: { name: true } } },
      },
      optionValues: {
        select: { optionValue: { select: { value: true, option: { select: { sortOrder: true } } } } },
      },
    },
  });
  if (!v) return { state: "not_found" };

  if (v.status !== "ACTIVE" || v.product.status === "ARCHIVED") {
    return {
      state: "archived",
      productName: v.product.name,
      reason:
        v.product.status === "ARCHIVED"
          ? "Axiaro has archived this product."
          : "Axiaro has archived this product option.",
    };
  }

  const existing = await client.offer.findMany({
    where: { sellerId: ctx.sellerId, variantId: v.id },
    select: { condition: true },
  });
  const takenConditions = existing
    .map((e) => e.condition)
    .filter((c): c is OfferCondition => (OFFER_CONDITIONS as readonly string[]).includes(c));

  return {
    state: "ok",
    variantId: v.id,
    productName: v.product.name,
    productSlug: v.product.slug,
    categoryName: v.product.category?.name ?? "Uncategorised",
    optionLabel:
      v.optionValues
        .slice()
        .sort((a, b) => a.optionValue.option.sortOrder - b.optionValue.option.sortOrder)
        .map((ov) => ov.optionValue.value)
        .join(" · ") || "Default",
    sku: v.sku,
    catalogPrice: v.price,
    catalogCompareAt: v.compareAtPrice,
    takenConditions,
  };
}
