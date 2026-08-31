"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/admin/rbac";
import { writeAudit } from "@/lib/admin/audit";
import { revalidateOrderPaths } from "@/lib/admin/order-cache";
import { canTransition, orderStatusLabel } from "@/lib/orders/status";
import {
  buildTrackingUrl,
  courierLabel,
  getCourier,
  isCourierCode,
  isSafeTrackingUrl,
  isStorePickupCode,
} from "@/lib/orders/couriers";
import { scheduleEmail } from "@/lib/email/schedule";
import { sendOrderShipped, sendOutForDelivery, sendOrderDelivered } from "@/lib/email/notifications";

/**
 * Fulfilment / courier / tracking actions (Step 13).
 *
 * - Every mutation requires `manage_orders` (existing Step 3 permission — no new
 *   fulfilment permission).
 * - The "fulfilment status" is `Order.status` — there is no second status enum.
 *   SHIPPED / OUT_FOR_DELIVERY / DELIVERED are reached ONLY through these
 *   actions, which capture courier / tracking / timestamps.
 * - Every transition re-reads the real order status and does an atomic,
 *   status-guarded `updateMany` (0 rows ⇒ someone else moved it ⇒ abort). The
 *   client can never supply the current status, skip a state, go backwards, or
 *   ship a PENDING_PAYMENT order.
 * - `shippedAt` / `deliveredAt` are server-generated (`new Date()`), never taken
 *   from the browser.
 * - Historical price / address / shipping-method snapshots are never touched.
 * - Every action writes an `OrderEvent` and an `AdminAuditLog` entry.
 */

export type FulfillmentActionState = {
  ok: boolean;
  message?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
};

const TRACKING_RE = /^[A-Za-z0-9_-]{1,40}$/;

const trackingFields = z.object({
  courier: z.string().trim().max(24).optional().default(""),
  courierName: z.string().trim().max(60).optional().default(""),
  trackingNumber: z.string().trim().max(40).optional().default(""),
  trackingUrl: z.string().trim().max(500).optional().default(""),
});

const idField = z.object({ orderId: z.string().min(1).max(64) });
const noteField = z.object({ note: z.string().trim().max(300).optional().default("") });

type OrderRow = {
  id: string;
  orderNumber: string;
  status: string;
  shippingMethodCode: string | null;
  courier: string | null;
  courierName: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
};

const ORDER_SELECT = {
  id: true,
  orderNumber: true,
  status: true,
  shippingMethodCode: true,
  courier: true,
  courierName: true,
  trackingNumber: true,
  trackingUrl: true,
} as const;

type TrackingInput = {
  courier: string;
  courierName: string;
  trackingNumber: string;
  trackingUrl: string;
};
type TrackingData = {
  courier: string | null;
  courierName: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
};

/**
 * Validate + normalise a courier / tracking bundle. `input` is the final desired
 * state (callers merge with the existing order first where that makes sense);
 * an empty field clears that value. Returns per-field errors on failure.
 */
