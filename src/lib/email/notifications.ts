import "server-only";
import { prisma } from "@/lib/prisma";
import { getSiteUrl } from "@/lib/site-url";
import { getStoreBrand } from "@/lib/site-settings";
import { courierLabel, isStorePickupCode } from "@/lib/orders/couriers";
import { dispatchEmail, type DispatchResult } from "@/lib/email/send";
import { renderOrderConfirmation } from "@/lib/email/templates/order-confirmation";
import { renderOrderShipped } from "@/lib/email/templates/order-shipped";
import { renderOrderDelivered } from "@/lib/email/templates/order-delivered";
import { renderOrderCancelled } from "@/lib/email/templates/order-cancelled";
import { renderWelcome } from "@/lib/email/templates/welcome";
import { renderRefundNotification } from "@/lib/email/templates/refund-notification";
import { renderEmailVerification, renderPasswordReset } from "@/lib/email/templates/auth";

/**
 * High-level transactional-email API (Step 17 §3). Each function:
 *  - loads the AUTHORITATIVE record from the database (never trusts a caller
 *    payload for prices / totals / tracking);
 *  - builds the branded template;
 *  - hands it to `dispatchEmail` with a deterministic idempotency key.
 *
 * All of these are safe to `await` from a business action after its transaction
 * has committed, or to wrap in `after(...)` so the customer isn't blocked. They
 * never throw.
 */

function firstNameOf(name: string | null | undefined): string | null {
  const t = (name ?? "").trim();
  return t ? t.split(/\s+/)[0] : null;
}

function safeParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Link to the customer's authenticated order page, or the public tracking page. */
function orderLink(siteUrl: string, order: { orderNumber: string; userId: string | null }): string {
  return order.userId
    ? `${siteUrl}/account/orders/${encodeURIComponent(order.orderNumber)}`
    : `${siteUrl}/track`;
}

const ORDER_INCLUDE = {
  items: { orderBy: { id: "asc" } as const },
  user: { select: { name: true } },
} as const;

// ---------------------------------------------------------------------------
// Order confirmation — ORDER_CREATED:<orderId>
// ---------------------------------------------------------------------------

