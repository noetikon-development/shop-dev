import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getReturnsConfig } from "@/lib/returns";

/**
 * Seller settlement — bookkeeping-only payout recording (Phase 9F-8e, hardened
 * in 9F-42B).
 *
 * LOCKED business rules (9F-8e + 9F-8e.1):
 *   - Seller receivable per order = SellerOrder.total - SellerOrder.commissionAmount
 *     (merchandise + shipping, less commission — shipping stays with the seller).
 *   - Only THIRD_PARTY sellers are settled (FIRST_PARTY = Axiaro paying itself).
 *   - An order is eligible only when ALL hold:
 *       settlementId IS NULL, settlementStatus = 'PENDING_CAPTURE',
 *       SellerOrder.status = 'DELIVERED', parent Order.status = 'DELIVERED',
 *       parent Order.paymentStatus = 'PAID'   (9F-42B — P1-A),
 *       the return window has elapsed from Order.deliveredAt ?? Order.placedAt,
 *       and the parent order has no return in a blocking status.
 *   - Manual / on-demand only. No real money moves.
 *
 * 9F-42B additions (all in `getSellerSettlementPreview`, which is the single
 * eligibility + amount authority):
 *   - P1-A: eligibility now also requires `Order.paymentStatus = 'PAID'`. For a
 *     COD order this stays PENDING/UNPAID until an operator (or the PayMongo
 *     webhook) records collection — a delivered COD order is NOT settleable on
 *     delivery alone. No automatic payment mechanism is introduced here.
 *   - P1-B / P1-C: merchandise that was RETURNED before the order is settled has
 *     its frozen value deducted from the settlement receivable
 *     (`preSettlementReturnDeduction`). `SellerOrder.total` /
 *     `merchandiseSubtotal` stay frozen — the deduction lives only in the
 *     preview / settlement math. An OPEN return still blocks the whole order
 *     (SETTLEMENT_BLOCKING_RETURN_STATUSES, unchanged); a completed / refunded
 *     return no longer lets the returned value be paid again.
 *   - P2-B: when clawbacks + a prior carried-forward balance exceed this batch's
 *     receivable, `netAmount` is floored at 0 and the residual is returned as
 *     `carryForwardAmount` — the seller's next settlement subtracts it before
 *     computing its own net. No negative cash payout, no silent write-off.
 *
 * The post-settlement clawback mechanism (SellerOrder.settlementClawbackAmount,
 * settlementStatus 'CLAWED_BACK') is unchanged. Pre-settlement return deductions
 * and post-settlement clawbacks are DISJOINT: a pre-settlement return leaves the
 * order PENDING_CAPTURE (eligible, deducted here); a post-settlement return
 * flips it to CLAWED_BACK (never an eligible candidate, reconciled as a
 * clawback). Nothing is subtracted twice.
 */

type Client = Prisma.TransactionClient | typeof prisma;

/** Return statuses that BLOCK settlement of the parent order (decision F). */
export const SETTLEMENT_BLOCKING_RETURN_STATUSES = [
  "REQUESTED",
  "APPROVED",
  "RECEIVED",
  "REFUND_INITIATED",
] as const;

/**
 * Return statuses where the goods have physically come back, so the returned
 * merchandise value must NOT be paid again at settlement (9F-42B — P1-B/C).
 * RECEIVED and REFUND_INITIATED are also in the blocking set above, so on an
 * ELIGIBLE order only REFUND_COMPLETED is ever seen here — but the full set is
 * the correct semantic definition and stays right if the blocking set changes.
 * REJECTED / CANCELLED are deliberately absent: nothing was returned.
 */
