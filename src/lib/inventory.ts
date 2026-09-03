import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Transaction-safe `Inventory` primitives. Every write is a single atomic,
 * condition-guarded UPDATE (Postgres row-locks for the duration), so concurrent
 * callers serialise and can never produce an invalid state. The DB CHECK
 * constraints (quantity >= 0, reserved >= 0, quantity >= reserved) are the final
 * backstop.
 *
 * Authority note: `OfferInventory` is the operational source of truth for
 * FIRST_PARTY stock (9E-3D-2). `Inventory` + `Variant.stock` +
 * `InventoryAdjustment` are a FROZEN historical archive as of the 9E-3D-5 /
 * 9E-3D-6 deploys (D-1) — checkout / cancel / return / admin no longer write
 * `Inventory` for offer-native operations.
 *
 * Still live:
 *   `adjustStock` — the `Inventory` leg of the LEGACY cancellation / return
 *   fallback ONLY (a re-opened pre-retirement order — `order-actions.ts` /
 *   `returns-actions.ts`). Keeps its row-lock / `InventoryAdjustment` /
 *   `Variant.stock`-mirror behaviour for that path.
 *
 * DEAD / FUTURE UTILITY — unwired, do not delete:
 *   `setReorderPoint` (0 callers since 9E-3D-6 — the admin threshold write is
 *   `syncFirstPartyOfferReorderPoint`); `getAvailableStock` (the storefront
 *   reads OfferInventory); `reserveStock` / `releaseStock` / `commitStock` (the
 *   reservation foundation for an online-payment hold, still dormant).
 */

type Client = Prisma.TransactionClient | typeof prisma;

/** Available = max(0, quantity - reserved). */
export async function getAvailableStock(variantId: string, client: Client = prisma): Promise<number> {
  const rows = await client.$queryRaw<{ available: number }[]>`
    SELECT GREATEST(0, "quantity" - "reserved")::int AS available
    FROM "Inventory" WHERE "variantId" = ${variantId}`;
  return rows[0]?.available ?? 0;
}

/** Re-derive the denormalised Variant.stock (= available) after any change. */
async function syncVariantMirror(client: Client, variantId: string): Promise<void> {
  await client.$executeRaw`
    UPDATE "Variant"
    SET "stock" = GREATEST(0, COALESCE(
      (SELECT "quantity" - "reserved" FROM "Inventory" WHERE "variantId" = ${variantId}), 0))
    WHERE "id" = ${variantId}`;
}

export type AdjustResult = {
  ok: boolean;
  error?: string;
  previousQuantity?: number;
  newQuantity?: number;
  reserved?: number;
};

/**
 * Apply a signed delta to on-hand quantity, record an InventoryAdjustment row,
 * and keep the Variant mirror in sync — all in one transaction. Rejects a
 * change that would take quantity below 0 or below the currently reserved
 * amount.
 */
export async function adjustStock(
  params: {
    variantId: string;
    delta: number;
    reason: string;
    note?: string | null;
    actorUserId?: string | null;
  },
  externalTx?: Prisma.TransactionClient,
): Promise<AdjustResult> {
  const { variantId, delta, reason, note = null, actorUserId = null } = params;
  if (!Number.isInteger(delta)) return { ok: false, error: "Adjustment must be a whole number." };

  const run = async (tx: Prisma.TransactionClient): Promise<AdjustResult> => {
    // Lock the row for the duration of the transaction.
    const locked = await tx.$queryRaw<
      { id: string; quantity: number; reserved: number }[]
    >`SELECT "id", "quantity", "reserved" FROM "Inventory" WHERE "variantId" = ${variantId} FOR UPDATE`;
    const inv = locked[0];
    if (!inv) return { ok: false, error: "No inventory record for that variant." };

    const previousQuantity = inv.quantity;
    const newQuantity = previousQuantity + delta;
    if (newQuantity < 0) {
      return { ok: false, error: "Stock can’t go below zero." };
    }
    if (newQuantity < inv.reserved) {
      return {
        ok: false,
        error: `Can’t reduce below the ${inv.reserved} unit(s) currently reserved.`,
      };
    }

    await tx.inventory.update({
      where: { id: inv.id },
      data: { quantity: newQuantity },
    });
    await tx.inventoryAdjustment.create({
      data: {
        inventoryId: inv.id,
        previousQuantity,
        delta,
        newQuantity,
        reason,
        note: note?.trim() || null,
        actorUserId,
      },
    });
    await syncVariantMirror(tx, variantId);

    return { ok: true, previousQuantity, newQuantity, reserved: inv.reserved };
  };

  if (externalTx) return run(externalTx);
  return prisma.$transaction(run);
}

