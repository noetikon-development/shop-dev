import "server-only";
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
};

/**
 * Catalog Variants this seller could still list an offer against (ACTIVE
 * variant, non-archived product, no existing offer for this seller at the given
 * condition). Read-only against the shared catalog — the seller cannot see or
 * change Product / Variant data, only pick one to attach an Offer to.
 */
export async function findListableVariants(
  ctx: SellerContext,
  opts: { q?: string; condition?: string; limit?: number } = {},
): Promise<ListableVariant[]> {
  const q = opts.q?.trim();
  const condition = opts.condition ?? "NEW";
  const limit = Math.min(opts.limit ?? 20, 50);

  const existing = await prisma.offer.findMany({
    where: { sellerId: ctx.sellerId, condition },
    select: { variantId: true },
  });
  const taken = new Set(existing.map((e) => e.variantId));

  const variants = await prisma.variant.findMany({
    where: {
      status: "ACTIVE",
      product: { status: { in: ["ACTIVE", "DRAFT"] } },
      ...(q
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
      product: { select: { name: true } },
      optionValues: {
        select: { optionValue: { select: { value: true, option: { select: { sortOrder: true } } } } },
      },
    },
    orderBy: [{ product: { name: "asc" } }, { sku: "asc" }],
    take: limit + taken.size,
  });

  return variants
    .filter((v) => !taken.has(v.id))
    .slice(0, limit)
    .map((v) => ({
      variantId: v.id,
      productName: v.product.name,
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