function resolveTracking(
  input: TrackingInput,
  opts: { requireCourier: boolean; storePickup: boolean; autoBuildUrl: boolean },
): { ok: true; data: TrackingData } | { ok: false; fieldErrors: Record<string, string> } {
  // Store pickup never carries a courier / tracking.
  if (opts.storePickup) {
    return { ok: true, data: { courier: null, courierName: null, trackingNumber: null, trackingUrl: null } };
  }

  const fieldErrors: Record<string, string> = {};

  let courier = input.courier;
  if (courier && !isCourierCode(courier)) {
    fieldErrors.courier = "Unknown courier.";
    courier = "";
  }
  if (opts.requireCourier && !courier) fieldErrors.courier = "Choose a courier.";

  const trackingNumber = input.trackingNumber;
  if (trackingNumber && !TRACKING_RE.test(trackingNumber)) {
    fieldErrors.trackingNumber = "Use up to 40 letters, numbers, hyphens or underscores.";
  }

  const courierDef = getCourier(courier);
  if (opts.requireCourier && courier && courierDef?.requiresTracking && !trackingNumber) {
    fieldErrors.trackingNumber = `Add a tracking number for ${courierDef.name}.`;
  }

  // Courier display-name snapshot: custom text for OTHER, else the catalogue name.
  let courierName = input.courierName;
  if (courier === "OTHER" && !courierName) fieldErrors.courierName = "Enter the courier name.";
  if (!courierName && courier && courier !== "OTHER") courierName = courierDef?.name ?? "";

  // Tracking URL: an explicit value must be a plain HTTPS URL; otherwise, when
  // asked, build one from the courier template (Step 13 §5 — only when the
  // courier config supports it).
  let trackingUrl = input.trackingUrl;
  if (trackingUrl && !isSafeTrackingUrl(trackingUrl)) {
    fieldErrors.trackingUrl = "Enter a valid https:// tracking link.";
    trackingUrl = "";
  }
  if (!trackingUrl && opts.autoBuildUrl) {
    trackingUrl = buildTrackingUrl(courier, trackingNumber) ?? "";
  }

  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };

  return {
    ok: true,
    data: {
      courier: courier || null,
      courierName: courierName || null,
      trackingNumber: trackingNumber || null,
      trackingUrl: trackingUrl || null,
    },
  };
}

function mergeTrackingInput(d: TrackingInput, order: OrderRow): TrackingInput {
  return {
    courier: d.courier || order.courier || "",
    courierName: d.courierName || order.courierName || "",
    trackingNumber: d.trackingNumber || order.trackingNumber || "",
    trackingUrl: d.trackingUrl || order.trackingUrl || "",
  };
}

// ---------------------------------------------------------------------------
// Edit courier / tracking — no status change
// ---------------------------------------------------------------------------

const EDITABLE_FROM = ["PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"];

const updateSchema = idField.merge(trackingFields).extend({
  fulfillmentNote: z.string().trim().max(500).optional().default(""),
});

export async function updateFulfillmentAction(input: unknown): Promise<FulfillmentActionState> {
  const admin = await requirePermission("manage_orders");

  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  const d = parsed.data;

  const order = (await prisma.order.findUnique({
    where: { id: d.orderId },
    select: ORDER_SELECT,
  })) as OrderRow | null;
  if (!order) return { ok: false, error: "Order not found." };
  if (!EDITABLE_FROM.includes(order.status)) {
    return {
      ok: false,
      error: `Fulfilment details can be set once the order is being prepared (it is ${orderStatusLabel(order.status)}).`,
    };
  }

  const storePickup = isStorePickupCode(order.shippingMethodCode);
  const resolved = resolveTracking(d, { requireCourier: false, storePickup, autoBuildUrl: true });
  if (!resolved.ok) {
    return { ok: false, error: "Please fix the highlighted fields.", fieldErrors: resolved.fieldErrors };
  }

  await prisma.order.update({
    where: { id: order.id },
    data: {
      courier: resolved.data.courier,
      courierName: resolved.data.courierName,
      trackingNumber: resolved.data.trackingNumber,
      trackingUrl: resolved.data.trackingUrl,
      fulfillmentNote: d.fulfillmentNote || null,
    },
  });

  await writeAudit({
    actorUserId: admin.user.id,
    action: "order.fulfillment_updated",
    targetType: "order",
    targetId: order.id,
    summary: `${admin.user.email} updated fulfilment details for order ${order.orderNumber}`,
    meta: {
      orderNumber: order.orderNumber,
      courier: resolved.data.courier,
      courierName: resolved.data.courierName,
      trackingNumber: resolved.data.trackingNumber,
      trackingUrl: resolved.data.trackingUrl,
      before: {
        courier: order.courier,
        trackingNumber: order.trackingNumber,
      },
    },
  });

  revalidateOrderPaths(order.orderNumber, order.id);
  return { ok: true, message: "Fulfilment details saved." };
}

// ---------------------------------------------------------------------------
// Shared transition
// ---------------------------------------------------------------------------

