import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Admin cross-seller SellerOrder read layer (Phase 9F-8d.1).
 *
 * READ-ONLY — no write function lives here. `SellerOrder` previously appeared
 * in `/admin` only as a write side-effect of `cancelOrderAction`'s cascade
 * (`src/lib/admin/order-actions.ts`); this gives an operator the first way to
 * actually SEE marketplace orders, their money, and their (already-correct,
 * 9F-8c/9F-8c.1) commission figure, without a database query.
 *
 * Never touches Product / Variant / Offer / OfferInventory / Inventory,
 * never recalculates commission, never writes a settlement/payout record.
 */

export const ADMIN_SELLER_ORDERS_PAGE_SIZE = 50;

const SELLER_ORDER_STATUS_VALUES = [
  "PENDING_PAYMENT",
  "PROCESSING",
  "READY_TO_SHIP",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
] as const;

export type AdminSellerOrderListFilters = {
  sellerId?: string;
  status?: string;
  page?: number;
};

export type AdminSellerOrderRow = {
  id: string;
  sellerId: string;
  sellerName: string;
  sellerType: string;
  orderId: string;
  orderNumber: string;
  customerEmail: string;
  status: string;
  merchandiseSubtotal: number;
  shippingFee: number;
  total: number;
  commissionAmount: number;
  createdAt: string;
};

export async function listAdminSellerOrders(filters: AdminSellerOrderListFilters): Promise<{
  rows: AdminSellerOrderRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}> {
  const page = Math.max(1, filters.page ?? 1);

  const AND: Prisma.SellerOrderWhereInput[] = [];
  if (filters.sellerId) AND.push({ sellerId: filters.sellerId });
  if (filters.status && (SELLER_ORDER_STATUS_VALUES as readonly string[]).includes(filters.status)) {
    AND.push({ status: filters.status });
  }
  const where: Prisma.SellerOrderWhereInput = AND.length ? { AND } : {};

  const [rows, total] = await Promise.all([
    prisma.sellerOrder.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: (page - 1) * ADMIN_SELLER_ORDERS_PAGE_SIZE,
      take: ADMIN_SELLER_ORDERS_PAGE_SIZE,
      select: {
        id: true,
        sellerId: true,
        sellerName: true,
        sellerType: true,
        status: true,
        merchandiseSubtotal: true,
        shippingFee: true,
        total: true,
        commissionAmount: true,
        createdAt: true,
        order: { select: { id: true, orderNumber: true, email: true } },
      },
    }),
    prisma.sellerOrder.count({ where }),
  ]);

  const mapped: AdminSellerOrderRow[] = rows.map((so) => ({
    id: so.id,
    sellerId: so.sellerId,
    sellerName: so.sellerName,
    sellerType: so.sellerType,
    orderId: so.order.id,
    orderNumber: so.order.orderNumber,
    customerEmail: so.order.email,
    status: so.status,
    merchandiseSubtotal: so.merchandiseSubtotal,
    shippingFee: so.shippingFee,
    total: so.total,
    commissionAmount: so.commissionAmount,
    createdAt: so.createdAt.toISOString(),
  }));

  return {
    rows: mapped,
    total,
    page,
    pageSize: ADMIN_SELLER_ORDERS_PAGE_SIZE,
    pageCount: Math.max(1, Math.ceil(total / ADMIN_SELLER_ORDERS_PAGE_SIZE)),
  };
}

export type AdminSellerOrderDetail = {
  id: string;
  sellerId: string;
  sellerName: string;
  sellerType: string;
  supportEmail: string;
  commissionRate: number;
  commissionAmount: number;
  shippingMethodName: string | null;
  shippingFee: number;
  freeShippingApplied: boolean | null;
  merchandiseSubtotal: number;
  discountAllocated: number;
  total: number;
  status: string;
  settlementStatus: string;
  createdAt: string;
  updatedAt: string;
  order: {
    id: string;
    orderNumber: string;
    email: string;
    status: string;
    placedAt: string;
    customerName: string | null;
  };
  items: {
    id: string;
    name: string;
    variantLabel: string | null;
    sku: string | null;
    unitPrice: number;
    quantity: number;
    lineTotal: number;
  }[];
};

export async function getAdminSellerOrder(id: string): Promise<AdminSellerOrderDetail | null> {
  const so = await prisma.sellerOrder.findUnique({
    where: { id },
    select: {
      id: true,
      sellerId: true,
      sellerName: true,
      sellerType: true,
      supportEmail: true,
      commissionRate: true,
      commissionAmount: true,
      shippingMethodName: true,
      shippingFee: true,
      freeShippingApplied: true,
      merchandiseSubtotal: true,
      discountAllocated: true,
      total: true,
      status: true,
      settlementStatus: true,
      createdAt: true,
      updatedAt: true,
      order: {
        select: {
          id: true,
          orderNumber: true,
          email: true,
          status: true,
          placedAt: true,
          user: { select: { name: true } },
        },
      },
      items: {
        orderBy: { id: "asc" },
        select: { id: true, name: true, variantLabel: true, sku: true, unitPrice: true, quantity: true, lineTotal: true },
      },
    },
  });
  if (!so) return null;

  const { order, ...rest } = so;
  return {
    ...rest,
    createdAt: so.createdAt.toISOString(),
    updatedAt: so.updatedAt.toISOString(),
    order: {
      id: order.id,
      orderNumber: order.orderNumber,
      email: order.email,
      status: order.status,
      placedAt: order.placedAt.toISOString(),
      customerName: order.user?.name ?? null,
    },
  };
}

/** Every seller that has at least one SellerOrder — for the seller filter control. */
export async function listSellersForSellerOrderFilter(): Promise<{ id: string; displayName: string }[]> {
  const rows = await prisma.sellerOrder.findMany({
    distinct: ["sellerId"],
    select: { sellerId: true, sellerName: true },
    orderBy: { sellerName: "asc" },
  });
  return rows.map((r) => ({ id: r.sellerId, displayName: r.sellerName }));
}

/**
 * Σ commissionAmount, optionally scoped to one seller. Purely a read of the
 * already-stored (and, per 9F-8c/9F-8c.1, already correctly cancellation- and
 * return-adjusted) column — NOT a recalculation, and NOT a settlement figure
 * (no payout has necessarily been made against it).
 */
export async function adminCommissionTotal(sellerId?: string): Promise<number> {
  const agg = await prisma.sellerOrder.aggregate({
    where: sellerId ? { sellerId } : undefined,
    _sum: { commissionAmount: true },
  });
  return agg._sum.commissionAmount ?? 0;
}
