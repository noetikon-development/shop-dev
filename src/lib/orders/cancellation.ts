import "server-only";
import type { Prisma } from "@prisma/client";
import { adjustStock } from "@/lib/inventory";
import { restoreOfferStock } from "@/lib/marketplace/offer-inventory";

/**
 * The shared inventory-reversal + SellerOrder-cascade an order cancellation must
 * perform, once the caller has already flipped `Order.status` to CANCELLED with
 * its OWN atomic, status-guarded write (that write is the idempotency gate — this
 * function must only ever be reached when it matched exactly one row, so every
 * reversal below runs at most once per order).
 *
 * It is a faithful lift of the body of `admin/order-actions.ts` `cancelOrderAction`
 * (steps 2–4). The admin action itself is deliberately NOT routed through here in
 * this phase — a large regression surface asserts its exact inline shape — so the
 * two must be kept in step by hand until a later phase converges them. The
 * seller-plane `sellerCancelSellerOrder` (9F-30B) is the single-seller sibling.
 *
 * What it does, exactly mirroring the admin path:
 *   2  reverse EXACTLY what checkout's SALE deducted
 *      2a offer-native (≥1 SALE `OfferAdjustment` "Order <num>") → restore
 *         `OfferInventory` per `OrderItem.offerId` + `OfferAdjustment(CANCELLATION)`;
 *         the legacy `Inventory` mirror is NOT touched (9E-3D-5).
 *      2b legacy (pre-retirement) → restore `Inventory` from the SALE
 *         `InventoryAdjustment` rows via `adjustStock` (the historical fallback).
 *   3  roll `Product.soldCount` back, never below zero.
 *   3b cascade every not-yet-CANCELLED `SellerOrder` on the order → CANCELLED,
 *      zeroing `commissionAmount` in the same guarded write; a SETTLED row also
 *      accrues a `settlementClawbackAmount` increment + `settlementStatus =
 *      CLAWED_BACK` (no money moves). The affected ids + clawback events are
 *      returned so the caller can notify sellers / write clawback audits.
 *   4  one `OrderEvent(CANCELLED)` with the caller-supplied detail.
 *
 * Never touches payments, `Order.paymentStatus`, the returns/refund flow, or
 * `Variant.stock` directly.
 */

export type CancellationClawbackEvent = {
  sellerOrderId: string;
  sellerId: string;
  clawbackDelta: number;
  newOutstandingClawback: number;
};

export type ReverseCancelledOrderResult = {
  restockedUnits: number;
  restockedLines: number;
  reversalPath: "offer-native" | "legacy";
  cancelledSellerOrderIds: string[];
  clawbackEvents: CancellationClawbackEvent[];
};

