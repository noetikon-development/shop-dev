import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * OfferInventory mutation primitives (Phase 9E-3C-2 SALE; Phase 9E-3D-1 reversal).
 *
 * The exact analogue of `adjustStock({ delta, reason })` in
 * `src/lib/inventory.ts`, operating on `OfferInventory` instead of `Inventory`.
 * Every write is a single atomic, row-locked (`SELECT … FOR UPDATE`),
 * condition-guarded UPDATE so concurrent callers serialise and can never
 * oversell or go negative.
 *
 * SALE (`commitOfferStockForSale`) — 9E-3C-2. MVP (9E-3B §11): stock is
 * COMMITTED at order creation (online payment dormant, no reservation hold), so
 * `quantity` is deducted directly. `reserved` is never touched.
 *
 * REVERSAL (`restoreOfferStock`) — 9E-3D-1. Adds units back on a cancellation
 * or a return receipt, with an append-only `OfferAdjustment` (reason
 * "CANCELLATION" / "RETURN").
 *
 * LOCK ORDER (9E-3D-1 §12): every dual-store mutation locks **OfferInventory
 * before Inventory**. Callers that also touch the legacy `Inventory` row for a
 * FIRST_PARTY offer MUST call the OfferInventory primitive here FIRST, then
 * `adjustStock`, inside ONE `$transaction` — the two move together or roll back
 * together (the 9E-3C-2 / 9E-3D-1 migration-window guard). This module never
 * touches `Inventory` / `Variant.stock` itself.
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

/**
 * Restore units to one Offer's inventory on a cancellation or a return receipt:
 * `quantity += units`, plus an `OfferAdjustment` history row. Row-locks the
 * `OfferInventory` row (`FOR UPDATE`) for the rest of the transaction.
 *
 * `reason` is "CANCELLATION" or "RETURN" (`OfferAdjustment.reason` is a free
 * string — the vocabulary matches `InventoryAdjustment`). `note` carries the
 * human-readable order / return / item reference (there is no `orderId` /
 * `orderItemId` FK on `OfferAdjustment`; the structural identity is
 * `offerInventoryId` + `delta`).
 *
 * MUST run inside the cancellation / return `$transaction`, and BEFORE the
 * matching `adjustStock` reversal for a FIRST_PARTY offer (lock order §12).
 */
export async function restoreOfferStock(
  params: {
    offerId: string;
    units: number;
    reason: string; // "CANCELLATION" | "RETURN"
    note?: string | null;
    actorUserId?: string | null;
  },
  tx: Prisma.TransactionClient,
): Promise<CommitOfferStockResult> {
  const { offerId, units, reason, note = null, actorUserId = null } = params;
  if (!Number.isInteger(units) || units <= 0) {
    return { ok: false, error: "Restore quantity must be a positive whole number." };
  }

  const locked = await tx.$queryRaw<{ id: string; quantity: number }[]>`
    SELECT "id", "quantity"
    FROM "OfferInventory"
    WHERE "offerId" = ${offerId}
    FOR UPDATE`;
  const inv = locked[0];
  if (!inv) return { ok: false, error: "No offer inventory to restore." };

  const previousQuantity = inv.quantity;
  const newQuantity = previousQuantity + units;

  await tx.offerInventory.update({
    where: { id: inv.id },
    data: { quantity: newQuantity },
  });
  await tx.offerAdjustment.create({
    data: {
      offerInventoryId: inv.id,
      previousQuantity,
      delta: units,
      newQuantity,
      reason,
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
