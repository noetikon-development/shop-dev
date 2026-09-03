import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isReturnStatus } from "@/lib/returns/status";
import { remainingReturnableByOrderItem } from "@/lib/returns";
import { FIRST_PARTY_OFFER_FILTER } from "@/lib/admin/first-party-inventory";

/**
 * Admin read layer for Returns / RMA (Step 21 P3). Uncached — admins see live
 * data. Server-side paginated. Historical accuracy: the return reads the
 * immutable snapshots stored on ReturnItem, never live Product / Variant data.
 */

export const RETURNS_PAGE_SIZE = 20;

export type AdminReturnListFilters = {
  q?: string;
  status?: string;
  range?: string; // "7d" | "30d" | "90d"
  page?: number;
};

export type AdminReturnRow = {
  id: string;
  returnNumber: string;
  orderId: string;
  orderNumber: string;
  customerName: string;
  customerEmail: string;
  status: string;
  reason: string;
  adminAssisted: boolean;
  itemCount: number;
  unitCount: number;
  refundAmount: number | null;
  createdAt: string;
  updatedAt: string;
};

const RANGE_DAYS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 };

export async function listAdminReturns(filters: AdminReturnListFilters) {
  const page = Math.max(1, filters.page ?? 1);
  const AND: Prisma.ReturnRequestWhereInput[] = [];

  if (filters.q?.trim()) {
    const q = filters.q.trim();
    AND.push({
      OR: [
        { returnNumber: { contains: q, mode: "insensitive" } },
        { order: { is: { orderNumber: { contains: q, mode: "insensitive" } } } },
        { order: { is: { email: { contains: q, mode: "insensitive" } } } },
        { user: { is: { name: { contains: q, mode: "insensitive" } } } },
        { user: { is: { email: { contains: q, mode: "insensitive" } } } },
      ],
    });
  }
  if (filters.status && isReturnStatus(filters.status)) {
    AND.push({ status: filters.status });
  }
  if (filters.range && RANGE_DAYS[filters.range]) {
    const cutoff = new Date(Date.now() - RANGE_DAYS[filters.range] * 24 * 60 * 60 * 1000);
    AND.push({ createdAt: { gte: cutoff } });
  }

  const where: Prisma.ReturnRequestWhereInput = AND.length ? { AND } : {};

  const [rows, total] = await Promise.all([
    prisma.returnRequest.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: (page - 1) * RETURNS_PAGE_SIZE,
      take: RETURNS_PAGE_SIZE,
      select: {
        id: true,
        returnNumber: true,
        status: true,
        reason: true,
        adminAssisted: true,
        refundAmount: true,
        createdAt: true,
        updatedAt: true,
        order: { select: { id: true, orderNumber: true, email: true } },
        user: { select: { name: true, email: true } },
        items: { select: { quantity: true } },
      },
    }),
    prisma.returnRequest.count({ where }),
  ]);

  const mapped: AdminReturnRow[] = rows.map((r) => ({
    id: r.id,
    returnNumber: r.returnNumber,
    orderId: r.order.id,
    orderNumber: r.order.orderNumber,
    customerName: r.user?.name ?? "—",
    customerEmail: r.user?.email ?? r.order.email,
    status: r.status,
    reason: r.reason,
    adminAssisted: r.adminAssisted,
    itemCount: r.items.length,
    unitCount: r.items.reduce((n, i) => n + i.quantity, 0),
    refundAmount: r.refundAmount,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));

  return {
    rows: mapped,
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / RETURNS_PAGE_SIZE)),
  };
}

export type AdminReturnDetail = Awaited<ReturnType<typeof getAdminReturn>>;

