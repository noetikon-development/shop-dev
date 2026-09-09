import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getSellerSettlementPreview } from "@/lib/marketplace/settlement";

/**
 * Admin seller-settlement read layer + record-settlement core (Phase 9F-8e).
 *
 * Bookkeeping-only. `recordSettlement` creates one `SellerSettlement` row and
 * stamps the covered `SellerOrder`s under a status-guarded write. No real money
 * moves. The permission check (`manage_payments`) lives in the thin server
 * action (`settlement-actions.ts`); this core is `client`-aware for tests.
 */

export const ADMIN_SETTLEMENTS_PAGE_SIZE = 50;

export type AdminSettlementRow = {
  id: string;
  sellerId: string;
  sellerName: string;
  status: string;
  grossReceivable: number;
  commissionAmount: number;
  clawbackAmount: number;
  netAmount: number;
  carryForwardAmount: number;
  orderCount: number;
  clawbackCount: number;
  paidAt: string;
  paymentReference: string | null;
  paymentMethod: string | null;
  createdAt: string;
};

export async function listAdminSettlements(filters: { sellerId?: string; page?: number }): Promise<{
  rows: AdminSettlementRow[];
  total: number;
  page: number;
  pageCount: number;
}> {
  const page = Math.max(1, filters.page ?? 1);
  const where: Prisma.SellerSettlementWhereInput = filters.sellerId ? { sellerId: filters.sellerId } : {};

  const [rows, total] = await Promise.all([
    prisma.sellerSettlement.findMany({
      where,
      orderBy: [{ paidAt: "desc" }, { id: "asc" }],
      skip: (page - 1) * ADMIN_SETTLEMENTS_PAGE_SIZE,
      take: ADMIN_SETTLEMENTS_PAGE_SIZE,
    }),
    prisma.sellerSettlement.count({ where }),
  ]);

  return {
    rows: rows.map((s) => ({
      id: s.id,
      sellerId: s.sellerId,
      sellerName: s.sellerName,
      status: s.status,
      grossReceivable: s.grossReceivable,
      commissionAmount: s.commissionAmount,
      clawbackAmount: s.clawbackAmount,
      netAmount: s.netAmount,
      carryForwardAmount: s.carryForwardAmount ?? 0,
      orderCount: s.orderCount,
      clawbackCount: s.clawbackCount,
      paidAt: s.paidAt.toISOString(),
      paymentReference: s.paymentReference,
      paymentMethod: s.paymentMethod,
      createdAt: s.createdAt.toISOString(),
    })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / ADMIN_SETTLEMENTS_PAGE_SIZE)),
  };
}

