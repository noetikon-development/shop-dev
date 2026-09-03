import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * 1P Offer write-through (Phase 9D-A price, Phase 9D-D stock).
 *
 * The storefront selling price (9D-A) AND stock/availability (9D-D) now read the
 * Axiaro FIRST_PARTY `Offer` / `OfferInventory`. `Offer.price` and
 * `OfferInventory` were frozen 9C copies, so the existing admin write paths must
 * keep the matching 1P offer in step — otherwise an admin edit would leave the
 * storefront showing the stale copy.
 *
 * This is ONE-WAY transitional sync only:
 *   admin write → Inventory / Variant / Product → matching 1P Offer / OfferInventory.
 * It never makes `Offer` the source of truth, never has `OfferInventory` write
 * back to `Inventory`, never changes `src/lib/inventory.ts`'s row-lock behaviour,
 * and never touches a THIRD_PARTY offer (ownership is pinned to the FIRST_PARTY
 * seller id / `condition = 'NEW'`).
 *
 * NOT synced here (deferred to Phase 9E with the checkout inventory writer):
 * the SALE deduction at checkout, the order-cancellation reversal, and the
 * returns restock. Between 9D-D and 9E those paths move `Inventory` without
 * `OfferInventory`, so the storefront availability figure can be transiently
 * stale — but checkout re-reads live `Inventory` transactionally, so it can
 * never oversell (see the §26 display-vs-reservation split).
 */

type Tx = Prisma.TransactionClient | typeof prisma;

/** The Axiaro FIRST_PARTY seller id (one row, enforced unique by a partial index). */
export async function firstPartySellerId(tx: Tx = prisma): Promise<string | null> {
  const seller = await tx.seller.findFirst({
    where: { type: "FIRST_PARTY" },
    select: { id: true },
  });
  return seller?.id ?? null;
}

/**
 * Push the current commercial values of a Variant onto its Axiaro FIRST_PARTY
 * offer (NEW condition). No-op when the 1P seller or the offer is missing —
 * `ensureFirstPartyOffer` covers creation.
 */
export async function syncFirstPartyOfferPrice(
  variantId: string,
  data: { price: number; compareAtPrice: number | null },
  tx: Tx = prisma,
): Promise<void> {
  const sellerId = await firstPartySellerId(tx);
  if (!sellerId) return;
  await tx.offer.updateMany({
    where: { variantId, sellerId, condition: "NEW" },
    data: { price: data.price, compareAtPrice: data.compareAtPrice },
  });
}

/**
 * Apply the SAME signed `delta` an `adjustStock` call applied to `Inventory` to
 * the matching Axiaro FIRST_PARTY `OfferInventory`, and record an
 * `OfferAdjustment` (Phase 9D-D). MUST be called inside the same transaction as
 * the `adjustStock` call so the two moves are atomic.
 *
 * Row-locks the `OfferInventory` row (`FOR UPDATE`) scoped to the FIRST_PARTY
 * seller — a THIRD_PARTY offer on the same variant is never touched. Throws on an
 * invariant violation (`quantity < 0` or `< reserved`) so the whole transaction
 * rolls back; this can only fire if `OfferInventory` had already drifted, since
 * `adjustStock` guards `Inventory` with the identical rules first.
 *
 * `reserved` is never changed here (admin stock adjustments only move on-hand
 * quantity — reservation state is owned by checkout, deferred to 9E).
 */
