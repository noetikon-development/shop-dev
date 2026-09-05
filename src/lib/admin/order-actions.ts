"use server";

import { revalidateTag } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/admin/rbac";
import { writeAudit } from "@/lib/admin/audit";
import { adjustStock } from "@/lib/inventory";
import { restoreOfferStock } from "@/lib/marketplace/offer-inventory";
import { revalidateOrderPaths } from "@/lib/admin/order-cache";
import { ORDER_STATUS_META } from "@/lib/constants";
import {
  canTransition,
  isCancellable,
  isFulfillmentStatus,
  isOrderStatus,
  orderStatusLabel,
} from "@/lib/orders/status";
import { scheduleEmail } from "@/lib/email/schedule";
import { sendOrderCancelled, sendOrderProcessing, sendSellerOrderCancelled } from "@/lib/email/notifications";

/**
 * Admin order mutations (Step 12; fulfilment milestones moved to
 * src/lib/admin/fulfillment-actions.ts in Step 13).
 *
 * - Status changes and cancellation both require `manage_orders` (existing Step 3
 *   permission — nothing new introduced).
 * - `updateOrderStatusAction` only drives the pre-fulfilment transition
 *   (… → PROCESSING). SHIPPED / OUT_FOR_DELIVERY / DELIVERED go through the
 *   Step 13 fulfilment actions so courier / tracking / timestamps are captured.
 * - Every transition is validated server-side against `canTransition`; the client
 *   cannot post an arbitrary status, and an admin can NEVER set PAID by hand.
 * - Cancellation reverses the order's SALE inventory effect. An offer-native
 *   order (detected by the presence of a SALE `OfferAdjustment`) restores
 *   `OfferInventory` per `OrderItem.offerId` and creates an
 *   `OfferAdjustment(CANCELLATION)` — that is the WHOLE reversal since Phase
 *   9E-3D-5; the legacy `Inventory` mirror is not touched. A legacy
 *   (pre-retirement) order restores `Inventory` from its SALE
 *   `InventoryAdjustment` rows, exactly as before (the historical fallback,
 *   retained). It never touches `Variant.stock` directly and never restocks
 *   twice — the atomic `Order.status` gate makes the whole reversal run at
 *   most once.
 * - Every action records an `OrderEvent` and an `AdminAuditLog` entry.
 */

export type OrderActionState = { ok: boolean; message?: string; error?: string };

/** Thrown inside the cancel transaction when the atomic status gate matches 0 rows. */
class StaleOrderError extends Error {}

// ---------------------------------------------------------------------------
// Status transition
// ---------------------------------------------------------------------------

const EVENT_TITLE: Record<string, string> = {
  PROCESSING: "Preparing your order",
};

const statusSchema = z.object({
  orderId: z.string().min(1).max(64),
  to: z.string().min(1).max(32),
  note: z.string().trim().max(300).optional(),
});

