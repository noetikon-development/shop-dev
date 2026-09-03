import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * OfferInventory checkout writer (Phase 9E-3C-2).
 *
 * The exact analogue of `adjustStock({ delta: -qty, reason: "SALE" })` in
 * `src/lib/inventory.ts`, operating on `OfferInventory` instead of `Inventory`.
 * A single atomic, row-locked, condition-guarded UPDATE so concurrent checkouts
 * serialise and can never oversell.
 *
 * MVP (9E-3B §11): stock is COMMITTED at order creation — online payment is not
 * active, so there is no reservation hold window. This deducts `quantity`
 * directly and writes an append-only `OfferAdjustment` row (reason "SALE").
 * `reserved` is not touched (nothing is reserved).
 *
 * MUST be called inside the checkout `$transaction`. For an Axiaro FIRST_PARTY
 * offer the caller ALSO applies the same `-qty` delta to the legacy `Inventory`
 * row via `adjustStock` in the SAME transaction — the two writes commit together
 * or roll back together (9E-3C-2 §7, the migration-window guard). This module
 * never touches `Inventory` / `Variant.stock` itself.
 */

export type CommitOfferStockResult =
  | { ok: true; previousQuantity: number; newQuantity: number }
  | { ok: false; error: string };

/**
 * Commit a sale against one Offer's inventory: `quantity -= units`, guarded so
 * the result never goes below zero or below the currently-reserved amount, plus
 * an `OfferAdjustment` history row. Row-locks the `OfferInventory` row for the
 * rest of the transaction.
 */
export async function commitOfferStockForSale(
  params: {
    offerId: string;
    units: number;
    note?: string | null;
    actorUserId?: string | null;
  },
  tx: Prisma.TransactionClient,
): Promise<CommitOfferStockResult> {
  const { offerId, units, note = null, actorUserId = null } = params;
  if (!Number.isInteger(units) || units <= 0) {
    return { ok: false, error: "Sale quantity must be a positive whole number." };
  }

  const locked = await tx.$queryRaw<{ id: string; quantity: number; reserved: number }[]>`
    SELECT "id", "quantity", "reserved"
    FROM "OfferInventory"
    WHERE "offerId" = ${offerId}
    FOR UPDATE`;
  const inv = locked[0];
  if (!inv) return { ok: false, error: "That item is no longer available." };

  const previousQuantity = inv.quantity;
  const newQuantity = previousQuantity - units;
  if (newQuantity < 0 || newQuantity < inv.reserved) {
    return { ok: false, error: "That item just sold out." };
  }

  await tx.offerInventory.update({
    where: { id: inv.id },
    data: { quantity: newQuantity },
  });
  await tx.offerAdjustment.create({
    data: {
      offerInventoryId: inv.id,
      previousQuantity,
      delta: -units,
      newQuantity,
      reason: "SALE",
      note: note?.trim() || null,
      actorUserId,
    },
  });

  return { ok: true, previousQuantity, newQuantity };
}

/** available = max(0, quantity - reserved) for one Offer. Read-only helper. */
export async function getOfferAvailable(
  offerId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<number> {
  const rows = await client.$queryRaw<{ available: number }[]>`
    SELECT GREATEST(0, "quantity" - "reserved")::int AS available
    FROM "OfferInventory" WHERE "offerId" = ${offerId}`;
  return rows[0]?.available ?? 0;
}