export async function syncFirstPartyOfferStock(
  variantId: string,
  delta: number,
  reason: string,
  note: string | null,
  actorUserId: string | null,
  tx: Prisma.TransactionClient,
): Promise<void> {
  if (delta === 0) return;
  const sellerId = await firstPartySellerId(tx);
  if (!sellerId) return;

  const locked = await tx.$queryRaw<{ id: string; quantity: number; reserved: number }[]>`
    SELECT oi."id", oi."quantity", oi."reserved"
    FROM "OfferInventory" oi
    JOIN "Offer" o ON o."id" = oi."offerId"
    WHERE o."variantId" = ${variantId} AND o."sellerId" = ${sellerId} AND o."condition" = 'NEW'
    FOR UPDATE OF oi`;
  const inv = locked[0];
  // No 1P OfferInventory yet — `ensureFirstPartyOffer` creates it on variant
  // creation, so this only happens for a pre-migration gap; nothing to sync.
  if (!inv) return;

  const previousQuantity = inv.quantity;
  const newQuantity = previousQuantity + delta;
  if (newQuantity < 0 || newQuantity < inv.reserved) {
    throw new Error(
      `syncFirstPartyOfferStock: OfferInventory invariant violation for variant ${variantId} ` +
        `(prev ${previousQuantity}, delta ${delta}, reserved ${inv.reserved}) — rolling back.`,
    );
  }

  await tx.offerInventory.update({ where: { id: inv.id }, data: { quantity: newQuantity } });
  await tx.offerAdjustment.create({
    data: {
      offerInventoryId: inv.id,
      previousQuantity,
      delta,
      newQuantity,
      reason,
      note: note?.trim() || null,
      actorUserId,
    },
  });
}

/**
 * Sync the Axiaro FIRST_PARTY `OfferInventory.reorderPoint` to the value an admin
 * just wrote to `Inventory.reorderPoint` (Phase 9D-D). Call inside the same
 * transaction as `setReorderPoint`. No `OfferAdjustment` (not a quantity change,
 * mirroring `setReorderPoint`).
 */
export async function syncFirstPartyOfferReorderPoint(
  variantId: string,
  reorderPoint: number,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const sellerId = await firstPartySellerId(tx);
  if (!sellerId) return;
  await tx.offerInventory.updateMany({
    where: { offer: { variantId, sellerId, condition: "NEW" } },
    data: { reorderPoint },
  });
}

/**
 * Create the Axiaro FIRST_PARTY offer (+ its OfferInventory + opening
 * OfferAdjustment) for a newly-created Variant, if it does not already exist.
 * Safe to call inside the same transaction that created the Variant + Inventory.
 */
export async function ensureFirstPartyOffer(
  variant: {
    id: string;
    sku: string;
    price: number;
    compareAtPrice: number | null;
  },
  opts: { productStatus: string; costPrice: number | null },
  tx: Tx = prisma,
): Promise<void> {
  const sellerId = await firstPartySellerId(tx);
  if (!sellerId) return;

  const existing = await tx.offer.findUnique({
    where: {
      sellerId_variantId_condition: { sellerId, variantId: variant.id, condition: "NEW" },
    },
    select: { id: true, inventory: { select: { id: true } } },
  });

  let offerId = existing?.id ?? null;
  if (!offerId) {
    const created = await tx.offer.create({
      data: {
        sellerId,
        variantId: variant.id,
        price: variant.price,
        compareAtPrice: variant.compareAtPrice,
        costPrice: opts.costPrice,
        sellerSku: variant.sku,
        condition: "NEW",
        status: opts.productStatus === "ACTIVE" ? "ACTIVE" : "DRAFT",
        fulfillmentType: "SELLER_FULFILLED",
        handlingTimeDays: 2,
      },
      select: { id: true },
    });
    offerId = created.id;
  }

  if (!existing?.inventory) {
    // Copy the just-created Inventory row (quantity is 0 at creation).
    const inv = await tx.inventory.findUnique({
      where: { variantId: variant.id },
      select: { quantity: true, reserved: true, reorderPoint: true, restockEta: true, sku: true },
    });
    const created = await tx.offerInventory.create({
      data: {
        offerId,
        sellerSku: inv?.sku ?? variant.sku,
        quantity: inv?.quantity ?? 0,
        reserved: inv?.reserved ?? 0,
        reorderPoint: inv?.reorderPoint ?? 3,
        restockEta: inv?.restockEta ?? null,
      },
      select: { id: true, quantity: true },
    });
    await tx.offerAdjustment.create({
      data: {
        offerInventoryId: created.id,
        previousQuantity: 0,
        delta: created.quantity,
        newQuantity: created.quantity,
        reason: "MIGRATION_OPENING",
        note: "Phase 9D-A — opening balance for an admin-created variant.",
        actorUserId: null,
      },
    });
  }
}
