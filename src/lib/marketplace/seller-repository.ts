import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SellerContext } from "@/lib/marketplace/types";

/**
 * Seller-scoped data-access layer (Phase 9C scaffolding).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NOT WIRED. No route or server action calls these in Phase 9C. They are the
 * ONLY sanctioned way for future seller-plane code to touch Offer /
 * OfferInventory / OfferAdjustment.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The isolation contract:
 *   - every function REQUIRES a `SellerContext` and injects
 *     `where: { sellerId: ctx.sellerId }` — a seller can only ever see or change
 *     their own rows;
 *   - ownership is re-checked INSIDE the write transaction (a forged / stale
 *     offerId in a form body fails the `sellerId` guard, not just the route);
 *   - there is deliberately NO unscoped `getOffer(id)` / `listAllOffers()` here.
 *     Cross-seller reads belong to the operator (`/admin`) plane, which has no
 *     `sellerId` filter by design, and to the storefront buy-box resolver
 *     (src/lib/marketplace/offer-resolver.ts), which returns only public fields.
 *
 * `adjustOfferStock` operates ONLY on OfferInventory / OfferAdjustment. It never
 * touches Inventory, Variant.stock or src/lib/inventory.ts — there is no
 * dual-write in Phase 9C.
 *
 * Every function accepts an optional transaction client (same pattern as
 * src/lib/inventory.ts) so callers — and tests — can compose them.
 */

type Client = Prisma.TransactionClient | typeof prisma;

export type SellerRepoError =
  | { ok: false; code: "NOT_FOUND"; error: string }
  | { ok: false; code: "VALIDATION"; error: string }
  | { ok: false; code: "INVARIANT"; error: string };

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type SellerOfferListOptions = {
  status?: string | string[];
  variantId?: string;
  skip?: number;
  take?: number;
};

/** Every Offer owned by `ctx.sellerId`. Never returns another seller's rows. */
export async function listSellerOffers(
  ctx: SellerContext,
  opts: SellerOfferListOptions = {},
  client: Client = prisma,
) {
  const where: Prisma.OfferWhereInput = { sellerId: ctx.sellerId };
  if (opts.status) {
    where.status = Array.isArray(opts.status) ? { in: opts.status } : opts.status;
  }
  if (opts.variantId) where.variantId = opts.variantId;

  return client.offer.findMany({
    where,
    orderBy: { createdAt: "desc" },
    skip: opts.skip,
    take: opts.take,
    include: { inventory: true },
  });
}

/**
 * A single Offer, but only if it belongs to `ctx.sellerId`. Returns `null` for a
 * missing offer AND for another seller's offer — the caller cannot tell the
 * difference, which is intentional.
 */
export async function getOfferForSeller(ctx: SellerContext, offerId: string, client: Client = prisma) {
  return client.offer.findFirst({
    where: { id: offerId, sellerId: ctx.sellerId },
    include: { inventory: true, variant: { select: { id: true, sku: true, productId: true } } },
  });
}

export async function countSellerOffers(ctx: SellerContext, client: Client = prisma): Promise<number> {
  return client.offer.count({ where: { sellerId: ctx.sellerId } });
}

// ---------------------------------------------------------------------------
// Writes — ownership re-checked inside the transaction
// ---------------------------------------------------------------------------

export type AdjustOfferStockResult =
  | { ok: true; previousQuantity: number; newQuantity: number; reserved: number }
  | SellerRepoError;

async function runAdjust(
  tx: Prisma.TransactionClient,
  ctx: SellerContext,
  offerId: string,
  delta: number,
  reason: string,
  note?: string | null,
): Promise<AdjustOfferStockResult> {
  // Lock the OfferInventory row, but ONLY for an offer this seller owns.
  const locked = await tx.$queryRaw<{ id: string; quantity: number; reserved: number }[]>`
    SELECT oi."id", oi."quantity", oi."reserved"
    FROM "OfferInventory" oi
    JOIN "Offer" o ON o."id" = oi."offerId"
    WHERE oi."offerId" = ${offerId} AND o."sellerId" = ${ctx.sellerId}
    FOR UPDATE OF oi`;
  const inv = locked[0];
  if (!inv) {
    return { ok: false, code: "NOT_FOUND", error: "No such offer for this seller." };
  }

  const previousQuantity = inv.quantity;
  const newQuantity = previousQuantity + delta;
  if (newQuantity < 0) {
    return { ok: false, code: "INVARIANT", error: "Stock can’t go below zero." };
  }
  if (newQuantity < inv.reserved) {
    return {
      ok: false,
      code: "INVARIANT",
      error: `Can’t reduce below the ${inv.reserved} unit(s) currently reserved.`,
    };
  }

  await tx.offerInventory.update({ where: { id: inv.id }, data: { quantity: newQuantity } });
  await tx.offerAdjustment.create({
    data: {
      offerInventoryId: inv.id,
      previousQuantity,
      delta,
      newQuantity,
      reason: reason.trim(),
      note: note?.trim() || null,
      actorUserId: null,
    },
  });

  return { ok: true, previousQuantity, newQuantity, reserved: inv.reserved };
}

/**
 * Apply a signed delta to an Offer's own stock (OfferInventory), record an
 * OfferAdjustment, and keep the same invariants Inventory enforces
 * (quantity >= 0, quantity >= reserved). Row-locked for the duration of the
 * transaction so concurrent callers serialise.
 *
 * NOT wired to checkout / cart / any route in Phase 9C.
 */
export async function adjustOfferStock(
  ctx: SellerContext,
  offerId: string,
  delta: number,
  reason: string,
  note?: string | null,
  externalTx?: Prisma.TransactionClient,
): Promise<AdjustOfferStockResult> {
  if (!Number.isInteger(delta)) {
    return { ok: false, code: "VALIDATION", error: "Adjustment must be a whole number." };
  }
  if (!reason || !reason.trim()) {
    return { ok: false, code: "VALIDATION", error: "A reason is required." };
  }

  try {
    if (externalTx) return await runAdjust(externalTx, ctx, offerId, delta, reason, note);
    return await prisma.$transaction((tx) => runAdjust(tx, ctx, offerId, delta, reason, note));
  } catch (err) {
    console.error("[seller-repository] adjustOfferStock failed", err);
    return { ok: false, code: "VALIDATION", error: "Could not adjust stock." };
  }
}
