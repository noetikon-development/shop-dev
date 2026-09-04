import "server-only";
import { prisma } from "@/lib/prisma";
import { getSiteUrl } from "@/lib/site-url";
import { getStoreBrand } from "@/lib/site-settings";
import { courierLabel, isStorePickupCode } from "@/lib/orders/couriers";
import { dispatchEmail, recordEmailFailure, type DispatchResult, type EmailType } from "@/lib/email/send";
import { renderOrderConfirmation } from "@/lib/email/templates/order-confirmation";
import { renderOrderProcessing } from "@/lib/email/templates/order-processing";
import { renderOrderShipped } from "@/lib/email/templates/order-shipped";
import { renderOutForDelivery } from "@/lib/email/templates/out-for-delivery";
import { renderOrderDelivered } from "@/lib/email/templates/order-delivered";
import { renderOrderCancelled } from "@/lib/email/templates/order-cancelled";
import { renderWelcome } from "@/lib/email/templates/welcome";
import { renderPasswordChanged } from "@/lib/email/templates/password-changed";
import { renderEmailChanged } from "@/lib/email/templates/email-changed";
import { renderSignInAlert } from "@/lib/email/templates/sign-in-alert";
import { renderSupportInbound } from "@/lib/email/templates/support-inbound";
import { renderSupportAck } from "@/lib/email/templates/support-ack";
import { renderReturnRequested } from "@/lib/email/templates/return-requested";
import { renderReturnInbound } from "@/lib/email/templates/return-inbound";
import { renderReturnApproved } from "@/lib/email/templates/return-approved";
import { renderReturnRejected } from "@/lib/email/templates/return-rejected";
import { renderReturnReceived } from "@/lib/email/templates/return-received";
import { renderReturnRefundInitiated } from "@/lib/email/templates/return-refund-initiated";
import { renderReturnRefundCompleted } from "@/lib/email/templates/return-refund-completed";
import { renderPaymentConfirmation } from "@/lib/email/templates/payment-confirmation";
import { renderRefundIssued } from "@/lib/email/templates/refund-issued";
import { renderRefundCompleted } from "@/lib/email/templates/refund-completed";
import { renderEmailVerification, renderPasswordReset } from "@/lib/email/templates/auth";
import {
  renderSellerProductRequestSubmitted,
  renderSellerProductRequestApproved,
  renderSellerProductRequestRejected,
} from "@/lib/email/templates/seller-product-request";
import { returnReasonLabel } from "@/lib/returns/status";
import { getReturnsConfig } from "@/lib/returns";
import { createHash } from "node:crypto";
import { maskEmail, setEmailFooterContext } from "@/lib/email/html";

/** Account-security notices go from a no-reply address, not the orders inbox. */
const SECURITY_FROM = "no-reply@axiaro.shop";
/** Operational order/return notifications to the store team. */
const ORDERS_FROM = "orders@axiaro.shop";
/** Support-team notifications come from the support inbox address. */
const SUPPORT_FROM = "support@axiaro.shop";
/** Fallback support inbox when `support.inboxEmail` is unset or invalid. */
const SUPPORT_INBOX_FALLBACK = "support@axiaro.shop";
/** How long we tell customers a support reply takes. */
const SUPPORT_RESPONSE_WINDOW = "1–2 business days";
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * The address contact-form messages are delivered to. Configured in
 * Settings → Contact (`support.inboxEmail`); read uncached here because this
 * runs from `after()`, outside a Next request scope.
 */
async function getSupportInboxEmail(): Promise<string> {
  try {
    const row = await prisma.storeSetting.findUnique({
      where: { key: "support.inboxEmail" },
      select: { value: true },
    });
    const v = (row?.value ?? "").trim();
    return EMAIL_RE.test(v) ? v : SUPPORT_INBOX_FALLBACK;
  } catch {
    return SUPPORT_INBOX_FALLBACK;
  }
}

/** Stable digest of a contact-form submission, shared by both support emails. */
function supportDigest(email: string, subject: string, message: string): string {
  return shortHash(`${email.trim().toLowerCase()}|${subject}|${message}`);
}

export type SupportMessageInput = {
  name: string;
  email: string;
  subject: string;
  message: string;
  at?: Date;
};

/** UTC hour bucket, e.g. "2026-08-31T14" — deterministic idempotency window. */
function hourBucket(at: Date = new Date()): string {
  return at.toISOString().slice(0, 13);
}
/** UTC day bucket, e.g. "2026-08-31". */
function dayBucket(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}
function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

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

type DispatchMeta = {
  type: EmailType;
  to: string;
  idempotencyKey: string;
  userId?: string | null;
  orderId?: string | null;
  from?: string;
  replyTo?: string;
  retry?: boolean;
};

/**
 * Footer values for a customer email — the authoritative public support address
 * (`contact.email`) and, when configured, the legal entity line
 * (`business.legalName` + the store address). Read UNCACHED because this whole
 * module runs from `after()`, outside a Next request scope. Falls back to the
 * built-in `support@axiaro.shop` when the setting is absent / not an email.
 */