export async function sendOrderConfirmation(
  orderId: string,
  opts: { retry?: boolean } = {},
): Promise<DispatchResult> {
  try {
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
    if (!order || !order.email) return { ok: false, status: "FAILED", error: "order_not_found" };

    const [brand, siteUrl] = [await getStoreBrand(), getSiteUrl()];
    const shippingAddress = safeParse<Record<string, unknown>>(order.shippingAddress, {});
    const customerName =
      firstNameOf(order.user?.name) ??
      (typeof shippingAddress.firstName === "string" ? shippingAddress.firstName : null) ??
      "there";

    // PayMongo deferred → never claim payment succeeded.
    const paymentStateNote =
      order.status === "PENDING_PAYMENT"
        ? "This is not a payment confirmation — your order is awaiting payment."
        : "";

    const { subject, html, text } = renderOrderConfirmation({
      brand,
      siteUrl,
      orderUrl: orderLink(siteUrl, order),
      orderNumber: order.orderNumber,
      placedAt: order.placedAt,
      customerName,
      items: order.items.map((i) => ({
        name: i.name,
        variantLabel: i.variantLabel,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        lineTotal: i.lineTotal,
      })),
      subtotal: order.subtotal,
      discountTotal: order.discountTotal,
      couponCode: order.couponCode,
      shippingMethodName: order.shippingMethodName,
      shippingFee: order.shippingFee,
      grandTotal: order.grandTotal,
      shippingAddress,
      paymentStateNote,
    });

    return dispatchEmail({
      type: "order_confirmation",
      to: order.email,
      subject,
      html,
      text,
      idempotencyKey: `ORDER_CREATED:${order.id}`,
      userId: order.userId,
      orderId: order.id,
      retry: opts.retry,
    });
  } catch (err) {
    console.error("[email] sendOrderConfirmation", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
}

// ---------------------------------------------------------------------------
// Shipment — ORDER_SHIPPED:<orderId>
// ---------------------------------------------------------------------------

export async function sendOrderShipped(
  orderId: string,
  opts: { retry?: boolean } = {},
): Promise<DispatchResult> {
  try {
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
    if (!order || !order.email) return { ok: false, status: "FAILED", error: "order_not_found" };

    const [brand, siteUrl] = [await getStoreBrand(), getSiteUrl()];
    const shippingAddress = safeParse<Record<string, unknown>>(order.shippingAddress, {});
    const customerName = firstNameOf(order.user?.name) ?? "there";

    const { subject, html, text } = renderOrderShipped({
      brand,
      siteUrl,
      orderUrl: orderLink(siteUrl, order),
      orderNumber: order.orderNumber,
      customerName,
      courierLabel: courierLabel(order.courier, order.courierName) || "Courier",
      trackingNumber: order.trackingNumber,
      trackingUrl: order.trackingUrl,
      shippedAt: order.shippedAt,
      shippingAddress,
    });

    return dispatchEmail({
      type: "order_shipped",
      to: order.email,
      subject,
      html,
      text,
      idempotencyKey: `ORDER_SHIPPED:${order.id}`,
      userId: order.userId,
      orderId: order.id,
      retry: opts.retry,
    });
  } catch (err) {
    console.error("[email] sendOrderShipped", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
}

// ---------------------------------------------------------------------------
// Delivery — ORDER_DELIVERED:<orderId>
// ---------------------------------------------------------------------------

export async function sendOrderDelivered(
  orderId: string,
  opts: { retry?: boolean } = {},
): Promise<DispatchResult> {
  try {
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { user: { select: { name: true } } } });
    if (!order || !order.email) return { ok: false, status: "FAILED", error: "order_not_found" };

    const [brand, siteUrl] = [await getStoreBrand(), getSiteUrl()];

    const { subject, html, text } = renderOrderDelivered({
      brand,
      siteUrl,
      orderUrl: orderLink(siteUrl, order),
      orderNumber: order.orderNumber,
      customerName: firstNameOf(order.user?.name) ?? "there",
      deliveredAt: order.deliveredAt,
      storePickup: isStorePickupCode(order.shippingMethodCode),
    });

    return dispatchEmail({
      type: "order_delivered",
      to: order.email,
      subject,
      html,
      text,
      idempotencyKey: `ORDER_DELIVERED:${order.id}`,
      userId: order.userId,
      orderId: order.id,
      retry: opts.retry,
    });
  } catch (err) {
    console.error("[email] sendOrderDelivered", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
}

// ---------------------------------------------------------------------------
// Cancellation — ORDER_CANCELLED:<orderId>
// ---------------------------------------------------------------------------

export async function sendOrderCancelled(
  orderId: string,
  reason?: string | null,
  opts: { retry?: boolean } = {},
): Promise<DispatchResult> {
  try {
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { user: { select: { name: true } } } });
    if (!order || !order.email) return { ok: false, status: "FAILED", error: "order_not_found" };

    const [brand, siteUrl] = [await getStoreBrand(), getSiteUrl()];

    const { subject, html, text } = renderOrderCancelled({
      brand,
      siteUrl,
      orderUrl: orderLink(siteUrl, order),
      orderNumber: order.orderNumber,
      customerName: firstNameOf(order.user?.name) ?? "there",
      grandTotal: order.grandTotal,
      reason: (reason ?? "").trim() || null,
    });

    return dispatchEmail({
      type: "order_cancelled",
      to: order.email,
      subject,
      html,
      text,
      idempotencyKey: `ORDER_CANCELLED:${order.id}`,
      userId: order.userId,
      orderId: order.id,
      retry: opts.retry,
    });
  } catch (err) {
    console.error("[email] sendOrderCancelled", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
}

// ---------------------------------------------------------------------------
// Welcome — WELCOME:<userId>
// ---------------------------------------------------------------------------

export async function sendWelcomeEmail(
  userId: string,
  opts: { retry?: boolean } = {},
): Promise<DispatchResult> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, _count: { select: { userRoles: true } } },
    });
    if (!user || !user.email) return { ok: false, status: "FAILED", error: "user_not_found" };

    // The customer welcome email is for genuine customer accounts only. Suppress
    // it for anyone holding an admin role, or with a pending / accepted admin
    // invite (admin onboarding is handled by the invite flow, not here). No
    // EmailLog row is written — this is a deliberate non-send, not a failure.
    const pendingAdminInvite =
      user._count.userRoles > 0
        ? 1
        : await prisma.adminInvite.count({
            where: { email: user.email.toLowerCase(), status: { in: ["PENDING", "ACCEPTED"] } },
          });
    if (user._count.userRoles > 0 || pendingAdminInvite > 0) {
      return { ok: true, skipped: true, status: "SKIPPED" };
    }

    const [brand, siteUrl] = [await getStoreBrand(), getSiteUrl()];

    const { subject, html, text } = renderWelcome({
      brand,
      siteUrl,
      accountUrl: `${siteUrl}/account`,
      firstName: firstNameOf(user.name),
    });

    return dispatchEmail({
      type: "welcome",
      to: user.email,
      subject,
      html,
      text,
      idempotencyKey: `WELCOME:${user.id}`,
      userId: user.id,
      retry: opts.retry,
    });
  } catch (err) {
    console.error("[email] sendWelcomeEmail", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
}

// ---------------------------------------------------------------------------
// Admin retry — re-run the matching notification for a FAILED / SKIPPED log,
// reusing its idempotency key (so it never becomes a second row / second send).
// ---------------------------------------------------------------------------

export async function retryEmailByLog(logId: string): Promise<DispatchResult> {
  const log = await prisma.emailLog.findUnique({
    where: { id: logId },
    select: { type: true, orderId: true, userId: true, status: true },
  });
  if (!log) return { ok: false, status: "FAILED", error: "log_not_found" };
  if (log.status === "SENT") return { ok: true, deduped: true, status: "DEDUPED" };

  switch (log.type) {
    case "order_confirmation":
      return log.orderId ? sendOrderConfirmation(log.orderId, { retry: true }) : { ok: false, status: "FAILED", error: "no_order" };
    case "order_shipped":
      return log.orderId ? sendOrderShipped(log.orderId, { retry: true }) : { ok: false, status: "FAILED", error: "no_order" };
    case "order_delivered":
      return log.orderId ? sendOrderDelivered(log.orderId, { retry: true }) : { ok: false, status: "FAILED", error: "no_order" };
    case "order_cancelled":
      return log.orderId ? sendOrderCancelled(log.orderId, null, { retry: true }) : { ok: false, status: "FAILED", error: "no_order" };
    case "welcome":
      return log.userId ? sendWelcomeEmail(log.userId, { retry: true }) : { ok: false, status: "FAILED", error: "no_user" };
    default:
      // refund_notification / auth emails carry no re-derivable payload here.
      return { ok: false, status: "FAILED", error: "not_retryable" };
  }
}

// ---------------------------------------------------------------------------
// Refund — FOUNDATION ONLY. Not called anywhere. A future real refund event
// supplies the authoritative refund record.
// ---------------------------------------------------------------------------

export async function sendRefundNotification(params: {
  orderId: string;
  refundAmount: number;
  refundReference: string;
  method?: string;
  idempotencyKey: string; // MUST be unique per real refund, e.g. "REFUND:<refundId>"
}): Promise<DispatchResult> {
  try {
    const order = await prisma.order.findUnique({
      where: { id: params.orderId },
      include: { user: { select: { name: true } } },
    });
    if (!order || !order.email) return { ok: false, status: "FAILED", error: "order_not_found" };

    const [brand, siteUrl] = [await getStoreBrand(), getSiteUrl()];

    const { subject, html, text } = renderRefundNotification({
      brand,
      siteUrl,
      orderUrl: orderLink(siteUrl, order),
      orderNumber: order.orderNumber,
      customerName: firstNameOf(order.user?.name) ?? "there",
      refundAmount: params.refundAmount,
      refundReference: params.refundReference,
      method: params.method ?? "your original payment method",
    });

    return dispatchEmail({
      type: "refund_notification",
      to: order.email,
      subject,
      html,
      text,
      idempotencyKey: params.idempotencyKey,
      userId: order.userId,
      orderId: order.id,
    });
  } catch (err) {
    console.error("[email] sendRefundNotification", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
}

// ---------------------------------------------------------------------------
// Auth emails — FOUNDATION ONLY. Supabase Auth owns verification / reset.
// Not wired to any flow. See templates/auth.ts.
// ---------------------------------------------------------------------------

export async function sendEmailVerification(params: {
  to: string;
  actionUrl: string;
  firstName?: string | null;
  idempotencyKey: string;
  userId?: string | null;
}): Promise<DispatchResult> {
  const [brand, siteUrl] = [await getStoreBrand(), getSiteUrl()];
  const { subject, html, text } = renderEmailVerification({
    brand,
    siteUrl,
    actionUrl: params.actionUrl,
    firstName: params.firstName ?? null,
  });
  return dispatchEmail({
    type: "email_verification",
    to: params.to,
    subject,
    html,
    text,
    idempotencyKey: params.idempotencyKey,
    userId: params.userId ?? null,
  });
}

export async function sendPasswordReset(params: {
  to: string;
  actionUrl: string;
  firstName?: string | null;
  idempotencyKey: string;
  userId?: string | null;
}): Promise<DispatchResult> {
  const [brand, siteUrl] = [await getStoreBrand(), getSiteUrl()];
  const { subject, html, text } = renderPasswordReset({
    brand,
    siteUrl,
    actionUrl: params.actionUrl,
    firstName: params.firstName ?? null,
  });
  return dispatchEmail({
    type: "password_reset",
    to: params.to,
    subject,
    html,
    text,
    idempotencyKey: params.idempotencyKey,
    userId: params.userId ?? null,
  });
}
