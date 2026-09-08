import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  offerPublishBlockers,
  OFFER_PUBLISH_BLOCKER_MESSAGE,
} from "@/lib/marketplace/seller-repository";
import { isMultiSellerCheckoutEnabled } from "@/lib/marketplace/marketplace-settings";

/**
 * Admin cross-seller Offer read layer (Phase 9F-8d.1).
 *
 * READ-ONLY — no write function lives here, and nothing here ever activates,
 * modifies, or deletes an Offer (that is `src/lib/admin/offer-status.ts`, added
 * in 9F-24D). `listSellerOffersForAdmin` (`src/lib/admin/sellers/repository.ts`)
 * is scoped to one seller (used on `/admin/sellers/[id]`); this is the
 * cross-seller counterpart an operator needs to see every seller's listings in
 * one place, filterable by seller and status.
 */

export const ADMIN_OFFERS_PAGE_SIZE = 50;

const OFFER_STATUS_VALUES = ["DRAFT", "ACTIVE", "INACTIVE", "ARCHIVED"] as const;

export type AdminOfferListFilters = {
  sellerId?: string;
  status?: string;
  page?: number;
};

export type AdminOfferRow = {
  id: string;
  sellerId: string;
  sellerName: string;
  sellerType: string;
  productId: string;
  productName: string;
  variantSku: string;
  sellerSku: string | null;
  condition: string;
  price: number;
  status: string;
  available: number;
  updatedAt: string;
};

export async function listAllOffersForAdmin(filters: AdminOfferListFilters): Promise<{
  rows: AdminOfferRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}> {
  const page = Math.max(1, filters.page ?? 1);

  const AND: Prisma.OfferWhereInput[] = [];
  if (filters.sellerId) AND.push({ sellerId: filters.sellerId });
  if (filters.status && (OFFER_STATUS_VALUES as readonly string[]).includes(filters.status)) {
    AND.push({ status: filters.status });
  }
  const where: Prisma.OfferWhereInput = AND.length ? { AND } : {};

  const [rows, total] = await Promise.all([
    prisma.offer.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      skip: (page - 1) * ADMIN_OFFERS_PAGE_SIZE,
      take: ADMIN_OFFERS_PAGE_SIZE,
      select: {
        id: true,
        sellerId: true,
        condition: true,
        status: true,
        price: true,
        sellerSku: true,
        updatedAt: true,
        seller: { select: { displayName: true, type: true } },
        variant: { select: { sku: true, product: { select: { id: true, name: true } } } },
        inventory: { select: { quantity: true, reserved: true } },
      },
    }),
    prisma.offer.count({ where }),
  ]);

  const mapped: AdminOfferRow[] = rows.map((o) => ({
    id: o.id,
    sellerId: o.sellerId,
    sellerName: o.seller.displayName,
    sellerType: o.seller.type,
    productId: o.variant.product.id,
    productName: o.variant.product.name,
    variantSku: o.variant.sku,
    sellerSku: o.sellerSku,
    condition: o.condition,
    price: o.price,
    status: o.status,
    available: Math.max(0, (o.inventory?.quantity ?? 0) - (o.inventory?.reserved ?? 0)),
    updatedAt: o.updatedAt.toISOString(),
  }));

  return {
    rows: mapped,
    total,
    page,
    pageSize: ADMIN_OFFERS_PAGE_SIZE,
    pageCount: Math.max(1, Math.ceil(total / ADMIN_OFFERS_PAGE_SIZE)),
  };
}

export type AdminOfferDetail = {
  id: string;
  sellerId: string;
  sellerName: string;
  sellerType: string;
  sellerStatus: string;
  productId: string;
  productName: string;
  productSlug: string;
  productStatus: string;
  variantSku: string;
  variantStatus: string;
  optionLabel: string;
  sellerSku: string | null;
  condition: string;
  price: number;
  compareAtPrice: number | null;
  handlingTimeDays: number;
  status: string;
  quantity: number;
  reserved: number;
  available: number;
  reorderPoint: number;
  updatedAt: string;
  /** empty when the offer is already ACTIVE; otherwise the reasons it can't go ACTIVE */
  publishBlockers: string[];
};

/** One offer, cross-seller, with everything `/admin/offers/[id]` needs. */
export async function getAdminOfferDetail(offerId: string): Promise<AdminOfferDetail | null> {
  const o = await prisma.offer.findUnique({
    where: { id: offerId },
    select: {
      id: true,
      sellerId: true,
      condition: true,
      status: true,
      price: true,
      compareAtPrice: true,
      handlingTimeDays: true,
      sellerSku: true,
      updatedAt: true,
      seller: { select: { displayName: true, type: true, status: true } },
      variant: {
        select: {
          sku: true,
          status: true,
          product: { select: { id: true, name: true, slug: true, status: true } },
          optionValues: {
            select: { optionValue: { select: { value: true, option: { select: { sortOrder: true } } } } },
          },
        },
      },
      inventory: { select: { quantity: true, reserved: true, reorderPoint: true } },
    },
  });
  if (!o) return null;

  const quantity = o.inventory?.quantity ?? 0;
  const reserved = o.inventory?.reserved ?? 0;
  const available = Math.max(0, quantity - reserved);
  const marketplaceOpen = await isMultiSellerCheckoutEnabled();
  const publishBlockers =
    o.status === "ACTIVE"
      ? []
      : offerPublishBlockers({
          offerStatus: o.status,
          sellerStatus: o.seller.status,
          marketplaceOpen,
          productStatus: o.variant.product.status,
          variantStatus: o.variant.status,
          available,
        }).map((b) => OFFER_PUBLISH_BLOCKER_MESSAGE[b]);

  return {
    id: o.id,
    sellerId: o.sellerId,
    sellerName: o.seller.displayName,
    sellerType: o.seller.type,
    sellerStatus: o.seller.status,
    productId: o.variant.product.id,
    productName: o.variant.product.name,
    productSlug: o.variant.product.slug,
    productStatus: o.variant.product.status,
    variantSku: o.variant.sku,
    variantStatus: o.variant.status,
    optionLabel:
      o.variant.optionValues
        .slice()
        .sort((a, b) => a.optionValue.option.sortOrder - b.optionValue.option.sortOrder)
        .map((ov) => ov.optionValue.value)
        .join(" · ") || "Default",
    sellerSku: o.sellerSku,
    condition: o.condition,
    price: o.price,
    compareAtPrice: o.compareAtPrice,
    handlingTimeDays: o.handlingTimeDays,
    status: o.status,
    quantity,
    reserved,
    available,
    reorderPoint: o.inventory?.reorderPoint ?? 0,
    updatedAt: o.updatedAt.toISOString(),
    publishBlockers,
  };
}

/** Every seller that has at least one Offer — for the seller filter control. */
export async function listSellersForOfferFilter(): Promise<{ id: string; displayName: string }[]> {
  return prisma.seller.findMany({
    where: { offers: { some: {} } },
    orderBy: { displayName: "asc" },
    select: { id: true, displayName: true },
  });
}

/** Offer counts by status, optionally scoped to one seller — for filter-chip badges. */
export async function adminOfferStatusCounts(sellerId?: string): Promise<Record<string, number>> {
  const rows = await prisma.offer.groupBy({
    by: ["status"],
    where: sellerId ? { sellerId } : undefined,
    _count: { _all: true },
  });
  const out: Record<string, number> = { DRAFT: 0, ACTIVE: 0, INACTIVE: 0, ARCHIVED: 0 };
  for (const r of rows) out[r.status] = r._count._all;
  return out;
}
