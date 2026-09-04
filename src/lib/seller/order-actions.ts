"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSellerSessionPermission } from "@/lib/seller/session";
import {
  advanceSellerOrderStatus,
  saveSellerShipment,
  type SellerOrderRepoError,
} from "@/lib/marketplace/seller-order-repository";

/**
 * `/seller/orders` server actions (Phase 9F-2).
 *
 * Every action re-establishes the seller session + `manage_seller_fulfillment`
 * server-side; the repository re-checks SellerOrder / Shipment ownership inside
 * its transaction. A seller can only ever move its own SellerOrder and edit a
 * Shipment on its own SellerOrder.
 *
 * These never touch `Order.status`, `OrderEvent`, the customer timeline,
 * inventory, payments, or settlement, and never revalidate the storefront.
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
  const label =
    parsed.data.to === "PROCESSING"
      ? "moved back to preparing"
      : parsed.data.to === "READY_TO_SHIP"
        ? "marked ready to ship"
        : parsed.data.to === "SHIPPED"
          ? "marked shipped"
          : "marked delivered";
  return { ok: true, message: `Order ${label}.` };
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
