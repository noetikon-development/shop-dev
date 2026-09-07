import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SellerContext } from "@/lib/marketplace/types";
import { getSellerSettlementPreview, type SettlementPreview } from "@/lib/marketplace/settlement";

/**
 * Seller-scoped settlement / statement read layer (Phase 9F-8e).
 *
 * READ-ONLY. Every function REQUIRES a `SellerContext` and scopes on
 * `ctx.sellerId` — a seller only ever sees its OWN settlement batches and its
 * OWN pending figure. No customer data, no other seller's data, no write path.
 */

type Client = Prisma.TransactionClient | typeof prisma;

export type SellerSettlementListRow = {
  id: string;
  paidAt: string;
  grossReceivable: number;
  commissionAmount: number;
  clawbackAmount: number;
  netAmount: number;
  orderCount: number;
  clawbackCount: number;
  paymentReference: string | null;
  paymentMethod: string | null;
};

export async function listSellerSettlements(
  ctx: SellerContext,
  client: Client = prisma,
): Promise<SellerSettlementListRow[]> {
  const rows = await client.sellerSettlement.findMany({
    where: { sellerId: ctx.sellerId, status: "PAID" },
    orderBy: { paidAt: "desc" },
    select: {
      id: true,
      paidAt: true,
      grossReceivable: true,
      commissionAmount: true,
      clawbackAmount: true,
      netAmount: true,
      orderCount: true,
      clawbackCount: true,
      paymentReference: true,
      paymentMethod: true,
    },
  });
  return rows.map((s) => ({ ...s, paidAt: s.paidAt.toISOString() }));
}

export async function getSellerSettlement(
  ctx: SellerContext,
  settlementId: string,
  client: Client = prisma,
) {
  const s = await client.sellerSettlement.findFirst({
    where: { id: settlementId, sellerId: ctx.sellerId },
    select: {
      id: true,
      paidAt: true,
      status: true,
      grossReceivable: true,
      commissionAmount: true,
      clawbackAmount: true,
      netAmount: true,
      orderCount: true,
      clawbackCount: true,
      paymentReference: true,
      paymentMethod: true,
      note: true,
      sellerOrders: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          status: true,
          settlementStatus: true,
          total: true,
          commissionAmount: true,
          order: { select: { orderNumber: true } },
        },
      },
    },
  });
  if (!s) return null;
  return { ...s, paidAt: s.paidAt.toISOString() };
}

/** The live "pending this cycle" figure for the seller's own statement page. */
export async function getSellerPendingStatement(
  ctx: SellerContext,
  client: Client = prisma,
): Promise<SettlementPreview> {
  return getSellerSettlementPreview(ctx.sellerId, client);
}
