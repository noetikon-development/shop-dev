import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { restoreOfferStock } from "@/lib/marketplace/offer-inventory";
import {
  canTransitionReturn,
  isReturnItemCondition,
  returnStatusLabel,
} from "@/lib/returns/status";
import type { SellerContext } from "@/lib/marketplace/types";

/**
 * Seller-scoped ReturnRequest / ReturnItem access (Phase 9F-3).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The ONLY sanctioned way for `/seller` code to read or act on a return. A
 * seller can ONLY see returns that contain at least one of ITS OWN OrderItems,
 * only ever sees ITS OWN return lines, and can only act on a return whose lines
 * are ENTIRELY its own.
 *
 * 9F-3 NEVER: approves / rejects a return, initiates / completes a refund,
 * writes any refund field, touches `Order.status` / `OrderEvent` / the
 * customer-facing timeline, and NEVER touches `Inventory` / `InventoryAdjustment`
 * / `Variant.stock` / `@/lib/inventory` / `adjustStock`. Restock is
 * `restoreOfferStock` (OfferInventory only) + `OfferAdjustment(RETURN)`.
 *
 * Locked decisions:
 *   - the seller's "confirm receipt" IS the `APPROVED → RECEIVED` transition
 *   - per-line idempotency is guaranteed by the RETURN-LEVEL guard
 *     (`status: "APPROVED", restockedAt: null` → `RECEIVED, restockedAt: now`,
 *     status-guarded `updateMany`, count 0 ⇒ abort before any restock) — one
 *     receipt event per return, atomic, no schema change
 *   - a return whose lines are NOT all this seller's is refused (admin handles it)
 * ─────────────────────────────────────────────────────────────────────────────
 */

type Client = Prisma.TransactionClient | typeof prisma;

export type SellerReturnRepoError =
  | { ok: false; code: "NOT_FOUND"; error: string }
  | { ok: false; code: "VALIDATION"; error: string }
  | { ok: false; code: "MIXED_SELLER"; error: string }
  | { ok: false; code: "STALE"; error: string }
  | { ok: false; code: "INVARIANT"; error: string };

// ---------------------------------------------------------------------------
// Reads — every one scoped so items resolve to `ctx.sellerId`
// ---------------------------------------------------------------------------

export type SellerReturnListOptions = { status?: string; q?: string; skip?: number; take?: number };

function listWhere(ctx: SellerContext, opts: SellerReturnListOptions): Prisma.ReturnRequestWhereInput {
  const where: Prisma.ReturnRequestWhereInput = {
    items: { some: { orderItem: { is: { sellerId: ctx.sellerId } } } },
  };
  if (opts.status) where.status = opts.status;
  if (opts.q?.trim()) {
    const q = opts.q.trim();
    where.OR = [
      { returnNumber: { contains: q, mode: "insensitive" } },
      { order: { is: { orderNumber: { contains: q, mode: "insensitive" } } } },
    ];
  }
  return where;
}

export async function listSellerReturns(
  ctx: SellerContext,
  opts: SellerReturnListOptions = {},
  client: Client = prisma,
) {
  return client.returnRequest.findMany({
    where: listWhere(ctx, opts),
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    skip: opts.skip,
    take: opts.take,
    select: {
      id: true,
      returnNumber: true,
      status: true,
      reason: true,
      createdAt: true,
      updatedAt: true,
      order: { select: { orderNumber: true, placedAt: true } },
      // only THIS seller's lines
      items: {
        where: { orderItem: { is: { sellerId: ctx.sellerId } } },
        select: { quantity: true },
      },
    },
  });
}

export async function countSellerReturns(
  ctx: SellerContext,
  opts: SellerReturnListOptions = {},
  client: Client = prisma,
): Promise<number> {
  return client.returnRequest.count({ where: listWhere(ctx, opts) });
}

/**
 * One return for this seller — only if it contains ≥1 of the seller's OrderItems.
 * `items` is filtered to the seller's lines. The `order` select is deliberately
 * minimal: NO `email` / `phone` / `userId` / `billingAddress` / `grandTotal`, no
 * refund fields, no `staffNote`, no sibling seller data.
 */
export async function getSellerReturnForSeller(
  ctx: SellerContext,
  returnId: string,
  client: Client = prisma,
) {
  const ret = await client.returnRequest.findFirst({
    where: { id: returnId, items: { some: { orderItem: { is: { sellerId: ctx.sellerId } } } } },
    select: {
      id: true,
      returnNumber: true,
      status: true,
      reason: true,
      customerNote: true, // product-related, sanitised at intake
      resolutionNote: true, // customer-facing note from the admin decision
      restockedAt: true,
      createdAt: true,
      updatedAt: true,
      order: {
        select: {
          orderNumber: true,
          status: true,
          placedAt: true,
          deliveredAt: true,
          shippingAddress: true, // recipient + phone + address — needed to coordinate
        },
      },
      items: {
        where: { orderItem: { is: { sellerId: ctx.sellerId } } },
        orderBy: { id: "asc" },
        select: {
          id: true,
          orderItemId: true,
          name: true,
          variantLabel: true,
          sku: true,
          unitPrice: true,
          quantity: true,
          restockQuantity: true,
          condition: true,
          orderItem: { select: { offerId: true, sellerId: true } },
        },
      },
    },
  });
  return ret;
}