/**
 * Update the low-stock threshold. No history row (it isn't a quantity change).
 * Accepts an `externalTx` (same pattern as `adjustStock`) so the admin action
 * can bundle the Phase 9D-D `OfferInventory.reorderPoint` sync atomically.
 */
export async function setReorderPoint(
  variantId: string,
  reorderPoint: number,
  externalTx?: Prisma.TransactionClient,
): Promise<{ ok: boolean; error?: string; previous?: number }> {
  if (!Number.isInteger(reorderPoint) || reorderPoint < 0) {
    return { ok: false, error: "Reorder point must be a whole number ≥ 0." };
  }
  const run = async (
    tx: Prisma.TransactionClient | typeof prisma,
  ): Promise<{ ok: boolean; error?: string; previous?: number }> => {
    const inv = await tx.inventory.findUnique({
      where: { variantId },
      select: { id: true, reorderPoint: true },
    });
    if (!inv) return { ok: false, error: "No inventory record for that variant." };
    await tx.inventory.update({ where: { id: inv.id }, data: { reorderPoint } });
    return { ok: true, previous: inv.reorderPoint };
  };
  if (externalTx) return run(externalTx);
  return run(prisma);
}

// ---------------------------------------------------------------------------
// Reservation foundation — NOT wired to checkout/orders in this step.
// ---------------------------------------------------------------------------

/**
 * Atomically move `quantity` units from available into `reserved`.
 * Returns false if there isn't enough available. Concurrency-safe: two
 * simultaneous callers cannot both reserve the last unit.
 */
export async function reserveStock(
  variantId: string,
  quantity: number,
  externalTx?: Prisma.TransactionClient,
): Promise<boolean> {
  if (quantity <= 0) return true;
  const run = async (tx: Prisma.TransactionClient) => {
    const affected = await tx.$executeRaw`
      UPDATE "Inventory"
      SET "reserved" = "reserved" + ${quantity}, "updatedAt" = now()
      WHERE "variantId" = ${variantId} AND "quantity" - "reserved" >= ${quantity}`;
    if (affected === 0) return false;
    await syncVariantMirror(tx, variantId);
    return true;
  };
  if (externalTx) return run(externalTx);
  return prisma.$transaction(run);
}

/** Atomically return up to `quantity` reserved units to available. */
export async function releaseStock(
  variantId: string,
  quantity: number,
  externalTx?: Prisma.TransactionClient,
): Promise<void> {
  if (quantity <= 0) return;
  const run = async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`
      UPDATE "Inventory"
      SET "reserved" = GREATEST(0, "reserved" - ${quantity}), "updatedAt" = now()
      WHERE "variantId" = ${variantId}`;
    await syncVariantMirror(tx, variantId);
  };
  if (externalTx) return run(externalTx);
  await prisma.$transaction(run);
}

/**
 * Atomically finalise a sale: remove `quantity` from BOTH quantity and reserved
 * (previously reserved units leave the warehouse). Returns false if quantity is
 * insufficient. Concurrency-safe.
 */
export async function commitStock(
  variantId: string,
  quantity: number,
  externalTx?: Prisma.TransactionClient,
): Promise<boolean> {
  if (quantity <= 0) return true;
  const run = async (tx: Prisma.TransactionClient) => {
    const affected = await tx.$executeRaw`
      UPDATE "Inventory"
      SET "quantity" = "quantity" - ${quantity},
          "reserved" = GREATEST(0, "reserved" - ${quantity}),
          "updatedAt" = now()
      WHERE "variantId" = ${variantId} AND "quantity" >= ${quantity}`;
    if (affected === 0) return false;
    await syncVariantMirror(tx, variantId);
    return true;
  };
  if (externalTx) return run(externalTx);
  return prisma.$transaction(run);
}