async function getEmailFooter(): Promise<{
  supportEmail?: string;
  legal?: { name: string; address: string } | null;
}> {
  try {
    const rows = await prisma.storeSetting.findMany({
      where: {
        key: {
          in: [
            "contact.email",
            "business.legalName",
            "contact.addressLine1",
            "contact.addressLine2",
            "contact.city",
            "contact.country",
          ],
        },
      },
      select: { key: true, value: true },
    });
    const m = new Map(rows.map((r) => [r.key, (r.value ?? "").trim()]));
    const email = m.get("contact.email") ?? "";
    const legalName = m.get("business.legalName") ?? "";
    const address = [
      m.get("contact.addressLine1"),
      m.get("contact.addressLine2"),
      [m.get("contact.city"), m.get("contact.country")].filter(Boolean).join(", "),
    ]
      .filter(Boolean)
      .join(", ");
    return {
      supportEmail: EMAIL_RE.test(email) ? email : undefined,
      legal: legalName ? { name: legalName, address } : null,
    };
  } catch {
    return {};
  }
}

/**
 * Build the message, then dispatch it.
 *
 * - Sets the ambient footer context (support address / legal line) for the
 *   synchronous template render, then clears it — there is no `await` between,
 *   so concurrent renders can't cross-contaminate.
 * - If the template render THROWS, record a FAILED EmailLog row (via
 *   `recordEmailFailure`) instead of letting the failure vanish into the server
 *   log. The business transaction that triggered this has already committed and
 *   is unaffected either way.
 */