// ---------------------------------------------------------------------------
// Write — the seller receipt / inspection step
// ---------------------------------------------------------------------------

export type SellerReceiptLine = {
  returnItemId: string;
  receivedQuantity: number;
  restockQuantity: number;
  condition: string;
};

export type SellerReceiveReturnResult =
  | {
      ok: true;
      returnNumber: string;
      orderNumber: string;
      restocked: { name: string; qty: number }[];
      restockedUnits: number;
    }
  | SellerReturnRepoError;

class StaleReturnError extends Error {}
/** Thrown AFTER the status guard so the transaction rolls back with a safe message. */
class ReceiptAbort extends Error {}

/**
 * Round to the nearest centavo, halves away from zero — the SAME rule
 * `checkout.ts`'s creation-time commission calculation uses (9E-3B §15), and
 * the SAME one `src/lib/admin/returns-actions.ts` duplicates for the admin
 * receive path's commission correction (9F-8c). Duplicated locally so this
 * file doesn't import from either of those.
 */
function roundHalfUp(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

/**
 * Confirm physical receipt of a return that is ENTIRELY this seller's, advance it
 * `APPROVED → RECEIVED`, record per-line `restockQuantity` + `condition`, and
 * restore each restockable line through `restoreOfferStock(RETURN)`.
 *
 * Idempotent: the whole thing is one transaction whose first write is the
 * status-guarded `RETURN`-level `updateMany` (`APPROVED` + `restockedAt = null`).
 * A repeat / concurrent submission matches 0 rows and aborts before any restock.
 */
export async function sellerReceiveReturn(
  ctx: SellerContext,
  returnId: string,
  lines: SellerReceiptLine[],
  externalTx?: Prisma.TransactionClient,
): Promise<SellerReceiveReturnResult> {
  const run = async (tx: Prisma.TransactionClient): Promise<SellerReceiveReturnResult> => {
    const ret = await tx.returnRequest.findFirst({
      where: { id: returnId, items: { some: { orderItem: { is: { sellerId: ctx.sellerId } } } } },
      select: {
        id: true,
        returnNumber: true,
        status: true,
        restockedAt: true,
        order: { select: { orderNumber: true } },
        items: {
          orderBy: { id: "asc" },
          select: {
            id: true,
            name: true,
            quantity: true,
            refundAmount: true,
            orderItem: {
              select: {
                sellerId: true,
                offerId: true,
                sellerOrderId: true,
                offer: { select: { sellerId: true } },
              },
            },
          },
        },
      },
    });
    if (!ret) return { ok: false, code: "NOT_FOUND", error: "No such return for this seller." };

    if (!canTransitionReturn(ret.status, "RECEIVED")) {
      return {
        ok: false,
        code: "VALIDATION",
        error: `A return that is ${returnStatusLabel(ret.status)} can't be marked received.`,
      };
    }

    // The seller's "confirm receipt" advances the WHOLE ReturnRequest — so it may
    // only be used when EVERY line is this seller's. A genuinely mixed return
    // (only possible once multi-seller checkout exists) falls back to admin.
    const foreign = ret.items.some((it) => it.orderItem.sellerId !== ctx.sellerId);
    if (foreign) {
      return {
        ok: false,
        code: "MIXED_SELLER",
        error: "This return includes items from another seller — an Axiaro admin will process it.",
      };
    }

    // Validate the submitted lines — must cover every line in the return.
    const byId = new Map(ret.items.map((it) => [it.id, it]));
    const submitted = new Map<string, SellerReceiptLine>();
    for (const l of lines) {
      const it = byId.get(l.returnItemId);
      if (!it) return { ok: false, code: "VALIDATION", error: "A submitted line is not part of this return." };
      if (!isReturnItemCondition(l.condition)) {
        return { ok: false, code: "VALIDATION", error: "Choose a condition for every line." };
      }
      if (
        !Number.isInteger(l.receivedQuantity) ||
        l.receivedQuantity < 0 ||
        l.receivedQuantity > it.quantity
      ) {
        return {
          ok: false,
          code: "VALIDATION",
          error: `Received quantity for "${it.name}" must be 0–${it.quantity}.`,
        };
      }
      if (
        !Number.isInteger(l.restockQuantity) ||
        l.restockQuantity < 0 ||
        l.restockQuantity > l.receivedQuantity
      ) {
        return {
          ok: false,
          code: "VALIDATION",
          error: `Restock quantity for "${it.name}" can't exceed the received quantity.`,
        };
      }
      if (l.restockQuantity > 0 && l.condition !== "RESELLABLE") {
        return {
          ok: false,
          code: "VALIDATION",
          error: `Only resellable units can go back to stock — set restock 0 for "${it.name}".`,
        };
      }
      submitted.set(l.returnItemId, l);
    }
    for (const it of ret.items) {
      if (!submitted.has(it.id)) {
        return { ok: false, code: "VALIDATION", error: "Record a decision for every line before confirming." };
      }
    }

    // 1. Atomic RETURN-level guard — this IS the idempotency mechanism.
    const advanced = await tx.returnRequest.updateMany({
      where: { id: returnId, status: "APPROVED", restockedAt: null },
      data: { status: "RECEIVED", restockedAt: new Date() },
    });
    if (advanced.count === 0) throw new StaleReturnError();

    // 1b. Commission correction (9F-8c.1 — same pattern as the admin receive
    // path in `src/lib/admin/returns-actions.ts`, so there is only ever one
    // commission-adjustment formula in the codebase). The commission on a
    // returned unit was earned on a sale that's now being refunded, so it's
    // reduced by the returned units' snapshotted value (`ReturnItem.refundAmount`
    // == unitPrice × quantity) regardless of restock eligibility — a damaged,
    // non-resellable unit is still being refunded. Every line here is already
    // guaranteed to be `ctx.sellerId`'s own (the `foreign` check above), so
    // this never touches another seller's SellerOrder. Sitting after the
    // guard above (which already threw on a repeat), this can never
    // double-adjust.
    const returnedValueBySellerOrder = new Map<string, number>();
    for (const it of ret.items) {
      const sellerOrderId = it.orderItem.sellerOrderId;
      if (!sellerOrderId) continue; // legacy line, pre-dates the marketplace — no commission was ever recorded
      returnedValueBySellerOrder.set(
        sellerOrderId,
        (returnedValueBySellerOrder.get(sellerOrderId) ?? 0) + it.refundAmount,
      );
    }
    for (const [sellerOrderId, returnedValue] of returnedValueBySellerOrder) {
      if (returnedValue <= 0) continue;
      const so = await tx.sellerOrder.findUnique({
        where: { id: sellerOrderId },
        select: { commissionAmount: true, commissionRate: true },
      });
      if (!so) continue;
      const commissionAdjustment = roundHalfUp((returnedValue * so.commissionRate) / 10000);
      await tx.sellerOrder.update({
        where: { id: sellerOrderId },
        data: { commissionAmount: Math.max(0, so.commissionAmount - commissionAdjustment) },
      });
    }

    // 2. Per-line: persist the assessment, then restock the resellable units.
    const restocked: { name: string; qty: number }[] = [];
    for (const it of ret.items) {
      const l = submitted.get(it.id)!;
      await tx.returnItem.update({
        where: { id: it.id },
        data: { restockQuantity: l.restockQuantity, condition: l.condition },
      });
      if (l.restockQuantity <= 0) continue;

      // Post-guard failures MUST throw (roll back) — never return, which would
      // commit a half-restocked RECEIVED return.
      const offerId = it.orderItem.offerId;
      if (!offerId) throw new ReceiptAbort("A return line is not bound to an offer — can't restock.");
      if (it.orderItem.offer?.sellerId !== ctx.sellerId) {
        throw new ReceiptAbort("A return line's offer does not belong to this seller.");
      }
      const oRes = await restoreOfferStock(
        {
          offerId,
          units: l.restockQuantity,
          reason: "RETURN",
          note: `Return ${ret.returnNumber} (order ${ret.order.orderNumber}) · item ${it.id} · seller receipt`,
          actorUserId: ctx.userId,
        },
        tx,
      );
      if (!oRes.ok) throw new ReceiptAbort(oRes.error ?? "Could not restock a line.");
      restocked.push({ name: it.name, qty: l.restockQuantity });
    }

    return {
      ok: true,
      returnNumber: ret.returnNumber,
      orderNumber: ret.order.orderNumber,
      restocked,
      restockedUnits: restocked.reduce((n, r) => n + r.qty, 0),
    };
  };

  try {
    if (externalTx) return await run(externalTx);
    return await prisma.$transaction(run);
  } catch (err) {
    if (err instanceof StaleReturnError) {
      return { ok: false, code: "STALE", error: "This return was already received — reload the page." };
    }
    if (err instanceof ReceiptAbort) {
      return { ok: false, code: "INVARIANT", error: err.message };
    }
    console.error("[seller-return-repository] sellerReceiveReturn failed", err);
    return { ok: false, code: "VALIDATION", error: "Could not confirm receipt." };
  }
}