export async function reverseCancelledOrder(
  tx: Prisma.TransactionClient,
  args: {
    orderId: string;
    orderNumber: string;
    /** `User.id` to stamp on the adjustment rows; null for a system actor. */
    actorUserId: string | null;
    /** Human-readable note for the reversal adjustment rows. */
    adjustmentNote: string;
    /** `OrderEvent.detail` for the CANCELLED timeline entry. */
    eventDetail: string;
  },
): Promise<ReverseCancelledOrderResult> {
  const { orderId, orderNumber, actorUserId } = args;

  let restockedUnits = 0;
  let restockedLines = 0;

  // 2. Reverse EXACTLY what the SALE deducted — symmetric by construction.
  const saleOfferAdjustments = await tx.offerAdjustment.count({
    where: { reason: "SALE", note: `Order ${orderNumber}` },
  });
  const offerNative = saleOfferAdjustments > 0;
  const reversalPath: "offer-native" | "legacy" = offerNative ? "offer-native" : "legacy";

  const soldBackByProduct = new Map<string, number>();

  if (offerNative) {
    // 2a. OfferInventory reversal — the WHOLE reversal, per OrderItem.offerId.
    const items = await tx.orderItem.findMany({
      where: { orderId },
      select: { id: true, offerId: true, quantity: true, productId: true },
    });
    for (const it of items) {
      if (it.quantity <= 0) continue;
      if (it.offerId) {
        const res = await restoreOfferStock(
          {
            offerId: it.offerId,
            units: it.quantity,
            reason: "CANCELLATION",
            note: `${args.adjustmentNote} · item ${it.id}`,
            actorUserId,
          },
          tx,
        );
        if (!res.ok) {
          throw new Error(res.error ?? "Could not restore a line — cancellation aborted.");
        }
      }
      restockedUnits += it.quantity;
      restockedLines += 1;
      soldBackByProduct.set(it.productId, (soldBackByProduct.get(it.productId) ?? 0) + it.quantity);
    }
  } else {
    // 2b. LEGACY fallback — one CANCELLATION per SALE InventoryAdjustment.
    const saleAdjustments = await tx.inventoryAdjustment.findMany({
      where: { reason: "SALE", note: `Order ${orderNumber}` },
      select: {
        delta: true,
        inventory: { select: { variantId: true, variant: { select: { productId: true } } } },
      },
    });
    for (const adj of saleAdjustments) {
      const qty = -adj.delta; // SALE delta is negative → qty is positive
      if (qty <= 0) continue;
      const res = await adjustStock(
        {
          variantId: adj.inventory.variantId,
          delta: qty,
          reason: "CANCELLATION",
          note: args.adjustmentNote,
          actorUserId,
        },
        tx,
      );
      if (!res.ok) {
        throw new Error(res.error ?? "Could not restock a line — cancellation aborted.");
      }
      restockedUnits += qty;
      restockedLines += 1;
      const pid = adj.inventory.variant.productId;
      soldBackByProduct.set(pid, (soldBackByProduct.get(pid) ?? 0) + qty);
    }
  }

  // 3. Undo the soldCount bump checkout made (never below zero).
  for (const [productId, qty] of soldBackByProduct) {
    await tx.$executeRaw`
      UPDATE "Product" SET "soldCount" = GREATEST(0, "soldCount" - ${qty})
      WHERE "id" = ${productId}`;
  }

  // 3b. Marketplace cascade — keep the seller plane in step. Status-guarded so an
  //     already-CANCELLED / historic row is untouched.
  const clawbackEvents: CancellationClawbackEvent[] = [];
  let cancelledSellerOrderIds: string[] = [];
  const toCancel = await tx.sellerOrder.findMany({
    where: { orderId, status: { not: "CANCELLED" } },
    select: {
      id: true,
      total: true,
      commissionAmount: true,
      settlementId: true,
      settlementClawbackAmount: true,
      sellerId: true,
    },
  });
  if (toCancel.length > 0) {
    const unsettledIds = toCancel.filter((s) => s.settlementId === null).map((s) => s.id);
    if (unsettledIds.length > 0) {
      await tx.sellerOrder.updateMany({
        where: { id: { in: unsettledIds } },
        data: { status: "CANCELLED", updatedAt: new Date(), commissionAmount: 0 },
      });
    }
    for (const so of toCancel) {
      if (so.settlementId === null) continue;
      const delta = Math.max(0, so.total - so.commissionAmount);
      await tx.sellerOrder.update({
        where: { id: so.id },
        data: {
          status: "CANCELLED",
          updatedAt: new Date(),
          commissionAmount: 0,
          settlementStatus: "CLAWED_BACK",
          settlementClawbackAmount: { increment: delta },
        },
      });
      if (delta > 0) {
        clawbackEvents.push({
          sellerOrderId: so.id,
          sellerId: so.sellerId,
          clawbackDelta: delta,
          newOutstandingClawback: so.settlementClawbackAmount + delta,
        });
      }
    }
    cancelledSellerOrderIds = toCancel.map((s) => s.id);
  }

  // 4. Timeline event.
  await tx.orderEvent.create({
    data: {
      orderId,
      status: "CANCELLED",
      title: "Order cancelled",
      detail: args.eventDetail,
    },
  });

  return { restockedUnits, restockedLines, reversalPath, cancelledSellerOrderIds, clawbackEvents };
}
