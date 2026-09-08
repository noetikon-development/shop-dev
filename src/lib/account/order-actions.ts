"use server";

import { revalidateTag } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { writeAudit } from "@/lib/admin/audit";
import { cleanUserText } from "@/lib/ugc";
import { hitRateLimit } from "@/lib/rate-limit";
import { revalidateOrderPaths } from "@/lib/admin/order-cache";
import { scheduleEmail } from "@/lib/email/schedule";
import { sendOrderCancelled, sendSellerOrderCancelled } from "@/lib/email/notifications";
import { isCancellable, orderStatusLabel } from "@/lib/orders/status";
import { reverseCancelledOrder } from "@/lib/orders/cancellation";

/**
 * Customer self-service order cancellation (Phase 9F-30D).
 *
 * Security model (same posture as `returns-actions.ts`):
 *  - the authenticated user is resolved server-side (`getCurrentUser`); the
 *    client never sends a userId.
 *  - the order is looked up by `orderNumber` AND `userId` — a customer can only
 *    ever cancel their OWN order. An order number alone proves nothing.
 *  - the status is re-checked against `isCancellable` (PENDING_PAYMENT / PENDING
 *    / PROCESSING). Once anything has shipped, or the order is terminal, the
 *    action refuses.
 *
 * The reversal reuses the exact architecture the admin `cancelOrderAction` runs
 * (`reverseCancelledOrder`): one transaction, an atomic status-guarded
 * `UPDATE "Order" … WHERE status IN (cancellable)` as the idempotency gate, then
 * OfferInventory / Inventory restore + `OfferAdjustment(CANCELLATION)` +
 * `Product.soldCount` rollback + SellerOrder cascade (commission zeroed,
 * clawback where already settled) + one `OrderEvent`. Post-commit it audits the
 * cancellation, emails the customer (`ORDER_CANCELLED:<orderId>` — one send), and
 * emails every 3P seller whose SellerOrder this cascaded
 * (`SELLER_ORDER_CANCELLED:<sellerOrderId>` — one per seller). Payment status /
 * method are never touched (COD stays PENDING; an online-paid order is not
 * cancellable — PAID is not in `CANCELLABLE_STATUSES`).
 */

export type CustomerCancelState = { ok?: boolean; error?: string; message?: string };

/** Thrown inside the transaction when the atomic status gate matches 0 rows. */
class StaleOrderError extends Error {}

const cancelSchema = z.object({
  orderNumber: z.string().trim().min(1).max(40),
  reason: z.string().trim().max(300).optional().or(z.literal("")),
});

const RATE = { limit: 10, windowMs: 60 * 60 * 1000 }; // 10 cancellations / hour / user

export async function customerCancelOrderAction(input: unknown): Promise<CustomerCancelState> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Please sign in to manage your order." };

  const parsed = cancelSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  const orderNumber = parsed.data.orderNumber;
  const reason = cleanUserText(parsed.data.reason ?? "").slice(0, 300).trim() || null;

  const rl = await hitRateLimit(`cancel:user:${user.id}`, RATE);
  if (!rl.ok) {
    return { ok: false, error: "You've made several changes recently. Please try again in a little while." };
  }

  // Ownership — by (orderNumber, userId). A guest order (userId null) is never
  // matched here, so it can't be cancelled through the account flow.
  const order = await prisma.order.findFirst({
    where: { orderNumber, userId: user.id },
    select: { id: true, orderNumber: true, status: true },
  });
  if (!order) return { ok: false, error: "That order wasn't found." };
  if (order.status === "CANCELLED") return { ok: false, error: "This order is already cancelled." };
  if (!isCancellable(order.status)) {
    return {
      ok: false,
      error: `An order that is ${orderStatusLabel(order.status)} can no longer be cancelled. Contact us if you need help.`,
    };
  }

  const previousStatus = order.status;
  let result: Awaited<ReturnType<typeof reverseCancelledOrder>>;
  try {
    result = await prisma.$transaction(async (tx) => {
      // Atomic idempotency gate — 0 rows ⇒ someone/something already moved it.
      const cancelled = await tx.$executeRaw`
        UPDATE "Order" SET "status" = 'CANCELLED', "updatedAt" = now()
        WHERE "id" = ${order.id}
          AND "status" IN ('PENDING_PAYMENT', 'PENDING', 'PROCESSING')`;
      if (cancelled === 0) throw new StaleOrderError();

      return reverseCancelledOrder(tx, {
        orderId: order.id,
        orderNumber: order.orderNumber,
        actorUserId: user.id,
        adjustmentNote: `Order ${order.orderNumber} cancelled by the customer`,
        eventDetail: reason
          ? `Cancelled by the customer. Reason: ${reason}`
          : "Cancelled by the customer.",
      });
    });
  } catch (err) {
    if (err instanceof StaleOrderError) {
      return { ok: false, error: "The order was just updated — refresh and try again." };
    }
    if (err instanceof Error) {
      console.error("[account/order-actions] customerCancelOrderAction failed", err);
      return { ok: false, error: "Something went wrong cancelling your order. Please try again." };
    }
    throw err;
  }

  await writeAudit({
    actorUserId: user.id,
    action: "order.cancelled",
    targetType: "order",
    targetId: order.id,
    summary:
      `Customer cancelled order ${order.orderNumber} (was ${orderStatusLabel(previousStatus)}); ` +
      `restocked ${result.restockedUnits} unit(s) across ${result.restockedLines} line(s) [${result.reversalPath}]`,
    meta: {
      trigger: "customer_self_service",
      orderNumber: order.orderNumber,
      previousStatus,
      restockedUnits: result.restockedUnits,
      restockedLines: result.restockedLines,
      reversalPath: result.reversalPath,
      reason,
    },
  });

  for (const ev of result.clawbackEvents) {
    await writeAudit({
      actorUserId: user.id,
      action: "seller.settlement.clawback_accrued",
      targetType: "seller_order",
      targetId: ev.sellerOrderId,
      summary:
        `customer cancellation of order ${order.orderNumber} clawed back ` +
        `${ev.clawbackDelta} centavos from seller ${ev.sellerId}`,
      meta: {
        sellerOrderId: ev.sellerOrderId,
        orderId: order.id,
        sellerId: ev.sellerId,
        returnId: null,
        cancellationReference: order.orderNumber,
        clawbackDelta: ev.clawbackDelta,
        newOutstandingClawback: ev.newOutstandingClawback,
      },
    });
  }

  revalidateOrderPaths(order.orderNumber, order.id);
  revalidateTag("products", "max"); // availability + bestseller changed

  // Customer cancellation email — same one the admin path sends, keyed
  // ORDER_CANCELLED:<orderId> so it can never double-send. Never claims a refund.
  scheduleEmail(() => sendOrderCancelled(order.id, reason));

  // 3P sellers whose SellerOrder this cascaded to CANCELLED — one email each,
  // keyed on that row's own id. The customer cancelled, so the seller IS told
  // (unlike the 9F-30B seller-initiated path, where the seller acted themselves).
  for (const sellerOrderId of result.cancelledSellerOrderIds) {
    scheduleEmail(() => sendSellerOrderCancelled(sellerOrderId));
  }

  return {
    ok: true,
    message:
      result.restockedUnits > 0
        ? `Order cancelled. ${result.restockedUnits} item(s) have been released.`
        : "Order cancelled.",
  };
}