export async function getAdminReturn(id: string) {
  const ret = await prisma.returnRequest.findUnique({
    where: { id },
    select: {
      id: true,
      returnNumber: true,
      status: true,
      reason: true,
      customerNote: true,
      staffNote: true,
      resolutionNote: true,
      adminAssisted: true,
      overriddenRules: true,
      refundAmount: true,
      refundMethod: true,
      refundReference: true,
      refundInitiatedAt: true,
      refundCompletedAt: true,
      restockedAt: true,
      createdAt: true,
      updatedAt: true,
      user: { select: { id: true, name: true, email: true } },
      order: {
        select: {
          id: true,
          orderNumber: true,
          email: true,
          status: true,
          paymentMethod: true,
          paymentStatus: true,
          grandTotal: true,
          subtotal: true,
          shippingFee: true,
          placedAt: true,
          deliveredAt: true,
        },
      },
      items: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          orderItemId: true,
          productId: true,
          variantId: true,
          name: true,
          variantLabel: true,
          sku: true,
          unitPrice: true,
          quantity: true,
          refundAmount: true,
          restockQuantity: true,
          condition: true,
        },
      },
    },
  });
  if (!ret) return null;

  // Whether each returned line's variant still has a restock target (so the UI
  // can warn that a restock would be skipped). Phase 9E-3D-3: this probes the
  // operational authority — the Axiaro FIRST_PARTY `OfferInventory` — not the
  // legacy `Inventory` mirror. `receiveReturnAction` restocks the bound
  // `OfferInventory` for an offer-native line; a line whose variant was
  // hard-deleted has neither store and is the only case this flags.
  const variantIds = [...new Set(ret.items.map((i) => i.variantId).filter((v): v is string => !!v))];
  const withInventory = variantIds.length
    ? new Set(
        (
          await prisma.offerInventory.findMany({
            where: { offer: { variantId: { in: variantIds }, ...FIRST_PARTY_OFFER_FILTER } },
            select: { offer: { select: { variantId: true } } },
          })
        ).map((r) => r.offer.variantId),
      )
    : new Set<string>();

  return {
    ...ret,
    createdAt: ret.createdAt.toISOString(),
    updatedAt: ret.updatedAt.toISOString(),
    refundInitiatedAt: ret.refundInitiatedAt?.toISOString() ?? null,
    refundCompletedAt: ret.refundCompletedAt?.toISOString() ?? null,
    restockedAt: ret.restockedAt?.toISOString() ?? null,
    order: {
      ...ret.order,
      placedAt: ret.order.placedAt.toISOString(),
      deliveredAt: ret.order.deliveredAt?.toISOString() ?? null,
    },
    items: ret.items.map((i) => ({
      ...i,
      variantHasInventory: i.variantId ? withInventory.has(i.variantId) : false,
    })),
  };
}

/** Distinct statuses present, for the list filter dropdown. */
export async function returnStatusesInUse(): Promise<string[]> {
  const rows = await prisma.returnRequest.findMany({
    distinct: ["status"],
    select: { status: true },
    orderBy: { status: "asc" },
  });
  return rows.map((r) => r.status);
}

/** Open counts per status for the list header / dashboards. */
export async function getReturnCounts(): Promise<Record<string, number>> {
  const groups = await prisma.returnRequest.groupBy({ by: ["status"], _count: { _all: true } });
  const out: Record<string, number> = { ALL: 0 };
  for (const g of groups) {
    out[g.status] = g._count._all;
    out.ALL += g._count._all;
  }
  return out;
}

/**
 * For the admin "start a return" panel on the order page: the order's lines with
 * how many units of each are still returnable.
 */
export async function orderReturnableLines(orderId: string) {
  const [order, remaining] = await Promise.all([
    prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        items: {
          orderBy: { id: "asc" },
          select: {
            id: true,
            productId: true,
            variantId: true,
            name: true,
            variantLabel: true,
            sku: true,
            unitPrice: true,
            quantity: true,
          },
        },
      },
    }),
    remainingReturnableByOrderItem(orderId),
  ]);
  if (!order) return null;
  return {
    order: { id: order.id, orderNumber: order.orderNumber, status: order.status },
    lines: order.items.map((it) => ({
      orderItemId: it.id,
      productId: it.productId,
      variantId: it.variantId,
      name: it.name,
      variantLabel: it.variantLabel,
      sku: it.sku,
      unitPrice: it.unitPrice,
      orderedQuantity: it.quantity,
      remaining: remaining.get(it.id) ?? 0,
    })),
  };
}
