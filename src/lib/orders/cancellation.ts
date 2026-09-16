import "server-only";
import type { Prisma } from "@prisma/client";
import { adjustStock } from "@/lib/inventory";
import { restoreOfferStock } from "@/lib/marketplace/offer-inventory";
import { sellerCanCancelSellerOrder } from "@/lib/marketplace/seller-order-status";

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
 *
 * Multi-seller safety gate (added once checkout could produce N SellerOrders
 * per Order): a whole-order cancellation is refused OUTRIGHT — nothing is
 * written at all — if any live SellerOrder has progressed past
 * `sellerCanCancelSellerOrder` (i.e. it is READY_TO_SHIP / SHIPPED / DELIVERED).
 * Before this gate, cascading every non-CANCELLED SellerOrder to CANCELLED
 * regardless of its own status could pull an already-shipped-or-delivered
 * SellerOrder backwards, wrongly restoring inventory that had already left and
 * zeroing commission that was legitimately earned. There is no partial
 * cancellation here: either every SellerOrder is still in a state a seller
 * could themselves decline/cancel, and the whole order (and every SellerOrder
 * on it) is cancelled exactly as before, or none of it is touched — the caller
 * must throw `SellerOrderNotCancellableError` before this function performs any
 * write, so its own atomic `Order.status → CANCELLED` gate rolls back with the
 * rest of the transaction.
 */

/**
 * Thrown when the parent Order cannot be safely cancelled as a whole because at
 * least one of its SellerOrders has progressed past the point a seller could
 * still decline it (anything `sellerCanCancelSellerOrder` disallows). The
 * caller's enclosing `$transaction` rolls back entirely on this throw — the
 * atomic `Order.status → CANCELLED` UPDATE that ran just before reaching here
 * is undone along with everything else, so the Order and every SellerOrder are
 * left exactly as they were.
 */
export class SellerOrderNotCancellableError extends Error {
  constructor(public readonly blockedSellerOrderIds: string[]) {
    super("This order can't be cancelled because part of it has already shipped.");
    this.name = "SellerOrderNotCancellableError";
  }
}

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

  // 1b. Multi-seller safety gate — fetched and checked BEFORE any reversal
  //     write, so a blocked cancellation leaves everything untouched. Reused
  //     below (step 3b) so this is the only SellerOrder read this function does.
  const toCancel = await tx.sellerOrder.findMany({
    where: { orderId, status: { not: "CANCELLED" } },
    select: {
      id: true,
      status: true,
      total: true,
      commissionAmount: true,
      settlementId: true,
      settlementClawbackAmount: true,
      sellerId: true,
    },
  });
  const blockedSellerOrders = toCancel.filter((so) => !sellerCanCancelSellerOrder(so.status));
  if (blockedSellerOrders.length > 0) {
    console.error(
      "[cancellation] refusing whole-order cancellation — seller order(s) already past the cancellable window",
      { orderId, orderNumber, blockedSellerOrderIds: blockedSellerOrders.map((so) => so.id) },
    );
    throw new SellerOrderNotCancellableError(blockedSellerOrders.map((so) => so.id));
  }

  // 2. Reverse EXACTLY what the SALE deducted — symmetric by construction.
  const saleOfferAdjustments = await tx.offerAdjustment.count({
    where: { reason: "SALE", note: `Order ${orderNumber}` },
  });
  const offerNative = saleOfferAdjustments > 0;
  const reversalPath: "offer-native" | "legacy" = offerNative ? "offer-native" : "legacy";

  const soldBackByProduct = new Map<string, number>();

  if (offerNative) {
    // 2a. OfferInventory reversal — the WHOLE reversal, per OrderItem.offerId.
    //     Scoped to items whose SellerOrder is in `toCancel` (about to be
    //     cancelled here) or has none at all (a legacy line) — an item whose
    //     SellerOrder was ALREADY independently cancelled (a prior seller
    //     self-decline, 9F-30B multi-seller) must never be reversed again.
    //     `restoreOfferStock` has no idempotency guard of its own; this scope
    //     is what makes that safe now that a SellerOrder can be cancelled
    //     outside this function's own one-shot Order-level gate.
    const items = await tx.orderItem.findMany({
      where: {
        orderId,
        OR: [{ sellerOrderId: { in: toCancel.map((s) => s.id) } }, { sellerOrderId: null }],
      },
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

  // 3b. Marketplace cascade — keep the seller plane in step. `toCancel` was
  //     fetched (and safety-checked) in step 1b above; every row in it is
  //     already confirmed cancellable, so this cascade always applies to all
  //     of them — never a partial subset.
  const clawbackEvents: CancellationClawbackEvent[] = [];
  let cancelledSellerOrderIds: string[] = [];
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
