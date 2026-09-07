"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSellerSessionPermission } from "@/lib/seller/session";
import {
  advanceSellerOrderStatus,
  saveSellerShipment,
  type SellerOrderRepoError,
} from "@/lib/marketplace/seller-order-repository";
import { revalidateOrderPaths } from "@/lib/admin/order-cache";
import { scheduleEmail } from "@/lib/email/schedule";
import { sendOrderShipped, sendOrderDelivered } from "@/lib/email/notifications";
import { sellerAdvanceLabels } from "@/lib/marketplace/seller-order-status";

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