async function applyTransition(opts: {
  orderId: string;
  from: string[]; // valid current statuses (the atomic guard)
  to: string;
  extra?: Record<string, unknown>;
  event: { title: string; detail: string | null };
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await prisma.$transaction(async (tx) => {
      const res = await tx.order.updateMany({
        where: { id: opts.orderId, status: { in: opts.from } },
        data: { status: opts.to, updatedAt: new Date(), ...opts.extra },
      });
      if (res.count === 0) throw new Error("STALE");
      await tx.orderEvent.create({
        data: {
          orderId: opts.orderId,
          status: opts.to,
          title: opts.event.title,
          detail: opts.event.detail,
        },
      });
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof Error && err.message === "STALE") {
      return { ok: false, error: "The order was updated elsewhere — refresh and try again." };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Mark as shipped  (PROCESSING → SHIPPED)
// ---------------------------------------------------------------------------

const shipSchema = idField.merge(trackingFields).merge(noteField);

export async function markShippedAction(input: unknown): Promise<FulfillmentActionState> {
  const admin = await requirePermission("manage_orders");

  const parsed = shipSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  const d = parsed.data;

  const order = (await prisma.order.findUnique({
    where: { id: d.orderId },
    select: ORDER_SELECT,
  })) as OrderRow | null;
  if (!order) return { ok: false, error: "Order not found." };

  if (order.status === "PENDING_PAYMENT") {
    return { ok: false, error: "This order hasn’t been paid yet — it can’t be shipped." };
  }
  if (isStorePickupCode(order.shippingMethodCode)) {
    return { ok: false, error: "This is a store-pickup order — use “Mark as collected” instead." };
  }
  if (!canTransition(order.status, "SHIPPED")) {
    return { ok: false, error: `An order that is ${orderStatusLabel(order.status)} can’t be shipped.` };
  }

  const resolved = resolveTracking(mergeTrackingInput(d, order), {
    requireCourier: true,
    storePickup: false,
    autoBuildUrl: true,
  });
  if (!resolved.ok) {
    return { ok: false, error: "Please fix the highlighted fields.", fieldErrors: resolved.fieldErrors };
  }

  const detailParts = [
    courierLabel(resolved.data.courier, resolved.data.courierName),
    resolved.data.trackingNumber ? `Tracking ${resolved.data.trackingNumber}` : null,
  ].filter(Boolean);
  if (d.note) detailParts.push(d.note);

  const applied = await applyTransition({
    orderId: order.id,
    from: ["PROCESSING"],
    to: "SHIPPED",
    extra: {
      shippedAt: new Date(),
      courier: resolved.data.courier,
      courierName: resolved.data.courierName,
      trackingNumber: resolved.data.trackingNumber,
      trackingUrl: resolved.data.trackingUrl,
    },
    event: { title: "Order shipped", detail: detailParts.join(" · ") || null },
  });
  if (!applied.ok) return applied;

  await writeAudit({
    actorUserId: admin.user.id,
    action: "order.shipped",
    targetType: "order",
    targetId: order.id,
    summary: `${admin.user.email} shipped order ${order.orderNumber} via ${courierLabel(resolved.data.courier, resolved.data.courierName)}${resolved.data.trackingNumber ? ` (${resolved.data.trackingNumber})` : ""}`,
    meta: {
      orderNumber: order.orderNumber,
      from: "PROCESSING",
      to: "SHIPPED",
      courier: resolved.data.courier,
      courierName: resolved.data.courierName,
      trackingNumber: resolved.data.trackingNumber,
      trackingUrl: resolved.data.trackingUrl,
      note: d.note || null,
    },
  });

  revalidateOrderPaths(order.orderNumber, order.id);

  // Shipment notification — after the response; ORDER_SHIPPED:<orderId> dedupes.
  scheduleEmail(() => sendOrderShipped(order.id));

  return { ok: true, message: "Order marked shipped." };
}

// ---------------------------------------------------------------------------
// Mark out for delivery  (SHIPPED → OUT_FOR_DELIVERY)
// ---------------------------------------------------------------------------

const outForDeliverySchema = idField.merge(noteField);

export async function markOutForDeliveryAction(input: unknown): Promise<FulfillmentActionState> {
  const admin = await requirePermission("manage_orders");

  const parsed = outForDeliverySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  const d = parsed.data;

  const order = (await prisma.order.findUnique({
    where: { id: d.orderId },
    select: ORDER_SELECT,
  })) as OrderRow | null;
  if (!order) return { ok: false, error: "Order not found." };
  if (!canTransition(order.status, "OUT_FOR_DELIVERY")) {
    return {
      ok: false,
      error: `An order that is ${orderStatusLabel(order.status)} can’t be marked out for delivery.`,
    };
  }

  const applied = await applyTransition({
    orderId: order.id,
    from: ["SHIPPED"],
    to: "OUT_FOR_DELIVERY",
    event: { title: "Out for delivery", detail: d.note || null },
  });
  if (!applied.ok) return applied;

  await writeAudit({
    actorUserId: admin.user.id,
    action: "order.out_for_delivery",
    targetType: "order",
    targetId: order.id,
    summary: `${admin.user.email} marked order ${order.orderNumber} out for delivery`,
    meta: {
      orderNumber: order.orderNumber,
      from: "SHIPPED",
      to: "OUT_FOR_DELIVERY",
      courier: order.courier,
      trackingNumber: order.trackingNumber,
      note: d.note || null,
    },
  });

  revalidateOrderPaths(order.orderNumber, order.id);

  // Step 21 P1 — "out for delivery" notification. After the response;
  // ORDER_OUT_FOR_DELIVERY:<orderId> dedupes.
  scheduleEmail(() => sendOutForDelivery(order.id));

  return { ok: true, message: "Order marked out for delivery." };
}

// ---------------------------------------------------------------------------
// Mark as delivered / collected  (SHIPPED | OUT_FOR_DELIVERY → DELIVERED,
//                                 or PROCESSING → DELIVERED for store pickup)
// ---------------------------------------------------------------------------

const deliverSchema = idField.merge(noteField);

export async function markDeliveredAction(input: unknown): Promise<FulfillmentActionState> {
  const admin = await requirePermission("manage_orders");

  const parsed = deliverSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  const d = parsed.data;

  const order = (await prisma.order.findUnique({
    where: { id: d.orderId },
    select: ORDER_SELECT,
  })) as OrderRow | null;
  if (!order) return { ok: false, error: "Order not found." };
  if (order.status === "DELIVERED") {
    return { ok: false, error: "This order is already delivered." };
  }

  const storePickup = isStorePickupCode(order.shippingMethodCode);
  if (!canTransition(order.status, "DELIVERED", { storePickup })) {
    return {
      ok: false,
      error: `An order that is ${orderStatusLabel(order.status)} can’t be marked delivered.`,
    };
  }

  const from = storePickup
    ? ["PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY"]
    : ["SHIPPED", "OUT_FOR_DELIVERY"];

  const applied = await applyTransition({
    orderId: order.id,
    from,
    to: "DELIVERED",
    extra: { deliveredAt: new Date() },
    event: {
      title: storePickup ? "Collected in store" : "Delivered",
      detail: d.note || null,
    },
  });
  if (!applied.ok) return applied;

  await writeAudit({
    actorUserId: admin.user.id,
    action: "order.delivered",
    targetType: "order",
    targetId: order.id,
    summary: `${admin.user.email} marked order ${order.orderNumber} ${storePickup ? "collected" : "delivered"} (was ${orderStatusLabel(order.status)})`,
    meta: {
      orderNumber: order.orderNumber,
      from: order.status,
      to: "DELIVERED",
      storePickup,
      courier: order.courier,
      trackingNumber: order.trackingNumber,
      note: d.note || null,
    },
  });

  revalidateOrderPaths(order.orderNumber, order.id);

  // Delivery confirmation — after the response; ORDER_DELIVERED:<orderId> dedupes.
  scheduleEmail(() => sendOrderDelivered(order.id));

  return { ok: true, message: storePickup ? "Order marked collected." : "Order marked delivered." };
}
