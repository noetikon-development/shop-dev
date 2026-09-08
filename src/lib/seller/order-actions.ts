"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import { requireSellerSessionPermission } from "@/lib/seller/session";
import { writeAudit } from "@/lib/admin/audit";
import {
  advanceSellerOrderStatus,
  saveSellerShipment,
  sellerCancelSellerOrder,
  type SellerOrderRepoError,
} from "@/lib/marketplace/seller-order-repository";
import { revalidateOrderPaths } from "@/lib/admin/order-cache";
import { scheduleEmail } from "@/lib/email/schedule";
import {
  sendOrderShipped,
  sendOrderDelivered,
  sendOrderCancelled,
  sendSellerOrderCancelledOps,
} from "@/lib/email/notifications";
import { sellerAdvanceLabels, sellerCancelLabels } from "@/lib/marketplace/seller-order-status";

/**
 * `/seller/orders` server actions (Phase 9F-2).
 *
 * Every action re-establishes the seller session + `manage_seller_fulfillment`
 * server-side; the repository re-checks SellerOrder / Shipment ownership inside
 * its transaction. A seller can only ever move its own SellerOrder and edit a
 * Shipment on its own SellerOrder.
 *
 * These never touch inventory, payments, or settlement. Phase 9F-12b: when a
 * seller status change rolls the customer-facing parent Order forward (every
 * SellerOrder on it reached the same milestone), this layer revalidates the
 * storefront order pages and fires the existing customer notification — the
 * `Order` / `OrderEvent` / audit writes themselves happen atomically inside the
 * repository transaction.
 */

export type SellerOrderActionState = {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
  message?: string;
};

function fromRepoError(e: SellerOrderRepoError): SellerOrderActionState {
  return { error: e.error };
}

function revalidate(id: string) {
  revalidatePath(`/seller/orders/${id}`);
  revalidatePath("/seller/orders");
  revalidatePath("/seller");
}

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

const advanceSchema = z.object({
  sellerOrderId: z.string().min(1),
  to: z.enum(["PROCESSING", "READY_TO_SHIP", "SHIPPED", "DELIVERED"]),
});

export async function advanceSellerOrderAction(
  _prev: SellerOrderActionState,
  formData: FormData,
): Promise<SellerOrderActionState> {
  const { ctx } = await requireSellerSessionPermission("manage_seller_fulfillment");
  const parsed = advanceSchema.safeParse({
    sellerOrderId: formData.get("sellerOrderId"),
    to: formData.get("to"),
  });
  if (!parsed.success) return { error: "Invalid request." };

  const res = await advanceSellerOrderStatus(ctx, parsed.data.sellerOrderId, parsed.data.to);
  if (!res.ok) return fromRepoError(res);

  revalidate(parsed.data.sellerOrderId);

  // 9F-12b: the repository rolled the parent customer Order forward because every
  // SellerOrder on it reached this milestone. Refresh the customer-facing pages
  // and send the existing customer notification (idempotency-keyed, so a repeated
  // seller transition can never send it twice). COD payment status is untouched.
  if (res.parentOrder) {
    revalidateOrderPaths(res.parentOrder.orderNumber, res.parentOrder.id);
    const { id, rolledTo } = res.parentOrder;
    scheduleEmail(() => (rolledTo === "SHIPPED" ? sendOrderShipped(id) : sendOrderDelivered(id)));
  }

  // 9F-14: "accepted" when this was PENDING_PAYMENT → PROCESSING, not the
  // ambiguous "moved back to preparing".
  const { done } = sellerAdvanceLabels(res.from, parsed.data.to);
  return { ok: true, message: `Order ${done}.` };
}

// ---------------------------------------------------------------------------
// Cancel / decline — 9F-30B
//
// The owning seller cancels an order they can't fulfil. This IS a cancellation
// (not a fulfilment move): it goes through `sellerCancelSellerOrder`, which
// reuses the admin `cancelOrderAction` reversal architecture — parent Order →
// CANCELLED, OfferInventory restored, soldCount rolled back, commission zeroed,
// one OrderEvent, all inside one transaction. This layer then (post-commit)
// audits it, tells the CUSTOMER, and raises an Ops signal. The seller is NOT
// emailed about their own cancellation (they just did it).
// ---------------------------------------------------------------------------

const cancelSchema = z.object({
  sellerOrderId: z.string().min(1),
  reason: z.string().trim().min(1, "Add a reason.").max(300),
});