async function renderAndDispatch(
  meta: DispatchMeta,
  build: () => { subject: string; html: string; text: string },
): Promise<DispatchResult> {
  const footer = await getEmailFooter();
  let msg: { subject: string; html: string; text: string };
  try {
    setEmailFooterContext(footer);
    msg = build();
  } catch (err) {
    setEmailFooterContext({});
    return recordEmailFailure({
      type: meta.type,
      to: meta.to,
      idempotencyKey: meta.idempotencyKey,
      userId: meta.userId,
      orderId: meta.orderId,
      error: `render_failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  setEmailFooterContext({});
  return dispatchEmail({ ...meta, ...msg });
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

    return renderAndDispatch(
      {
        type: "order_confirmation",
        to: order.email,
        idempotencyKey: `ORDER_CREATED:${order.id}`,
        userId: order.userId,
        orderId: order.id,
        retry: opts.retry,
      },
      () =>
        renderOrderConfirmation({
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
          payOnDelivery: order.status === "PENDING_PAYMENT",
        }),
    );
  } catch (err) {
    console.error("[email] sendOrderConfirmation", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
}

// ---------------------------------------------------------------------------
// Processing — ORDER_PROCESSING:<orderId>  (Step 21 P1)
// ---------------------------------------------------------------------------

export async function sendOrderProcessing(
  orderId: string,
  opts: { retry?: boolean } = {},
): Promise<DispatchResult> {
  try {
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
    if (!order || !order.email) return { ok: false, status: "FAILED", error: "order_not_found" };

    const [brand, siteUrl] = [await getStoreBrand(), getSiteUrl()];

    return renderAndDispatch(
      {
        type: "order_processing",
        to: order.email,
        idempotencyKey: `ORDER_PROCESSING:${order.id}`,
        userId: order.userId,
        orderId: order.id,
        retry: opts.retry,
      },
      () =>
        renderOrderProcessing({
          brand,
          siteUrl,
          orderUrl: orderLink(siteUrl, order),
          orderNumber: order.orderNumber,
          customerName: firstNameOf(order.user?.name) ?? "there",
          items: order.items.map((i) => ({
            name: i.name,
            variantLabel: i.variantLabel,
            quantity: i.quantity,
          })),
        }),
    );
  } catch (err) {
    console.error("[email] sendOrderProcessing", err);
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

    return renderAndDispatch(
      {
        type: "order_shipped",
        to: order.email,
        idempotencyKey: `ORDER_SHIPPED:${order.id}`,
        userId: order.userId,
        orderId: order.id,
        retry: opts.retry,
      },
      () =>
        renderOrderShipped({
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
        }),
    );
  } catch (err) {
    console.error("[email] sendOrderShipped", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
}

// ---------------------------------------------------------------------------
// Out for delivery — ORDER_OUT_FOR_DELIVERY:<orderId>  (Step 21 P1)
// ---------------------------------------------------------------------------

export async function sendOutForDelivery(
  orderId: string,
  opts: { retry?: boolean } = {},
): Promise<DispatchResult> {
  try {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { user: { select: { name: true } } },
    });
    if (!order || !order.email) return { ok: false, status: "FAILED", error: "order_not_found" };

    const [brand, siteUrl] = [await getStoreBrand(), getSiteUrl()];

    return renderAndDispatch(
      {
        type: "out_for_delivery",
        to: order.email,
        idempotencyKey: `ORDER_OUT_FOR_DELIVERY:${order.id}`,
        userId: order.userId,
        orderId: order.id,
        retry: opts.retry,
      },
      () =>
        renderOutForDelivery({
          brand,
          siteUrl,
          orderUrl: orderLink(siteUrl, order),
          orderNumber: order.orderNumber,
          customerName: firstNameOf(order.user?.name) ?? "there",
          courierLabel: courierLabel(order.courier, order.courierName) || "Courier",
          trackingNumber: order.trackingNumber,
          trackingUrl: order.trackingUrl,
        }),
    );
  } catch (err) {
    console.error("[email] sendOutForDelivery", err);
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

    return renderAndDispatch(
      {
        type: "order_delivered",
        to: order.email,
        idempotencyKey: `ORDER_DELIVERED:${order.id}`,
        userId: order.userId,
        orderId: order.id,
        retry: opts.retry,
      },
      () =>
        renderOrderDelivered({
          brand,
          siteUrl,
          orderUrl: orderLink(siteUrl, order),
          orderNumber: order.orderNumber,
          customerName: firstNameOf(order.user?.name) ?? "there",
          deliveredAt: order.deliveredAt,
          storePickup: isStorePickupCode(order.shippingMethodCode),
        }),
    );
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

    return renderAndDispatch(
      {
        type: "order_cancelled",
        to: order.email,
        idempotencyKey: `ORDER_CANCELLED:${order.id}`,
        userId: order.userId,
        orderId: order.id,
        retry: opts.retry,
      },
      () =>
        renderOrderCancelled({
          brand,
          siteUrl,
          orderUrl: orderLink(siteUrl, order),
          orderNumber: order.orderNumber,
          customerName: firstNameOf(order.user?.name) ?? "there",
          grandTotal: order.grandTotal,
          reason: (reason ?? "").trim() || null,
        }),
    );
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

    return renderAndDispatch(
      {
        type: "welcome",
        to: user.email,
        from: SECURITY_FROM,
        idempotencyKey: `WELCOME:${user.id}`,
        userId: user.id,
        retry: opts.retry,
      },
      () =>
        renderWelcome({
          brand,
          siteUrl,
          accountUrl: `${siteUrl}/account`,
          firstName: firstNameOf(user.name),
        }),
    );
  } catch (err) {
    console.error("[email] sendWelcomeEmail", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
}

// ---------------------------------------------------------------------------
// Account-security notices (Step 21 P2). All go from no-reply@, carry NO
// password / token / secret, and never throw. `userId` is the application
// User.id; the authoritative account email is read here.
// ---------------------------------------------------------------------------

/** After a successful password change or reset. Key: PASSWORD_CHANGED:<userId>:<UTC hour>. */
export async function sendPasswordChanged(
  userId: string,
  opts: { deviceSummary?: string | null; at?: Date } = {},
): Promise<DispatchResult> {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
    if (!user?.email) return { ok: false, status: "FAILED", error: "user_not_found" };

    const [brand, siteUrl] = [await getStoreBrand(), getSiteUrl()];
    const at = opts.at ?? new Date();

    return renderAndDispatch(
      {
        type: "password_changed",
        to: user.email,
        from: SECURITY_FROM,
        idempotencyKey: `PASSWORD_CHANGED:${user.id}:${hourBucket(at)}`,
        userId: user.id,
      },
      () =>
        renderPasswordChanged({
          brand,
          siteUrl,
          accountEmail: user.email,
          changedAt: at,
          deviceSummary: opts.deviceSummary ?? null,
          resetUrl: `${siteUrl}/forgot-password`,
        }),
    );
  } catch (err) {
    console.error("[email] sendPasswordChanged", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
}

/**
 * When a customer requests an email change. Sent to the CURRENT (old) address.
 * Key: EMAIL_CHANGE:<userId>:<hash(newEmail)> — one notice per target address.
 */
export async function sendEmailChanged(
  userId: string,
  newEmail: string,
  opts: { deviceSummary?: string | null; at?: Date } = {},
): Promise<DispatchResult> {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
    if (!user?.email) return { ok: false, status: "FAILED", error: "user_not_found" };
    const target = newEmail.trim().toLowerCase();
    if (!target || target === user.email.toLowerCase()) {
      return { ok: false, status: "FAILED", error: "no_change" };
    }

    const [brand, siteUrl] = [await getStoreBrand(), getSiteUrl()];
    const at = opts.at ?? new Date();

    return renderAndDispatch(
      {
        type: "email_changed",
        to: user.email,
        from: SECURITY_FROM,
        idempotencyKey: `EMAIL_CHANGE:${user.id}:${shortHash(target)}`,
        userId: user.id,
      },
      () =>
        renderEmailChanged({
          brand,
          siteUrl,
          currentEmail: user.email,
          newEmailMasked: maskEmail(target),
          requestedAt: at,
          deviceSummary: opts.deviceSummary ?? null,
          resetUrl: `${siteUrl}/forgot-password`,
        }),
    );
  } catch (err) {
    console.error("[email] sendEmailChanged", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
}

/**
 * A successful password sign-in from a device we have not seen for this
 * account. Only call when `recordSignIn` reports `isNewDevice`.
 * Key: SIGNIN_ALERT:<userId>:<uaHash-16>:<UTC day>.
 */
export async function sendSignInAlert(
  userId: string,
  params: { deviceSummary: string; uaHash: string; at?: Date },
): Promise<DispatchResult> {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
    if (!user?.email) return { ok: false, status: "FAILED", error: "user_not_found" };

    const [brand, siteUrl] = [await getStoreBrand(), getSiteUrl()];
    const at = params.at ?? new Date();

    return renderAndDispatch(
      {
        type: "sign_in_alert",
        to: user.email,
        from: SECURITY_FROM,
        idempotencyKey: `SIGNIN_ALERT:${user.id}:${params.uaHash.slice(0, 16)}:${dayBucket(at)}`,
        userId: user.id,
      },
      () =>
        renderSignInAlert({
          brand,
          siteUrl,
          accountEmail: user.email,
          signedInAt: at,
          deviceSummary: params.deviceSummary || "Unknown device",
          resetUrl: `${siteUrl}/forgot-password`,
        }),
    );
  } catch (err) {
    console.error("[email] sendSignInAlert", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
}

// ---------------------------------------------------------------------------
// Customer support / contact form (Step 21 P5). Two emails per submission:
//   support_inbound — to the support inbox, from support@, Reply-To = customer.
//   support_ack     — to the customer, from no-reply@.
// Both carry ONLY the customer's own name / email / subject / message. No
// account data, order data, password, token or secret. Idempotency keys share a
// digest of (email, subject, message) + the UTC day, so an accidental double
// submit on the same day never produces a second email.
// ---------------------------------------------------------------------------

/** Notify the support team of a new contact-form message. */
export async function sendSupportInbound(input: SupportMessageInput): Promise<DispatchResult> {
  try {
    const [brand, siteUrl, to] = [await getStoreBrand(), getSiteUrl(), await getSupportInboxEmail()];
    const at = input.at ?? new Date();

    return renderAndDispatch(
      {
        type: "support_inbound",
        to,
        from: SUPPORT_FROM,
        replyTo: input.email,
        idempotencyKey: `SUPPORT_INBOUND:${supportDigest(input.email, input.subject, input.message)}:${dayBucket(at)}`,
      },
      () =>
        renderSupportInbound({
          brand,
          siteUrl,
          name: input.name,
          email: input.email,
          subject: input.subject,
          message: input.message,
          submittedAt: at,
        }),
    );
  } catch (err) {
    console.error("[email] sendSupportInbound", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
}

/** Acknowledge the customer's contact-form message. */
export async function sendSupportAck(input: SupportMessageInput): Promise<DispatchResult> {
  try {
    const [brand, siteUrl] = [await getStoreBrand(), getSiteUrl()];
    const at = input.at ?? new Date();

    return renderAndDispatch(
      {
        type: "support_ack",
        to: input.email,
        from: SECURITY_FROM,
        idempotencyKey: `SUPPORT_ACK:${supportDigest(input.email, input.subject, input.message)}:${dayBucket(at)}`,
      },
      () =>
        renderSupportAck({
          brand,
          siteUrl,
          customerName: firstNameOf(input.name) ?? "there",
          subject: input.subject,
          responseWindow: SUPPORT_RESPONSE_WINDOW,
        }),
    );
  } catch (err) {
    console.error("[email] sendSupportAck", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
}

// ---------------------------------------------------------------------------
// Returns / RMA (Step 21 P3). One email per (event, return). All customer
// notices go from no-reply@; the single internal notice (return_inbound) goes
// from orders@ to the support inbox with Reply-To = the customer. NONE carry a
// staff note, token or secret. Every dynamic value is escaped by the template.
// Keys: RETURN_<EVENT>:<returnId>.
// ---------------------------------------------------------------------------

type ReturnEmailContext = {
  brand: string;
  siteUrl: string;
  ret: {
    id: string;
    returnNumber: string;
    reason: string;
    customerNote: string | null;
    resolutionNote: string | null;
    adminAssisted: boolean;
    refundAmount: number | null;
    refundMethod: string | null;
    refundReference: string | null;
  };
  order: { id: string; orderNumber: string; email: string; userId: string | null };
  customerName: string;
  items: { name: string; variantLabel: string | null; quantity: number }[];
  returnUrl: string;
  adminUrl: string;
  supportUrl: string;
};

async function loadReturnContext(returnId: string): Promise<ReturnEmailContext | null> {
  const ret = await prisma.returnRequest.findUnique({
    where: { id: returnId },
    select: {
      id: true,
      returnNumber: true,
      reason: true,
      customerNote: true,
      resolutionNote: true,
      adminAssisted: true,
      refundAmount: true,
      refundMethod: true,
      refundReference: true,
      user: { select: { name: true } },
      order: {
        select: { id: true, orderNumber: true, email: true, userId: true, shippingAddress: true },
      },
      items: { orderBy: { id: "asc" }, select: { name: true, variantLabel: true, quantity: true } },
    },
  });
  if (!ret || !ret.order?.email) return null;

  const [brand, siteUrl] = [await getStoreBrand(), getSiteUrl()];
  const shipping = safeParse<Record<string, unknown>>(ret.order.shippingAddress, {});
  const customerName =
    firstNameOf(ret.user?.name) ??
    (typeof shipping.firstName === "string" ? shipping.firstName : null) ??
    "there";
  const returnUrl = ret.order.userId
    ? `${siteUrl}/account/returns/${encodeURIComponent(ret.returnNumber)}`
    : `${siteUrl}/track`;

  return {
    brand,
    siteUrl,
    ret,
    order: ret.order,
    customerName,
    items: ret.items,
    returnUrl,
    adminUrl: `${siteUrl}/admin/returns/${ret.id}`,
    supportUrl: `${siteUrl}/pages/contact`,
  };
}

/** Customer — a return request has been opened. Key: RETURN_REQUESTED:<id>. */
export async function sendReturnRequested(returnId: string): Promise<DispatchResult> {
  try {
    const ctx = await loadReturnContext(returnId);
    if (!ctx) return { ok: false, status: "FAILED", error: "return_not_found" };

    return renderAndDispatch(
      {
        type: "return_requested",
        to: ctx.order.email,
        from: SECURITY_FROM,
        idempotencyKey: `RETURN_REQUESTED:${ctx.ret.id}`,
        userId: ctx.order.userId,
        orderId: ctx.order.id,
      },
      () =>
        renderReturnRequested({
          brand: ctx.brand,
          siteUrl: ctx.siteUrl,
          returnUrl: ctx.returnUrl,
          returnNumber: ctx.ret.returnNumber,
          orderNumber: ctx.order.orderNumber,
          customerName: ctx.customerName,
          reasonLabel: returnReasonLabel(ctx.ret.reason),
          items: ctx.items,
        }),
    );
  } catch (err) {
    console.error("[email] sendReturnRequested", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
}

/** Internal — a return needs triage. Key: RETURN_INBOUND:<id>. */
export async function sendReturnInbound(returnId: string): Promise<DispatchResult> {
  try {
    const ctx = await loadReturnContext(returnId);
    if (!ctx) return { ok: false, status: "FAILED", error: "return_not_found" };
    const to = await getSupportInboxEmail();

    return renderAndDispatch(
      {
        type: "return_inbound",
        to,
        from: ORDERS_FROM,
        replyTo: ctx.order.email,
        idempotencyKey: `RETURN_INBOUND:${ctx.ret.id}`,
        orderId: ctx.order.id,
      },
      () =>
        renderReturnInbound({
          brand: ctx.brand,
          siteUrl: ctx.siteUrl,
          adminUrl: ctx.adminUrl,
          returnNumber: ctx.ret.returnNumber,
          orderNumber: ctx.order.orderNumber,
          customerName: ctx.customerName,
          customerEmail: ctx.order.email,
          reasonLabel: returnReasonLabel(ctx.ret.reason),
          customerNote: ctx.ret.customerNote,
          adminAssisted: ctx.ret.adminAssisted,
          items: ctx.items,
        }),
    );
  } catch (err) {
    console.error("[email] sendReturnInbound", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
}

/** Customer — return approved. Key: RETURN_APPROVED:<id>. */
export async function sendReturnApproved(returnId: string): Promise<DispatchResult> {
  try {
    const ctx = await loadReturnContext(returnId);
    if (!ctx) return { ok: false, status: "FAILED", error: "return_not_found" };
    const cfg = await getReturnsConfig();

    return renderAndDispatch(
      {
        type: "return_approved",
        to: ctx.order.email,
        from: SECURITY_FROM,
        idempotencyKey: `RETURN_APPROVED:${ctx.ret.id}`,
        userId: ctx.order.userId,
        orderId: ctx.order.id,
      },
      () =>
        renderReturnApproved({
          brand: ctx.brand,
          siteUrl: ctx.siteUrl,
          returnUrl: ctx.returnUrl,
          returnNumber: ctx.ret.returnNumber,
          orderNumber: ctx.order.orderNumber,
          customerName: ctx.customerName,
          items: ctx.items,
          instructions: cfg.instructions || null,
          policyUrl: cfg.policyUrl || null,
          resolutionNote: ctx.ret.resolutionNote,
        }),
    );
  } catch (err) {
    console.error("[email] sendReturnApproved", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
}

/** Customer — return rejected. Key: RETURN_REJECTED:<id>. */
export async function sendReturnRejected(returnId: string): Promise<DispatchResult> {
  try {
    const ctx = await loadReturnContext(returnId);
    if (!ctx) return { ok: false, status: "FAILED", error: "return_not_found" };

    return renderAndDispatch(
      {
        type: "return_rejected",
        to: ctx.order.email,
        from: SECURITY_FROM,
        idempotencyKey: `RETURN_REJECTED:${ctx.ret.id}`,
        userId: ctx.order.userId,
        orderId: ctx.order.id,
      },
      () =>
        renderReturnRejected({
          brand: ctx.brand,
          siteUrl: ctx.siteUrl,
          returnUrl: ctx.returnUrl,
          supportUrl: ctx.supportUrl,
          returnNumber: ctx.ret.returnNumber,
          orderNumber: ctx.order.orderNumber,
          customerName: ctx.customerName,
          resolutionNote: ctx.ret.resolutionNote,
        }),
    );
  } catch (err) {
    console.error("[email] sendReturnRejected", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
}

/** Customer — returned items received. Key: RETURN_RECEIVED:<id>. */
export async function sendReturnReceived(returnId: string): Promise<DispatchResult> {
  try {
    const ctx = await loadReturnContext(returnId);
    if (!ctx) return { ok: false, status: "FAILED", error: "return_not_found" };

    return renderAndDispatch(
      {
        type: "return_received",
        to: ctx.order.email,
        from: SECURITY_FROM,
        idempotencyKey: `RETURN_RECEIVED:${ctx.ret.id}`,
        userId: ctx.order.userId,
        orderId: ctx.order.id,
      },
      () =>
        renderReturnReceived({
          brand: ctx.brand,
          siteUrl: ctx.siteUrl,
          returnUrl: ctx.returnUrl,
          returnNumber: ctx.ret.returnNumber,
          orderNumber: ctx.order.orderNumber,
          customerName: ctx.customerName,
          items: ctx.items,
        }),
    );
  } catch (err) {
    console.error("[email] sendReturnReceived", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
}

/** Customer — refund recorded / being processed. Key: RETURN_REFUND_INITIATED:<id>. */
export async function sendReturnRefundInitiated(returnId: string): Promise<DispatchResult> {
  try {
    const ctx = await loadReturnContext(returnId);
    if (!ctx) return { ok: false, status: "FAILED", error: "return_not_found" };
    const refundAmount = ctx.ret.refundAmount;
    if (refundAmount == null) {
      return { ok: false, status: "FAILED", error: "no_refund_amount" };
    }

    return renderAndDispatch(
      {
        type: "return_refund_initiated",
        to: ctx.order.email,
        from: SECURITY_FROM,
        idempotencyKey: `RETURN_REFUND_INITIATED:${ctx.ret.id}`,
        userId: ctx.order.userId,
        orderId: ctx.order.id,
      },
      () =>
        renderReturnRefundInitiated({
          brand: ctx.brand,
          siteUrl: ctx.siteUrl,
          returnUrl: ctx.returnUrl,
          returnNumber: ctx.ret.returnNumber,
          orderNumber: ctx.order.orderNumber,
          customerName: ctx.customerName,
          refundAmount,
          refundMethod: (ctx.ret.refundMethod ?? "").trim() || null,
        }),
    );
  } catch (err) {
    console.error("[email] sendReturnRefundInitiated", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
}

/** Customer — refund marked complete. Key: RETURN_REFUND_COMPLETED:<id>. */
export async function sendReturnRefundCompleted(returnId: string): Promise<DispatchResult> {
  try {
    const ctx = await loadReturnContext(returnId);
    if (!ctx) return { ok: false, status: "FAILED", error: "return_not_found" };
    const refundAmount = ctx.ret.refundAmount;
    if (refundAmount == null) {
      return { ok: false, status: "FAILED", error: "no_refund_amount" };
    }

    return renderAndDispatch(
      {
        type: "return_refund_completed",
        to: ctx.order.email,
        from: SECURITY_FROM,
        idempotencyKey: `RETURN_REFUND_COMPLETED:${ctx.ret.id}`,
        userId: ctx.order.userId,
        orderId: ctx.order.id,
      },
      () =>
        renderReturnRefundCompleted({
          brand: ctx.brand,
          siteUrl: ctx.siteUrl,
          returnUrl: ctx.returnUrl,
          returnNumber: ctx.ret.returnNumber,
          orderNumber: ctx.order.orderNumber,
          customerName: ctx.customerName,
          refundAmount,
          refundMethod: (ctx.ret.refundMethod ?? "").trim() || null,
          refundReference: ctx.ret.refundReference,
        }),
    );
  } catch (err) {
    console.error("[email] sendReturnRefundCompleted", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
}

// ---------------------------------------------------------------------------
// Payments / PayMongo (Step 21 P4). DORMANT in Phase 4-A — no Payment /
// PaymentRefund row can exist, so these are never called. Each loads the
// authoritative record and dispatches from orders@axiaro.shop. No card data,
// no token, no provider secret ever reaches an email. Keys:
//   PAYMENT_CONFIRMATION:<orderId>
//   REFUND_ISSUED:<paymentRefundId>
//   REFUND_COMPLETED:<paymentRefundId>
// ---------------------------------------------------------------------------

function paidMethodLabel(method: string | null | undefined): string {
  switch ((method ?? "").toLowerCase()) {
    case "card":
      return "your card";
    case "gcash":
      return "your GCash account";
    case "paymaya":
      return "your Maya account";
    case "grab_pay":
      return "your GrabPay account";
    default:
      return "your payment method";
  }
}

/** Verified payment captured. Key: PAYMENT_CONFIRMATION:<orderId>. */
export async function sendPaymentConfirmation(orderId: string): Promise<DispatchResult> {
  try {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        orderNumber: true,
        email: true,
        userId: true,
        grandTotal: true,
        shippingAddress: true,
        user: { select: { name: true } },
        payments: {
          where: { status: { in: ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"] } },
          orderBy: { paidAt: "desc" },
          take: 1,
          select: { amount: true, method: true, paidAt: true },
        },
      },
    });
    if (!order?.email) return { ok: false, status: "FAILED", error: "order_not_found" };
    const payment = order.payments[0];
    if (!payment) return { ok: false, status: "FAILED", error: "no_paid_payment" };

    const [brand, siteUrl] = [await getStoreBrand(), getSiteUrl()];
    const shipping = safeParse<Record<string, unknown>>(order.shippingAddress, {});
    const customerName =
      firstNameOf(order.user?.name) ??
      (typeof shipping.firstName === "string" ? shipping.firstName : null) ??
      "there";

    return renderAndDispatch(
      {
        type: "payment_confirmation",
        to: order.email,
        from: ORDERS_FROM,
        idempotencyKey: `PAYMENT_CONFIRMATION:${order.id}`,
        userId: order.userId,
        orderId: order.id,
      },
      () =>
        renderPaymentConfirmation({
          brand,
          siteUrl,
          orderUrl: orderLink(siteUrl, order),
          orderNumber: order.orderNumber,
          customerName,
          amount: payment.amount,
          methodLabel: paidMethodLabel(payment.method),
          paidAt: payment.paidAt ?? new Date(),
        }),
    );
  } catch (err) {
    console.error("[email] sendPaymentConfirmation", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
}

const REFUND_EMAIL_SELECT = {
  id: true,
  amount: true,
  payment: {
    select: {
      amount: true,
      method: true,
      order: {
        select: {
          id: true,
          orderNumber: true,
          email: true,
          userId: true,
          shippingAddress: true,
          user: { select: { name: true } },
        },
      },
    },
  },
  returnRequest: { select: { returnNumber: true } },
} as const;

async function loadRefundEmailContext(paymentRefundId: string) {
  const r = await prisma.paymentRefund.findUnique({
    where: { id: paymentRefundId },
    select: REFUND_EMAIL_SELECT,
  });
  if (!r?.payment.order.email) return null;
  const order = r.payment.order;
  const [brand, siteUrl] = [await getStoreBrand(), getSiteUrl()];
  const shipping = safeParse<Record<string, unknown>>(order.shippingAddress, {});
  const customerName =
    firstNameOf(order.user?.name) ??
    (typeof shipping.firstName === "string" ? shipping.firstName : null) ??
    "there";
  return {
    r,
    order,
    brand,
    siteUrl,
    customerName,
    returnNumber: r.returnRequest?.returnNumber ?? "—",
    returnUrl: order.userId
      ? `${siteUrl}/account/returns/${encodeURIComponent(r.returnRequest?.returnNumber ?? "")}`
      : `${siteUrl}/track`,
  };
}

/** Provider refund requested. Key: REFUND_ISSUED:<paymentRefundId>. */
export async function sendRefundIssued(paymentRefundId: string): Promise<DispatchResult> {
  try {
    const ctx = await loadRefundEmailContext(paymentRefundId);
    if (!ctx) return { ok: false, status: "FAILED", error: "refund_not_found" };

    return renderAndDispatch(
      {
        type: "refund_issued",
        to: ctx.order.email,
        from: ORDERS_FROM,
        idempotencyKey: `REFUND_ISSUED:${ctx.r.id}`,
        userId: ctx.order.userId,
        orderId: ctx.order.id,
      },
      () =>
        renderRefundIssued({
          brand: ctx.brand,
          siteUrl: ctx.siteUrl,
          returnUrl: ctx.returnUrl,
          orderNumber: ctx.order.orderNumber,
          returnNumber: ctx.returnNumber,
          customerName: ctx.customerName,
          amount: ctx.r.amount,
          methodLabel: paidMethodLabel(ctx.r.payment.method),
        }),
    );
  } catch (err) {
    console.error("[email] sendRefundIssued", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
}

/** Provider refund settled. Key: REFUND_COMPLETED:<paymentRefundId>. */
export async function sendRefundCompleted(paymentRefundId: string): Promise<DispatchResult> {
  try {
    const ctx = await loadRefundEmailContext(paymentRefundId);
    if (!ctx) return { ok: false, status: "FAILED", error: "refund_not_found" };

    return renderAndDispatch(
      {
        type: "refund_completed",
        to: ctx.order.email,
        from: ORDERS_FROM,
        idempotencyKey: `REFUND_COMPLETED:${ctx.r.id}`,
        userId: ctx.order.userId,
        orderId: ctx.order.id,
      },
      () =>
        renderRefundCompleted({
          brand: ctx.brand,
          siteUrl: ctx.siteUrl,
          returnUrl: ctx.returnUrl,
          orderNumber: ctx.order.orderNumber,
          returnNumber: ctx.returnNumber,
          customerName: ctx.customerName,
          amount: ctx.r.amount,
          methodLabel: paidMethodLabel(ctx.r.payment.method),
          partial: ctx.r.amount < ctx.r.payment.amount,
        }),
    );
  } catch (err) {
    console.error("[email] sendRefundCompleted", err);
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
    case "order_processing":
      return log.orderId ? sendOrderProcessing(log.orderId, { retry: true }) : { ok: false, status: "FAILED", error: "no_order" };
    case "order_shipped":
      return log.orderId ? sendOrderShipped(log.orderId, { retry: true }) : { ok: false, status: "FAILED", error: "no_order" };
    case "out_for_delivery":
      return log.orderId ? sendOutForDelivery(log.orderId, { retry: true }) : { ok: false, status: "FAILED", error: "no_order" };
    case "order_delivered":
      return log.orderId ? sendOrderDelivered(log.orderId, { retry: true }) : { ok: false, status: "FAILED", error: "no_order" };
    case "order_cancelled":
      return log.orderId ? sendOrderCancelled(log.orderId, null, { retry: true }) : { ok: false, status: "FAILED", error: "no_order" };
    case "welcome":
      return log.userId ? sendWelcomeEmail(log.userId, { retry: true }) : { ok: false, status: "FAILED", error: "no_user" };
    case "payment_confirmation":
      // Order-scoped, deterministic (re-reads the PAID Payment) — safe to re-send.
      return log.orderId ? sendPaymentConfirmation(log.orderId) : { ok: false, status: "FAILED", error: "no_order" };
    default:
      // auth emails / P2 security notices / support (contact-form) emails /
      // return (P3) emails / refund_issued / refund_completed are not retryable
      // here: they carry time-of-event content (or a single-use provider
      // reference) that must not be regenerated and re-sent later.
      return { ok: false, status: "FAILED", error: "not_retryable" };
  }
}

// ---------------------------------------------------------------------------
// Seller product-request notifications (Phase 9F-5c Part 11)
//
// Recipients: the seller's ACTIVE OWNER / MANAGER members (their User.email) plus
// `Seller.notifyEmail` when set. NEVER a customer address. One email per event,
// deduped on a deterministic key. Non-throwing.
// ---------------------------------------------------------------------------

type SellerRequestEmailContext = {
  brand: string;
  siteUrl: string;
  sellerName: string;
  productName: string;
  requestUrl: string;
  recipients: string;
  reviewNote: string | null;
  resultProductId: string | null;
};

async function loadSellerRequestEmailContext(
  requestId: string,
): Promise<SellerRequestEmailContext | null> {
  const req = await prisma.sellerProductRequest.findUnique({
    where: { id: requestId },
    select: {
      proposedName: true,
      reviewStatusNote: true,
      resultProductId: true,
      seller: {
        select: {
          displayName: true,
          notifyEmail: true,
          sellerUsers: {
            where: { status: "ACTIVE", role: { in: ["OWNER", "MANAGER"] } },
            select: { user: { select: { email: true } } },
          },
        },
      },
    },
  });
  if (!req) return null;

  const addrs = new Set<string>();
  for (const su of req.seller.sellerUsers) {
    const e = su.user.email?.trim().toLowerCase();
    if (e && EMAIL_RE.test(e)) addrs.add(e);
  }
  const notify = req.seller.notifyEmail?.trim().toLowerCase();
  if (notify && EMAIL_RE.test(notify)) addrs.add(notify);
  if (addrs.size === 0) return null;

  const [brand, siteUrl] = [await getStoreBrand(), getSiteUrl()];
  return {
    brand,
    siteUrl,
    sellerName: req.seller.displayName,
    productName: req.proposedName,
    requestUrl: `${siteUrl}/seller/product-requests/${requestId}`,
    recipients: [...addrs].join(", "),
    reviewNote: req.reviewStatusNote,
    resultProductId: req.resultProductId,
  };
}

/** Seller — "we received your product request". Key: SELLER_PRODUCT_REQUEST_SUBMITTED:<id>. */
export async function sendSellerProductRequestSubmitted(requestId: string): Promise<DispatchResult> {
  try {
    const ctx = await loadSellerRequestEmailContext(requestId);
    if (!ctx) return { ok: false, status: "FAILED", error: "no_recipient" };
    return renderAndDispatch(
      {
        type: "seller_product_request_submitted",
        to: ctx.recipients,
        from: SECURITY_FROM,
        idempotencyKey: `SELLER_PRODUCT_REQUEST_SUBMITTED:${requestId}`,
      },
      () =>
        renderSellerProductRequestSubmitted({
          brand: ctx.brand,
          siteUrl: ctx.siteUrl,
          sellerName: ctx.sellerName,
          productName: ctx.productName,
          requestUrl: ctx.requestUrl,
        }),
    );
  } catch (err) {
    console.error("[email] sendSellerProductRequestSubmitted", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
}

/**
 * Seller — the request was approved (linked to an existing product OR a new
 * canonical product was created). `reviewedAt` buckets the idempotency key so a
 * later review round can send again. Key:
 * SELLER_PRODUCT_REQUEST_APPROVED:<id>:<reviewedAt ms>.
 */
export async function sendSellerProductRequestApproved(
  requestId: string,
  opts: { reviewedAt: Date; linked: boolean; listUrl?: string | null },
): Promise<DispatchResult> {
  try {
    const ctx = await loadSellerRequestEmailContext(requestId);
    if (!ctx) return { ok: false, status: "FAILED", error: "no_recipient" };
    return renderAndDispatch(
      {
        type: "seller_product_request_approved",
        to: ctx.recipients,
        from: SECURITY_FROM,
        idempotencyKey: `SELLER_PRODUCT_REQUEST_APPROVED:${requestId}:${opts.reviewedAt.getTime()}`,
      },
      () =>
        renderSellerProductRequestApproved({
          brand: ctx.brand,
          siteUrl: ctx.siteUrl,
          sellerName: ctx.sellerName,
          productName: ctx.productName,
          requestUrl: ctx.requestUrl,
          linked: opts.linked,
          listUrl: opts.listUrl ? `${ctx.siteUrl}${opts.listUrl}` : null,
          reviewNote: ctx.reviewNote,
        }),
    );
  } catch (err) {
    console.error("[email] sendSellerProductRequestApproved", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
}

/**
 * Seller — the request was rejected (terminal) or sent back for changes.
 * Key: SELLER_PRODUCT_REQUEST_REJECTED:<id>:<outcome>:<reviewedAt ms>.
 */
export async function sendSellerProductRequestRejected(
  requestId: string,
  opts: { reviewedAt: Date; outcome: "rejected" | "changes_requested" },
): Promise<DispatchResult> {
  try {
    const ctx = await loadSellerRequestEmailContext(requestId);
    if (!ctx) return { ok: false, status: "FAILED", error: "no_recipient" };
    return renderAndDispatch(
      {
        type: "seller_product_request_rejected",
        to: ctx.recipients,
        from: SECURITY_FROM,
        idempotencyKey: `SELLER_PRODUCT_REQUEST_REJECTED:${requestId}:${opts.outcome}:${opts.reviewedAt.getTime()}`,
      },
      () =>
        renderSellerProductRequestRejected({
          brand: ctx.brand,
          siteUrl: ctx.siteUrl,
          sellerName: ctx.sellerName,
          productName: ctx.productName,
          requestUrl: ctx.requestUrl,
          outcome: opts.outcome,
          reviewNote: ctx.reviewNote,
        }),
    );
  } catch (err) {
    console.error("[email] sendSellerProductRequestRejected", err);
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
  return renderAndDispatch(
    {
      type: "email_verification",
      to: params.to,
      idempotencyKey: params.idempotencyKey,
      userId: params.userId ?? null,
    },
    () =>
      renderEmailVerification({
        brand,
        siteUrl,
        actionUrl: params.actionUrl,
        firstName: params.firstName ?? null,
      }),
  );
}

export async function sendPasswordReset(params: {
  to: string;
  actionUrl: string;
  firstName?: string | null;
  idempotencyKey: string;
  userId?: string | null;
}): Promise<DispatchResult> {
  const [brand, siteUrl] = [await getStoreBrand(), getSiteUrl()];
  return renderAndDispatch(
    {
      type: "password_reset",
      to: params.to,
      idempotencyKey: params.idempotencyKey,
      userId: params.userId ?? null,
    },
    () =>
      renderPasswordReset({
        brand,
        siteUrl,
        actionUrl: params.actionUrl,
        firstName: params.firstName ?? null,
      }),
  );
}
