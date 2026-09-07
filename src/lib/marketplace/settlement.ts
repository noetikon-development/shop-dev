import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getReturnsConfig } from "@/lib/returns";

/**
 * Seller settlement — bookkeeping-only payout recording (Phase 9F-8e).
 *
 * LOCKED business rules (9F-8e + 9F-8e.1):
 *   - Seller receivable per order = SellerOrder.total - SellerOrder.commissionAmount
 *     (merchandise + shipping, less commission — shipping stays with the seller).
 *   - Only THIRD_PARTY sellers are settled (FIRST_PARTY = Axiaro paying itself).
 *   - An order is eligible only when ALL hold:
 *       settlementId IS NULL, settlementStatus = 'PENDING_CAPTURE',
 *       SellerOrder.status = 'DELIVERED', parent Order.status = 'DELIVERED',
 *       the return window has elapsed from Order.deliveredAt ?? Order.placedAt,
 *       and the parent order has no return in a blocking status.
 *   - Manual / on-demand only. netAmount MAY be <= 0. No real money moves.
 *   - Post-settlement cancellation / return -> settlementStatus = 'CLAWED_BACK'
 *     and `settlementClawbackAmount` accrues the amount to recover, netted into
 *     the next batch.
 */

type Client = Prisma.TransactionClient | typeof prisma;

/** Return statuses that BLOCK settlement of the parent order (decision F). */
export const SETTLEMENT_BLOCKING_RETURN_STATUSES = [
  "REQUESTED",
  "APPROVED",
  "RECEIVED",
  "REFUND_INITIATED",
] as const;

/** What Axiaro owes the seller for one settled order. */
export function sellerReceivable(so: { total: number; commissionAmount: number }): number {
  return so.total - so.commissionAmount;
}

export type SettlementPreviewOrder = {
  id: string;
  orderId: string;
  orderNumber: string;
  status: string;
  total: number;
  commissionAmount: number;
  receivable: number;
  deliveredAt: string | null;
  placedAt: string;
};

export type SettlementClawbackOrder = {
  id: string;
  orderId: string;
  orderNumber: string;
  status: string;
  clawbackAmount: number;
};

export type SettlementPreview = {
  sellerId: string;
  sellerName: string | null;
  eligibleOrders: SettlementPreviewOrder[];
  outstandingClawbacks: SettlementClawbackOrder[];
  grossReceivable: number; // Σ total of eligible orders
  commissionAmount: number; // Σ commission of eligible orders
  receivableSubtotal: number; // grossReceivable - commissionAmount
  clawbackAmount: number; // Σ outstanding clawbacks
  netAmount: number; // receivableSubtotal - clawbackAmount (may be <= 0)
};

/**
 * Everything the admin/seller needs to see what Axiaro owes ONE third-party
 * seller right now. Pure read. The `client` argument threads a transaction
 * client for automated tests; production callers omit it.
 */
export async function getSellerSettlementPreview(
  sellerId: string,
  client: Client = prisma,
): Promise<SettlementPreview> {
  const seller = await client.seller.findUnique({
    where: { id: sellerId },
    select: { displayName: true, type: true },
  });

  // FIRST_PARTY is never settled (decision B). An unknown seller is likewise
  // not settleable. In both cases `sellerName` is returned as null — the
  // "this seller cannot be settled" signal that `recordSettlement` checks.
  if (!seller || seller.type !== "THIRD_PARTY") {
    return {
      sellerId,
      sellerName: null,
      eligibleOrders: [],
      outstandingClawbacks: [],
      grossReceivable: 0,
      commissionAmount: 0,
      receivableSubtotal: 0,
      clawbackAmount: 0,
      netAmount: 0,
    };
  }
  const sellerName = seller.displayName;

  const { windowDays } = await getReturnsConfig();
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;

  const candidates = await client.sellerOrder.findMany({
    where: {
      sellerId,
      sellerType: "THIRD_PARTY",
      settlementId: null,
      settlementStatus: "PENDING_CAPTURE",
      status: "DELIVERED",
      order: {
        is: {
          status: "DELIVERED",
          returnRequests: { none: { status: { in: [...SETTLEMENT_BLOCKING_RETURN_STATUSES] } } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      total: true,
      commissionAmount: true,
      order: { select: { id: true, orderNumber: true, status: true, deliveredAt: true, placedAt: true } },
    },
  });

  const eligibleOrders: SettlementPreviewOrder[] = [];
  for (const so of candidates) {
    const since = so.order.deliveredAt ?? so.order.placedAt;
    if (since.getTime() > cutoff) continue; // return window not elapsed yet
    eligibleOrders.push({
      id: so.id,
      orderId: so.order.id,
      orderNumber: so.order.orderNumber,
      status: so.order.status,
      total: so.total,
      commissionAmount: so.commissionAmount,
      receivable: sellerReceivable(so),
      deliveredAt: so.order.deliveredAt ? so.order.deliveredAt.toISOString() : null,
      placedAt: so.order.placedAt.toISOString(),
    });
  }

  const clawbackRows = await client.sellerOrder.findMany({
    where: { sellerId, settlementStatus: "CLAWED_BACK", settlementClawbackAmount: { gt: 0 } },
    orderBy: { updatedAt: "asc" },
    select: {
      id: true,
      status: true,
      settlementClawbackAmount: true,
      order: { select: { id: true, orderNumber: true } },
    },
  });
  const outstandingClawbacks: SettlementClawbackOrder[] = clawbackRows.map((so) => ({
    id: so.id,
    orderId: so.order.id,
    orderNumber: so.order.orderNumber,
    status: so.status,
    clawbackAmount: so.settlementClawbackAmount,
  }));

  const grossReceivable = eligibleOrders.reduce((n, o) => n + o.total, 0);
  const commissionAmount = eligibleOrders.reduce((n, o) => n + o.commissionAmount, 0);
  const receivableSubtotal = grossReceivable - commissionAmount;
  const clawbackAmount = outstandingClawbacks.reduce((n, o) => n + o.clawbackAmount, 0);

  return {
    sellerId,
    sellerName,
    eligibleOrders,
    outstandingClawbacks,
    grossReceivable,
    commissionAmount,
    receivableSubtotal,
    clawbackAmount,
    netAmount: receivableSubtotal - clawbackAmount,
  };
}

/** Just the net amount currently owed (or negative) — for a compact seller widget. */
export async function getSellerPendingSettlementTotal(
  sellerId: string,
  client: Client = prisma,
): Promise<number> {
  return (await getSellerSettlementPreview(sellerId, client)).netAmount;
}