export async function sellerCancelOrderAction(
  _prev: SellerOrderActionState,
  formData: FormData,
): Promise<SellerOrderActionState> {
  const { ctx } = await requireSellerSessionPermission("manage_seller_fulfillment");
  const parsed = cancelSchema.safeParse({
    sellerOrderId: formData.get("sellerOrderId"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Add a reason for the cancellation." };
  }

  const res = await sellerCancelSellerOrder(ctx, parsed.data.sellerOrderId, parsed.data.reason);
  if (!res.ok) return fromRepoError(res);

  const verb = res.from === "PENDING_PAYMENT" ? "declined" : "cancelled";

  // Audit — the Ops signal. Actor = the seller user; trigger names which path.
  const auditId = await writeAudit({
    actorUserId: ctx.userId,
    action: "seller_order.cancelled",
    targetType: "order",
    targetId: res.orderId,
    summary:
      `Seller ${ctx.sellerName} ${verb} order ${res.orderNumber} ` +
      `(was ${res.previousParentStatus}); restocked ${res.restockedUnits} unit(s) across ${res.restockedLines} line(s)`,
    meta: {
      trigger: res.from === "PENDING_PAYMENT" ? "seller_decline" : "seller_cancel",
      sellerId: ctx.sellerId,
      sellerOrderId: parsed.data.sellerOrderId,
      orderNumber: res.orderNumber,
      from: res.from,
      previousParentStatus: res.previousParentStatus,
      restockedUnits: res.restockedUnits,
      restockedLines: res.restockedLines,
      reason: parsed.data.reason,
    },
  });

  // 9F-20-style dedicated audit for any actual post-settlement clawback (can't
  // happen from PENDING_PAYMENT/PROCESSING, kept symmetric with the admin path).
  for (const cb of res.clawbackEvents) {
    await writeAudit({
      actorUserId: ctx.userId,
      action: "seller.settlement.clawback_accrued",
      targetType: "seller_order",
      targetId: cb.sellerOrderId,
      summary:
        `seller cancellation of order ${res.orderNumber} clawed back ` +
        `${cb.clawbackDelta} centavos from seller ${cb.sellerId}`,
      meta: {
        sellerOrderId: cb.sellerOrderId,
        orderId: res.orderId,
        sellerId: cb.sellerId,
        returnId: null,
        cancellationReference: res.orderNumber,
        clawbackDelta: cb.clawbackDelta,
        newOutstandingClawback: cb.newOutstandingClawback,
      },
    });
  }

  // Customer notification — the SAME email the admin cancellation sends. It never
  // claims a refund (COD / PayMongo dormant). Key ORDER_CANCELLED:<orderId> → one
  // send per order (a later admin cancel can't duplicate it).
  scheduleEmail(() => sendOrderCancelled(res.orderId, parsed.data.reason));
  // Axiaro Operations — a seller just cancelled a customer's order. Ops-only,
  // audit-row-anchored key, no customer PII. The seller does NOT get an email.
  if (auditId) {
    scheduleEmail(() => sendSellerOrderCancelledOps(parsed.data.sellerOrderId, auditId));
  }

  revalidate(parsed.data.sellerOrderId);
  revalidateOrderPaths(res.orderNumber, res.orderId);
  revalidateTag("products", "max"); // availability + bestseller changed

  const { done } = sellerCancelLabels(res.from);
  return { ok: true, message: `Order ${done}. ${res.restockedUnits} unit(s) returned to your stock.` };
}

// ---------------------------------------------------------------------------
// Shipment create / update
// ---------------------------------------------------------------------------

const shipmentSchema = z.object({
  sellerOrderId: z.string().min(1),
  shipmentId: z.string().optional().or(z.literal("")),
  carrier: z.string().trim().min(1, "Choose a carrier").max(24),
  carrierName: z.string().trim().max(60).optional().or(z.literal("")),
  trackingNumber: z.string().trim().max(40).optional().or(z.literal("")),
  trackingUrl: z.string().trim().max(500).optional().or(z.literal("")),
  note: z.string().trim().max(300).optional().or(z.literal("")),
});

export async function saveShipmentAction(
  _prev: SellerOrderActionState,
  formData: FormData,
): Promise<SellerOrderActionState> {
  const { ctx } = await requireSellerSessionPermission("manage_seller_fulfillment");
  const parsed = shipmentSchema.safeParse({
    sellerOrderId: formData.get("sellerOrderId"),
    shipmentId: formData.get("shipmentId") ?? "",
    carrier: formData.get("carrier"),
    carrierName: formData.get("carrierName") ?? "",
    trackingNumber: formData.get("trackingNumber") ?? "",
    trackingUrl: formData.get("trackingUrl") ?? "",
    note: formData.get("note") ?? "",
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const i of parsed.error.issues) fieldErrors[String(i.path[0])] = i.message;
    return { fieldErrors };
  }
  const d = parsed.data;

  const res = await saveSellerShipment(
    ctx,
    d.sellerOrderId,
    {
      carrier: d.carrier,
      carrierName: d.carrierName || null,
      trackingNumber: d.trackingNumber || null,
      trackingUrl: d.trackingUrl || null,
      note: d.note || null,
    },
    d.shipmentId || undefined,
  );
  if (!res.ok) return fromRepoError(res);

  revalidate(d.sellerOrderId);
  return { ok: true, message: d.shipmentId ? "Shipment updated." : "Shipment saved." };
}
