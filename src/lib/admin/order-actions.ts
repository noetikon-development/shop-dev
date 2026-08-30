"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/admin/rbac";
import { writeAudit } from "@/lib/admin/audit";
import { adjustStock } from "@/lib/inventory";
import { ORDER_STATUS_META } from "@/lib/constants";
import {
  canTransition,
  isCancellable,
  isOrderStatus,
  orderStatusLabel,
} from "@/lib/orders/status";

/**
 * Admin order mutations (Step 12).
 *
 * - Status changes and cancellation both require `manage_orders` (existing Step 3
 *   permission — nothing new introduced).
 * - Every transition is validated server-side against `canTransition`; the client
 *   cannot post an arbitrary status, and an admin can NEVER set PAID by hand
 *   (payment confirmation is the deferred payment step).
 * - Cancellation reverses the order's SALE inventory effect through the existing
 *   row-locked `adjustStock` primitive — it never touches `Variant.stock`
 *   directly and never creates a duplicate adjustment (the atomic status gate
 *   makes the whole operation run at most once).
 * - Every action records an `OrderEvent` and an `AdminAuditLog` entry.
 */

export type OrderActionState = { ok: boolean; message?: string; error?: string };

/** Thrown inside the cancel transaction when the atomic status gate matches 0 rows. */
class StaleOrderError extends Error {}

function revalidateOrder(orderNumber: string, orderId: string) {
  revalidatePath("/admin/orders");
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath("/admin");
  revalidatePath("/account/orders");
  revalidatePath(`/account/orders/${orderNumber}`);
  revalidatePath(`/order/${orderNumber}`);
}

// ---------------------------------------------------------------------------
// Status transition
// ---------------------------------------------------------------------------

const EVENT_TITLE: Record<string, string> = {
  PROCESSING: "Preparing your order",
  SHIPPED: "Shipped",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
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

  revalidateOrder(order.orderNumber, orderId);
  return { ok: true, message: `Order marked ${orderStatusLabel(to)}.` };
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

  try {
    await prisma.$transaction(async (tx) => {
      // 1. Atomic cancel — guarded on the cancellable set. 0 rows = someone
      //    else already moved it; abort so we never reverse inventory twice.
      const cancelled = await tx.$executeRaw`
        UPDATE "Order" SET "status" = 'CANCELLED', "updatedAt" = now()
        WHERE "id" = ${orderId}
          AND "status" IN ('PENDING_PAYMENT', 'PENDING', 'PROCESSING')`;
      if (cancelled === 0) throw new StaleOrderError();

      // 2. Reverse exactly what checkout deducted: one CANCELLATION adjustment
      //    per SALE adjustment this order recorded. Pre-Step-9 / seed orders
      //    have no SALE rows, so nothing is restocked for them.
      const saleAdjustments = await tx.inventoryAdjustment.findMany({
        where: { reason: "SALE", note: `Order ${order.orderNumber}` },
        select: {
          delta: true,
          inventory: { select: { variantId: true, variant: { select: { productId: true } } } },
        },
      });

      const soldBackByProduct = new Map<string, number>();

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

      // 3. Undo the soldCount bump checkout made (never below zero).
      for (const [productId, qty] of soldBackByProduct) {
        await tx.$executeRaw`
          UPDATE "Product" SET "soldCount" = GREATEST(0, "soldCount" - ${qty})
          WHERE "id" = ${productId}`;
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
    summary: `${admin.user.email} cancelled order ${order.orderNumber} (was ${orderStatusLabel(order.status)}); restocked ${restockedUnits} unit(s) across ${restockedLines} line(s)`,
    meta: {
      orderNumber: order.orderNumber,
      previousStatus: order.status,
      restockedUnits,
      restockedLines,
      reason: reason || null,
    },
  });

  revalidateOrder(order.orderNumber, orderId);
  revalidateTag("products", "max"); // availability + bestseller changed
  return {
    ok: true,
    message:
      restockedUnits > 0
        ? `Order cancelled. ${restockedUnits} unit(s) returned to stock.`
        : "Order cancelled.",
  };
}