export async function getAdminSettlement(id: string) {
  const s = await prisma.sellerSettlement.findUnique({
    where: { id },
    include: {
      sellerOrders: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          status: true,
          settlementStatus: true,
          total: true,
          commissionAmount: true,
          settlementClawbackAmount: true,
          order: { select: { id: true, orderNumber: true, email: true } },
        },
      },
    },
  });
  if (!s) return null;
  return {
    ...s,
    paidAt: s.paidAt.toISOString(),
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

/** THIRD_PARTY sellers only, for the settlement seller picker. */
export async function listThirdPartySellersForSettlement(): Promise<{ id: string; displayName: string }[]> {
  return prisma.seller.findMany({
    where: { type: "THIRD_PARTY" },
    orderBy: { displayName: "asc" },
    select: { id: true, displayName: true },
  });
}

export type RecordSettlementInput = {
  sellerId: string;
  paidAt: Date;
  paymentReference?: string | null;
  paymentMethod?: string | null;
  note?: string | null;
  actorUserId?: string | null;
};

export type RecordSettlementResult =
  | {
      ok: true;
      settlementId: string;
      netAmount: number;
      carryForwardAmount: number;
      orderCount: number;
      clawbackCount: number;
    }
  | { ok: false; code: "NOTHING_TO_SETTLE" | "CONFLICT" | "NOT_THIRD_PARTY"; error: string };

/**
 * Create one bookkeeping settlement batch for a seller, covering every
 * currently-eligible unsettled order plus every outstanding clawback. The
 * amounts are ALWAYS recomputed here from the DB — a caller never supplies them.
 *
 * Concurrency / duplicate-settlement guard: the SellerOrder writes are
 * status-guarded (`settlementId: null` for the positive orders,
 * `settlementClawbackAmount: { gt: 0 }` for the clawbacks). If either
 * `updateMany` touches fewer rows than expected, the whole thing rolls back —
 * someone else settled some of these in a parallel request.
 */
export async function recordSettlement(
  input: RecordSettlementInput,
  externalTx?: Prisma.TransactionClient,
): Promise<RecordSettlementResult> {
  const run = async (tx: Prisma.TransactionClient): Promise<RecordSettlementResult> => {
    const preview = await getSellerSettlementPreview(input.sellerId, tx);
    if (preview.sellerName === null) {
      return { ok: false, code: "NOT_THIRD_PARTY", error: "No such third-party seller." };
    }
    if (preview.eligibleOrders.length === 0 && preview.outstandingClawbacks.length === 0) {
      return { ok: false, code: "NOTHING_TO_SETTLE", error: "There is nothing to settle for this seller right now." };
    }

    const positiveIds = preview.eligibleOrders.map((o) => o.id);
    const clawbackIds = preview.outstandingClawbacks.map((o) => o.id);
    // 9F-42B — orders whose returned-before-settlement merchandise value is being
    // deducted from this batch. Folded into the row's clawback aggregate (same
    // kind of money: goods that came back), never double-counted with the
    // post-settlement clawback set above (disjoint by settlementStatus).
    const preSettlementReturnCount = preview.eligibleOrders.filter((o) => o.returnedValueDeducted > 0).length;

    const settlement = await tx.sellerSettlement.create({
      data: {
        sellerId: input.sellerId,
        sellerName: preview.sellerName,
        status: "PAID",
        grossReceivable: preview.grossReceivable,
        commissionAmount: preview.commissionAmount,
        clawbackAmount: preview.clawbackAmount + preview.preSettlementReturnDeduction,
        netAmount: preview.netAmount, // 9F-42B — floored at 0; a residual goes to carryForwardAmount
        carryForwardAmount: preview.carryForwardAmount,
        orderCount: positiveIds.length,
        clawbackCount: clawbackIds.length + preSettlementReturnCount,
        paidAt: input.paidAt,
        paymentReference: input.paymentReference?.trim() || null,
        paymentMethod: input.paymentMethod?.trim() || null,
        note: input.note?.trim() || null,
        createdById: input.actorUserId ?? null,
      },
      select: { id: true },
    });

    if (positiveIds.length > 0) {
      const res = await tx.sellerOrder.updateMany({
        where: { id: { in: positiveIds }, settlementId: null, settlementStatus: "PENDING_CAPTURE" },
        data: { settlementId: settlement.id, settlementStatus: "SETTLED" },
      });
      if (res.count !== positiveIds.length) {
        throw new SettlementConflict();
      }
    }

    if (clawbackIds.length > 0) {
      const res = await tx.sellerOrder.updateMany({
        where: { id: { in: clawbackIds }, settlementStatus: "CLAWED_BACK", settlementClawbackAmount: { gt: 0 } },
        // Re-point at the reconciling batch and zero the outstanding amount —
        // the batch's own `clawbackAmount` now holds the historical total.
        data: { settlementId: settlement.id, settlementClawbackAmount: 0 },
      });
      if (res.count !== clawbackIds.length) {
        throw new SettlementConflict();
      }
    }

    return {
      ok: true,
      settlementId: settlement.id,
      netAmount: preview.netAmount,
      carryForwardAmount: preview.carryForwardAmount,
      orderCount: positiveIds.length,
      clawbackCount: clawbackIds.length + preSettlementReturnCount,
    };
  };

  try {
    if (externalTx) return await run(externalTx);
    return await prisma.$transaction(run);
  } catch (err) {
    if (err instanceof SettlementConflict) {
      return { ok: false, code: "CONFLICT", error: "The eligible orders changed while you were recording this. Reload and try again." };
    }
    throw err;
  }
}

class SettlementConflict extends Error {}