export async function updateOrderStatusAction(input: unknown): Promise<OrderActionState> {
  const admin = await requirePermission("manage_orders");

  const parsed = statusSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  const { orderId, to, note } = parsed.data;

  if (!isOrderStatus(to)) return { ok: false, error: "Unknown order status." };
  if (to === "CANCELLED") {
    return { ok: false, error: "Use “Cancel order” — it also reverses inventory." };
  }
  if (isFulfillmentStatus(to)) {
    return { ok: false, error: "Use the fulfilment actions to ship or deliver an order." };
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, orderNumber: true, status: true },
  });
  if (!order) return { ok: false, error: "Order not found." };

  if (order.status === to) {
    return { ok: false, error: `This order is already ${orderStatusLabel(to)}.` };
  }
  if (!canTransition(order.status, to)) {
    return {
      ok: false,
      error: `Can’t move an order from ${orderStatusLabel(order.status)} to ${orderStatusLabel(to)}.`,
    };
  }

  // Atomic, guarded on the status we validated against — a concurrent change
  // makes this a no-op and we bail rather than double-applying.
  const updated = await prisma.$executeRaw`
    UPDATE "Order" SET "status" = ${to}, "updatedAt" = now()
    WHERE "id" = ${orderId} AND "status" = ${order.status}`;
  if (updated === 0) {
    return { ok: false, error: "The order status changed — refresh and try again." };
  }

  await prisma.orderEvent.create({
    data: {
      orderId,
      status: to,
      title: EVENT_TITLE[to] ?? orderStatusLabel(to),
      detail: note || ORDER_STATUS_META[to]?.description || null,
    },
  });

  await writeAudit({
    actorUserId: admin.user.id,
    action: "order.status_changed",
    targetType: "order",
    targetId: orderId,
    summary: `${admin.user.email} moved order ${order.orderNumber}: ${orderStatusLabel(order.status)} → ${orderStatusLabel(to)}`,
    meta: { orderNumber: order.orderNumber, from: order.status, to, note: note || null },
  });

  revalidateOrderPaths(order.orderNumber, orderId);

  // Step 21 P1 — "preparing your order" notification. After the response;
  // ORDER_PROCESSING:<orderId> dedupes if the transition is somehow re-run.
  // PROCESSING is the only forward status this action performs, but the guard
  // keeps the trigger explicit and future-proof.
  if (to === "PROCESSING") {
    scheduleEmail(() => sendOrderProcessing(orderId));
  }

  return { ok: true, message: `Order marked ${orderStatusLabel(to)}.` };
}

// ---------------------------------------------------------------------------
// Confirm order — pay-on-delivery (Phase 7B)
//
// Moves an order from PENDING_PAYMENT → PROCESSING when it carries NO online
// payment. This is the missing step for cash / pay-on-delivery orders: without
// it a genuine COD order dead-ends at PENDING_PAYMENT and never reaches the
// fulfilment emails. It does NOT change paymentStatus / paymentMethod and never
// implies a payment occurred — an order with an online Payment row is confirmed
// only by the verified PayMongo webhook.
// ---------------------------------------------------------------------------

const confirmSchema = z.object({
  orderId: z.string().min(1).max(64),
  note: z.string().trim().max(300).optional(),
});

export async function confirmOrderAction(input: unknown): Promise<OrderActionState> {
  const admin = await requirePermission("manage_orders");

  const parsed = confirmSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  const { orderId, note } = parsed.data;

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      paymentMethod: true,
      payments: {
        where: { status: { in: ["PENDING", "AWAITING_PAYMENT", "PAID", "PARTIALLY_REFUNDED", "REFUNDED"] } },
        select: { id: true },
        take: 1,
      },
    },
  });
  if (!order) return { ok: false, error: "Order not found." };

  if (order.status !== "PENDING_PAYMENT") {
    return {
      ok: false,
      error: `Only an unconfirmed order can be confirmed — this one is ${orderStatusLabel(order.status)}.`,
    };
  }
  if (order.payments.length > 0) {
    return {
      ok: false,
      error: "This order has an online payment — it is confirmed automatically when the payment clears, not here.",
    };
  }
  if (!canTransition(order.status, "PROCESSING", { codConfirm: true })) {
    return { ok: false, error: "This order can’t be confirmed." };
  }

  // Atomic, guarded on the status we validated against.
  const updated = await prisma.$executeRaw`
    UPDATE "Order" SET "status" = 'PROCESSING', "updatedAt" = now()
    WHERE "id" = ${orderId} AND "status" = 'PENDING_PAYMENT'`;
  if (updated === 0) {
    return { ok: false, error: "The order status changed — refresh and try again." };
  }

  await prisma.orderEvent.create({
    data: {
      orderId,
      status: "PROCESSING",
      title: EVENT_TITLE.PROCESSING,
      detail: note || ORDER_STATUS_META.PROCESSING?.description || null,
    },
  });

  await writeAudit({
    actorUserId: admin.user.id,
    action: "order.confirmed",
    targetType: "order",
    targetId: orderId,
    summary: `${admin.user.email} confirmed order ${order.orderNumber} (pay on delivery): PENDING_PAYMENT → PROCESSING`,
    meta: {
      orderNumber: order.orderNumber,
      from: "PENDING_PAYMENT",
      to: "PROCESSING",
      paymentMethod: order.paymentMethod,
      note: note || null,
    },
  });

  revalidateOrderPaths(order.orderNumber, orderId);

  // Existing "preparing your order" notification — after the response;
  // ORDER_PROCESSING:<orderId> dedupes if this is somehow re-run.
  scheduleEmail(() => sendOrderProcessing(orderId));

  return { ok: true, message: "Order confirmed — now preparing." };
}