export const RETURN_VALUE_STATUSES = [
  "RECEIVED",
  "REFUND_INITIATED",
  "REFUND_COMPLETED",
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
  /** Frozen value of merchandise returned before settlement — deducted from `receivable` (9F-42B). Usually 0. */
  returnedValueDeducted: number;
  /** total - commissionAmount - returnedValueDeducted */
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
  /** Σ returnedValueDeducted of eligible orders (9F-42B — P1-B/C). */
  preSettlementReturnDeduction: number;
  receivableSubtotal: number; // grossReceivable - commissionAmount - preSettlementReturnDeduction
  clawbackAmount: number; // Σ outstanding post-settlement clawbacks
  /** Unpaid residual carried from the seller's most recent settlement (9F-42B — P2-B). */
  carryForwardPrior: number;
  netAmount: number; // max(0, receivableSubtotal - clawbackAmount - carryForwardPrior)
  /** New residual this settlement would carry forward: max(0, clawbackAmount + carryForwardPrior - receivableSubtotal). */
  carryForwardAmount: number;
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
      preSettlementReturnDeduction: 0,
      receivableSubtotal: 0,
      clawbackAmount: 0,
      carryForwardPrior: 0,
      netAmount: 0,
      carryForwardAmount: 0,
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
          // 9F-42B — P1-A: never settle before the money is in. For a COD order
          // this stays PENDING/UNPAID until collection is recorded.
          paymentStatus: "PAID",
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

  const withinWindow = candidates.filter((so) => {
    const since = so.order.deliveredAt ?? so.order.placedAt;
    return since.getTime() <= cutoff; // return window elapsed
  });

  // 9F-42B — P1-B/C: frozen value of merchandise returned before settlement, per
  // eligible SellerOrder. `ReturnItem.refundAmount` is the immutable
  // unitPrice×qty snapshot; a completed return's status is terminal, so this is
  // stable. Never re-reads Offer.price or Seller.commissionRate.
  const returnedBySellerOrder = new Map<string, number>();
  if (withinWindow.length > 0) {
    const returnItems = await client.returnItem.findMany({
      where: {
        orderItem: { sellerOrderId: { in: withinWindow.map((so) => so.id) } },
        returnRequest: { status: { in: [...RETURN_VALUE_STATUSES] } },
      },
      select: { refundAmount: true, orderItem: { select: { sellerOrderId: true } } },
    });
    for (const ri of returnItems) {
      const soId = ri.orderItem.sellerOrderId;
      if (!soId) continue;
      returnedBySellerOrder.set(soId, (returnedBySellerOrder.get(soId) ?? 0) + ri.refundAmount);
    }
  }

  const eligibleOrders: SettlementPreviewOrder[] = withinWindow.map((so) => {
    const returnedValueDeducted = returnedBySellerOrder.get(so.id) ?? 0;
    return {
      id: so.id,
      orderId: so.order.id,
      orderNumber: so.order.orderNumber,
      status: so.order.status,
      total: so.total,
      commissionAmount: so.commissionAmount,
      returnedValueDeducted,
      receivable: sellerReceivable(so) - returnedValueDeducted,
      deliveredAt: so.order.deliveredAt ? so.order.deliveredAt.toISOString() : null,
      placedAt: so.order.placedAt.toISOString(),
    };
  });

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

  // 9F-42B — P2-B: the unpaid residual from the seller's most recent settlement.
  // Each settlement fully accounts for the prior residual and persists its own,
  // so the latest row always holds the current outstanding carry-forward.
  // `createdAt` is the reliable tiebreaker in production (each settlement is its
  // own transaction, so each gets a distinct now()); `id` is a last-resort
  // deterministic tiebreaker.
  const priorRow = await client.sellerSettlement.findFirst({
    where: { sellerId },
    orderBy: [{ paidAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    select: { carryForwardAmount: true },
  });
  const carryForwardPrior = priorRow?.carryForwardAmount ?? 0;

  const grossReceivable = eligibleOrders.reduce((n, o) => n + o.total, 0);
  const commissionAmount = eligibleOrders.reduce((n, o) => n + o.commissionAmount, 0);
  const preSettlementReturnDeduction = eligibleOrders.reduce((n, o) => n + o.returnedValueDeducted, 0);
  const receivableSubtotal = grossReceivable - commissionAmount - preSettlementReturnDeduction;
  const clawbackAmount = outstandingClawbacks.reduce((n, o) => n + o.clawbackAmount, 0);

  const netRaw = receivableSubtotal - clawbackAmount - carryForwardPrior;

  return {
    sellerId,
    sellerName,
    eligibleOrders,
    outstandingClawbacks,
    grossReceivable,
    commissionAmount,
    preSettlementReturnDeduction,
    receivableSubtotal,
    clawbackAmount,
    carryForwardPrior,
    netAmount: Math.max(0, netRaw),
    carryForwardAmount: Math.max(0, -netRaw),
  };
}

/** Just the net amount currently owed — for a compact seller widget. */
export async function getSellerPendingSettlementTotal(
  sellerId: string,
  client: Client = prisma,
): Promise<number> {
  return (await getSellerSettlementPreview(sellerId, client)).netAmount;
}
