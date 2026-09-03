import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * FIRST_PARTY (Axiaro) admin inventory authority.
 *
 * Phase 9E-3D-6: the admin stock-adjustment and threshold paths write
 * `OfferInventory` ONLY. `syncFirstPartyOfferStock` / `syncFirstPartyOfferReorderPoint`
 * are the WHOLE write — they row-lock the FIRST_PARTY (`condition = 'NEW'`)
 * `OfferInventory`, mutate it, record an `OfferAdjustment` (stock only —
 * threshold changes carry no adjustment, mirroring the old `setReorderPoint`),
 * and re-derive `Variant.stock` DIRECTLY from `OfferInventory` (D-3: the column
 * retires with `Inventory` later). No `Inventory` row is read, locked or
 * written. A THIRD_PARTY offer is never touched.
 *
 * `syncFirstPartyOfferPrice` stays a ONE-WAY write-through: the catalog price
 * edit (`Variant.price`) still drives the 1P `Offer.price` copy (9D-A).
 *
 * SALE / CANCELLATION / RETURN movements live in `src/lib/marketplace/offer-inventory.ts`
 * (checkout / cancel / return — Phase 9E-3C-2 / 9E-3D-1 / 9E-3D-5); those paths
 * do NOT update `Variant.stock` (it is a transitional mirror until S7).
 */

type Tx = Prisma.TransactionClient | typeof prisma;

/**
 * A user-safe result. `error` is copy that MAY be shown to an admin verbatim
 * (matches the wording `src/lib/inventory.ts` used) — never an internal detail.
 */
export type OfferStockResult =
  | { ok: true; previousQuantity: number; newQuantity: number; reserved: number }
  | { ok: false; error: string };

/**
 * Re-derive `Variant.stock` (the denormalised AVAILABLE mirror) from the
 * Axiaro FIRST_PARTY `OfferInventory` — `max(0, quantity - reserved)`. Written
 * directly; no `Inventory` read. `Variant.stock` is read by nobody since 9D-D
 * and retires with `Inventory` (D-3); this keeps it coherent in the meantime.
 */
export async function syncVariantStockFromFirstPartyOffer(
  variantId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "Variant" SET "stock" = GREATEST(0, COALESCE((
      SELECT oi."quantity" - oi."reserved"
      FROM "OfferInventory" oi
      JOIN "Offer" o ON o."id" = oi."offerId"
      JOIN "Seller" s ON s."id" = o."sellerId"
      WHERE o."variantId" = ${variantId} AND s."type" = 'FIRST_PARTY' AND o."condition" = 'NEW'
    ), 0))
    WHERE "id" = ${variantId}`;
}

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
 * Apply a signed `delta` to the Axiaro FIRST_PARTY `OfferInventory` on-hand
 * quantity, record an `OfferAdjustment`, and re-derive `Variant.stock` — all
 * inside the caller's transaction. Phase 9E-3D-6: this is the WHOLE admin stock
 * write; no `Inventory` row is read, locked or written.
 *
 * Row-locks the `OfferInventory` row (`FOR UPDATE`) scoped to the FIRST_PARTY,
 * `condition = 'NEW'` offer — a THIRD_PARTY offer on the same variant is never
 * touched. Rejects (returns `{ ok:false }`, does NOT throw) a change that would
 * take quantity below 0 or below the currently reserved amount — the caller
 * surfaces `error` verbatim. Throws only on an unexpected DB failure, which the
 * caller sanitizes.
 *
 * `reserved` is never changed here (admin stock adjustments only move on-hand
 * quantity — reservation state is owned by checkout).
 */
export async function syncFirstPartyOfferStock(
  variantId: string,
  delta: number,
  reason: string,
  note: string | null,
  actorUserId: string | null,
  tx: Prisma.TransactionClient,
): Promise<OfferStockResult> {
  const locked = await tx.$queryRaw<{ id: string; quantity: number; reserved: number }[]>`
    SELECT oi."id", oi."quantity", oi."reserved"
    FROM "OfferInventory" oi
    JOIN "Offer" o ON o."id" = oi."offerId"
    JOIN "Seller" s ON s."id" = o."sellerId"
    WHERE o."variantId" = ${variantId} AND s."type" = 'FIRST_PARTY' AND o."condition" = 'NEW'
    FOR UPDATE OF oi`;
  const inv = locked[0];
  if (!inv) return { ok: false, error: "No inventory record for that variant." };

  const previousQuantity = inv.quantity;
  const newQuantity = previousQuantity + delta;
  if (newQuantity < 0) {
    return { ok: false, error: "Stock can’t go below zero." };
  }
  if (newQuantity < inv.reserved) {
    return { ok: false, error: `Can’t reduce below the ${inv.reserved} unit(s) currently reserved.` };
  }

  if (delta !== 0) {
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
    await syncVariantStockFromFirstPartyOffer(variantId, tx);
  }

  return { ok: true, previousQuantity, newQuantity, reserved: inv.reserved };
}

/**
 * Set the Axiaro FIRST_PARTY `OfferInventory.reorderPoint`. Phase 9E-3D-6: the
 * WHOLE admin threshold write — no `Inventory.reorderPoint` update. No
 * `OfferAdjustment` (a threshold change is not a quantity change, matching the
 * old `setReorderPoint`). `Variant.stock` is unaffected (it is derived from
 * available, not the reorder point). Row-locks the `OfferInventory` row.
 */
export async function syncFirstPartyOfferReorderPoint(
  variantId: string,
  reorderPoint: number,
  tx: Prisma.TransactionClient,
): Promise<{ ok: true; previous: number } | { ok: false; error: string }> {
  const locked = await tx.$queryRaw<{ id: string; reorderPoint: number }[]>`
    SELECT oi."id", oi."reorderPoint"
    FROM "OfferInventory" oi
    JOIN "Offer" o ON o."id" = oi."offerId"
    JOIN "Seller" s ON s."id" = o."sellerId"
    WHERE o."variantId" = ${variantId} AND s."type" = 'FIRST_PARTY' AND o."condition" = 'NEW'
    FOR UPDATE OF oi`;
  const inv = locked[0];
  if (!inv) return { ok: false, error: "No inventory record for that variant." };
  await tx.offerInventory.update({ where: { id: inv.id }, data: { reorderPoint } });
  return { ok: true, previous: inv.reorderPoint };
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