// ---------------------------------------------------------------------------
// Cancellation (+ inventory reversal)
// ---------------------------------------------------------------------------

const cancelSchema = z.object({
  orderId: z.string().min(1).max(64),
  reason: z.string().trim().max(300).optional(),
});

export async function cancelOrderAction(input: unknown): Promise<OrderActionState> {
  const admin = await requirePermission("manage_orders");

  const parsed = cancelSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  const { orderId, reason } = parsed.data;

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, orderNumber: true, status: true },
  });
  if (!order) return { ok: false, error: "Order not found." };
  if (order.status === "CANCELLED") {
    return { ok: false, error: "This order is already cancelled." };
  }
  if (!isCancellable(order.status)) {
    return {
      ok: false,
      error: `An order that is ${orderStatusLabel(order.status)} can’t be cancelled here.`,
    };
  }

  let restockedUnits = 0;
  let restockedLines = 0;
  let reversalPath: "offer-native" | "legacy" = "legacy";
  let cancelledSellerOrderIds: string[] = [];

  try {
    await prisma.$transaction(async (tx) => {
      // 1. Atomic cancel — guarded on the cancellable set. 0 rows = someone
      //    else already moved it; abort so we never reverse inventory twice.
      //    THIS is the idempotency mechanism for the whole reversal below.
      const cancelled = await tx.$executeRaw`
        UPDATE "Order" SET "status" = 'CANCELLED', "updatedAt" = now()
        WHERE "id" = ${orderId}
          AND "status" IN ('PENDING_PAYMENT', 'PENDING', 'PROCESSING')`;
      if (cancelled === 0) throw new StaleOrderError();

      // 2. Reverse EXACTLY what the SALE deducted — symmetric by construction.
      //
      //    An order is "offer-native" when it recorded at least one SALE
      //    `OfferAdjustment` (`note = "Order <num>"`). Since Phase 9E-3D-5 an
      //    offer-native order records ONLY `OfferAdjustment` for its stock
      //    movements — no `InventoryAdjustment`, no `Inventory` write. A legacy
      //    (pre-retirement) order recorded only `InventoryAdjustment` SALE rows.
      //
      //    Offer-native  -> restore OfferInventory per `OrderItem.offerId` (the
      //                     authoritative marketplace mapping, 9E-3D-1 §3). The
      //                     `Inventory` mirror is NOT touched (9E-3D-5 §4/§12).
      //    Legacy        -> restore Inventory from the SALE `InventoryAdjustment`
      //                     rows, unchanged (9E-3D-5 §5 — the historical fallback).
      const saleOfferAdjustments = await tx.offerAdjustment.count({
        where: { reason: "SALE", note: `Order ${order.orderNumber}` },
      });
      const offerNative = saleOfferAdjustments > 0;
      reversalPath = offerNative ? "offer-native" : "legacy";

      const soldBackByProduct = new Map<string, number>();

      if (offerNative) {
        // 2a. OfferInventory reversal — the WHOLE reversal, per OrderItem.offerId.
        //     No Inventory row is read or locked (§12/§13).
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
                note: `Order ${order.orderNumber} cancelled · item ${it.id}`,
                actorUserId: admin.user.id,
              },
              tx,
            );
            if (!res.ok) {
              throw new Error(res.error ?? "Could not restore a line — cancellation aborted.");
            }
          }
          // Restock tallies + soldCount roll-back come straight from the
          // OrderItems (the SALE OfferAdjustment recorded the same quantity).
          restockedUnits += it.quantity;
          restockedLines += 1;
          soldBackByProduct.set(
            it.productId,
            (soldBackByProduct.get(it.productId) ?? 0) + it.quantity,
          );
        }
      } else {
        // 2b. LEGACY fallback — one CANCELLATION per SALE InventoryAdjustment
        //     this order recorded. Retained for a re-opened pre-retirement order
        //     (§5 — do NOT delete this branch).
        const saleAdjustments = await tx.inventoryAdjustment.findMany({
          where: { reason: "SALE", note: `Order ${order.orderNumber}` },
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
              note: `Order ${order.orderNumber} cancelled`,
              actorUserId: admin.user.id,
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

      // 3b. Marketplace (9F-3): keep the seller plane in step — a cancelled
      //     parent order's SellerOrder(s) become CANCELLED so the seller sees
      //     the true state. Status-guarded so an already-CANCELLED / historic
      //     row is untouched. Does NOT alter Order.status semantics, events,
      //     audit or the CUSTOMER email — those are handled above / below
      //     unchanged. (9F-7b: capture exactly which rows this flip touches so
      //     the affected seller(s) can be notified after commit — never a
      //     blind "notify every SellerOrder on this order", which would also
      //     fire for ones already CANCELLED earlier.)
      const toCancel = await tx.sellerOrder.findMany({
        where: { orderId, status: { not: "CANCELLED" } },
        select: { id: true },
      });
      if (toCancel.length > 0) {
        await tx.sellerOrder.updateMany({
          where: { id: { in: toCancel.map((s) => s.id) } },
          // 9F-8c: the sale this commission was earned on no longer exists —
          // zero it in the same guarded write, so a repeat cancel attempt
          // (which matches 0 rows above) can never re-zero or double-adjust.
          data: { status: "CANCELLED", updatedAt: new Date(), commissionAmount: 0 },
        });
        cancelledSellerOrderIds = toCancel.map((s) => s.id);
      }

      // 4. Timeline event.
      await tx.orderEvent.create({
        data: {
          orderId,
          status: "CANCELLED",
          title: "Order cancelled",
          detail: reason || "Cancelled by an administrator.",
        },
      });
    });
  } catch (err) {
    if (err instanceof StaleOrderError) {
      return { ok: false, error: "The order was already updated — refresh and try again." };
    }
    if (err instanceof Error) return { ok: false, error: err.message };
    throw err;
  }

  await writeAudit({
    actorUserId: admin.user.id,
    action: "order.cancelled",
    targetType: "order",
    targetId: orderId,
    summary: `${admin.user.email} cancelled order ${order.orderNumber} (was ${orderStatusLabel(order.status)}); restocked ${restockedUnits} unit(s) across ${restockedLines} line(s) [${reversalPath}]`,
    meta: {
      orderNumber: order.orderNumber,
      previousStatus: order.status,
      restockedUnits,
      restockedLines,
      reversalPath,
      reason: reason || null,
    },
  });

  revalidateOrderPaths(order.orderNumber, orderId);
  revalidateTag("products", "max"); // availability + bestseller changed

  // Cancellation notification — after the response; ORDER_CANCELLED:<orderId>
  // dedupes. It does NOT claim a refund (PayMongo / refunds are deferred).
  scheduleEmail(() => sendOrderCancelled(orderId, reason ?? null));

  // Marketplace (9F-7b) — notify each seller whose SellerOrder this
  // cancellation just cascaded to CANCELLED. One email per affected row,
  // keyed on that row's own id (SELLER_ORDER_CANCELLED:<sellerOrderId>) —
  // never Seller.updatedAt.
  for (const sellerOrderId of cancelledSellerOrderIds) {
    scheduleEmail(() => sendSellerOrderCancelled(sellerOrderId));
  }

  return {
    ok: true,
    message:
      restockedUnits > 0
        ? `Order cancelled. ${restockedUnits} unit(s) returned to stock.`
        : "Order cancelled.",
  };
}
