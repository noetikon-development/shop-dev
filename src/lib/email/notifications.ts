import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getSiteUrl } from "@/lib/site-url";
import { getStoreBrand } from "@/lib/site-settings";
import { courierLabel, isStorePickupCode } from "@/lib/orders/couriers";
import { conditionLabel, isNoteworthyCondition } from "@/lib/seller/format";
import { writeAudit } from "@/lib/admin/audit";
import { scheduleEmail } from "@/lib/email/schedule";
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
import {
  renderSellerAccountApproved,
  renderSellerAccountSuspended,
  renderSellerAccountClosed,
  renderSellerProfileApproved,
  renderSellerProfileRejected,
  renderSellerProfileSubmitted,
} from "@/lib/email/templates/seller-lifecycle";
import { renderOrderReceivedOps, renderReturnRefundInitiatedOps, renderReturnRefundCompletedOps, renderEmailFailureAlertOps } from "@/lib/email/templates/ops-notifications";
import {
  renderSellerOrderCancelled,
  renderSellerReturnReceived,
  renderSellerOrderReceived,
  renderSellerSettlementRecorded,
  type ClawbackNote,
} from "@/lib/email/templates/seller-order-notifications";
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
  /** Optional transaction client for EmailLog bookkeeping (tests only). */
  client?: Prisma.TransactionClient;
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
    const failed = await recordEmailFailure({
      type: meta.type,
      to: meta.to,
      idempotencyKey: meta.idempotencyKey,
      userId: meta.userId,
      orderId: meta.orderId,
      client: meta.client,
      error: `render_failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    maybeScheduleEmailFailureAlert(meta, failed);
    return failed;
  }
  setEmailFooterContext({});
  const result = await dispatchEmail({ ...meta, ...msg });
  maybeScheduleEmailFailureAlert(meta, result);
  return result;
}

/**
 * 9F-18 — when a transactional email FAILS or is SKIPPED for a delivery reason,
 * raise exactly one Ops alert (an audit row + one email) so the failure is not
 * silent. The alert flows through this same `renderAndDispatch`, so the guards
 * below (and, inside `sendEmailFailureAlertOps`, the `email_mode_log` /
 * non-production `smtp_not_configured` filters) are what stop it recursing.
 *
 *  - never for the alert type itself → no infinite loop
 *  - never on an admin-initiated retry (`meta.retry`) → the admin sees the result
 *  - never from a test transaction (`meta.client`) → no real alert from tests
 *
 * `dispatchEmail`'s SKIPPED result carries no `error`, so the alert sender
 * re-reads the row to tell `email_mode_log` from `smtp_not_configured`.
 */
function maybeScheduleEmailFailureAlert(meta: DispatchMeta, result: DispatchResult): void {
  if (result.status !== "FAILED" && result.status !== "SKIPPED") return;
  if (meta.type === "email_failure_alert_ops") return;
  if (meta.retry) return;
  if (meta.client) return;
  scheduleEmail(() => sendEmailFailureAlertOps(meta.idempotencyKey));
}

/**
 * 9F-18 Class E — a seller notification whose recipient set resolved empty.
 * Previously this returned FAILED with NO `EmailLog` row at all (a silent,
 * invisible failure). Now it writes a FAILED row keyed on the notification's own
 * idempotency key — dedupe-safe on retry via `recordEmailFailure`'s
 * `skipDuplicates` — and routes it through the same Ops alert path. Does not
 * touch successful recipient resolution.
 */
async function failNoRecipient(meta: {
  type: EmailType;
  idempotencyKey: string;
  subject: string;
  orderId?: string | null;
  userId?: string | null;
  client?: Prisma.TransactionClient;
}): Promise<DispatchResult> {
  const failed = await recordEmailFailure({
    type: meta.type,
    to: "(no recipient resolved)",
    idempotencyKey: meta.idempotencyKey,
    subject: meta.subject,
    orderId: meta.orderId ?? null,
    userId: meta.userId ?? null,
    client: meta.client,
    error: "no_recipient",
  });
  if (!meta.client) scheduleEmail(() => sendEmailFailureAlertOps(meta.idempotencyKey));
  return failed;
}

/** True on a Vercel production deployment (never on preview / local / tests). */
function isProductionRuntime(): boolean {
  return process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
}

/**
 * 9F-18 — Ops alert for a FAILED / SKIPPED transactional email. Identified by
 * the FAILED notification's own idempotency key (unique on `EmailLog`). Writes a
 * durable `email.delivery_failed` audit row FIRST (the non-email administrative
 * signal, present even when SMTP itself is down), then sends one alert email to
 * the ops inbox. Its own idempotency key is `EMAIL_FAILURE_ALERT:<failedLogId>`
 * so a given failure can raise at most one alert. Recursion is impossible: this
 * message is `email_failure_alert_ops`, which `maybeScheduleEmailFailureAlert`
 * always skips. Not retryable from `/admin/email`.
 */
export async function sendEmailFailureAlertOps(
  failedIdempotencyKey: string,
  opts: { client?: Prisma.TransactionClient } = {},
): Promise<DispatchResult> {
  try {
    const db = opts.client ?? prisma;
    const row = await db.emailLog.findUnique({
      where: { idempotencyKey: failedIdempotencyKey },
      select: {
        id: true,
        type: true,
        status: true,
        error: true,
        recipient: true,
        subject: true,
        orderId: true,
        attempts: true,
        updatedAt: true,
      },
    });
    if (!row) return { ok: false, status: "FAILED", error: "log_not_found" };
    // Recursion guard — an alert never alerts on itself.
    if (row.type === "email_failure_alert_ops") return { ok: true, deduped: true, status: "DEDUPED" };
    // Only genuine non-delivery outcomes.
    if (row.status !== "FAILED" && row.status !== "SKIPPED") return { ok: true, deduped: true, status: "DEDUPED" };
    // `EMAIL_MODE=log` is a deliberate operator switch, not a failure.
    if (row.error === "email_mode_log") return { ok: true, skipped: true, status: "SKIPPED" };
    // A missing SMTP config only matters on the production deployment.
    if (row.status === "SKIPPED" && row.error === "smtp_not_configured" && !isProductionRuntime()) {
      return { ok: true, skipped: true, status: "SKIPPED" };
    }
    // At most one alert (audit row + email) per failed notification, ever.
    const alertKey = `EMAIL_FAILURE_ALERT:${row.id}`;
    const priorAlert = await db.emailLog.findUnique({ where: { idempotencyKey: alertKey }, select: { id: true } });
    if (priorAlert) return { ok: true, deduped: true, status: "DEDUPED" };

    const recipientMasked = maskEmail(row.recipient);
    const orderNumber = row.orderId
      ? (await db.order.findUnique({ where: { id: row.orderId }, select: { orderNumber: true } }))?.orderNumber ?? null
      : null;

    // Non-email administrative signal — ALWAYS, before the email attempt, so the
    // failure is recorded even if the alert email itself cannot be delivered.
    await writeAudit(
      {
        actorUserId: null,
        action: "email.delivery_failed",
        targetType: "email_log",
        targetId: row.id,
        summary: `${row.type} to ${recipientMasked} — ${row.status.toLowerCase()}`,
        meta: {
          type: row.type,
          status: row.status,
          error: row.error ?? null,
          recipientMasked,
          orderId: row.orderId ?? null,
        },
      },
      opts.client,
    );

    const [brand, siteUrl, to] = [await getStoreBrand(), getSiteUrl(), await getSupportInboxEmail()];
    return renderAndDispatch(
      {
        type: "email_failure_alert_ops",
        to,
        from: SECURITY_FROM,
        idempotencyKey: alertKey,
        orderId: row.orderId,
        client: opts.client,
      },
      () =>
        renderEmailFailureAlertOps({
          brand,
          siteUrl,
          adminUrl: `${siteUrl}/admin/email`,
          emailType: row.type,
          failureStatus: row.status,
          errorReason: row.error ?? "(none recorded)",
          emailLogId: row.id,
          recipientMasked,
          subject: row.subject,
          orderNumber,
          attempts: row.attempts,
          failedAt: row.updatedAt,
        }),
    );
  } catch (err) {
    console.error("[email] sendEmailFailureAlertOps", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
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

/**
 * Axiaro Operations — a new order was placed. Companion to
 * `sendOrderConfirmation`, not a replacement — the customer email is
 * unchanged. Goes to the ops inbox, never the customer.
 * Key: ORDER_RECEIVED_OPS:<orderId>.
 */
export async function sendOrderReceivedOps(
  orderId: string,
  opts: { retry?: boolean; client?: Prisma.TransactionClient } = {},
): Promise<DispatchResult> {
  try {
    const db = opts.client ?? prisma;
    const order = await db.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        orderNumber: true,
        email: true,
        grandTotal: true,
        placedAt: true,
        items: { select: { id: true } },
      },
    });
    if (!order) return { ok: false, status: "FAILED", error: "order_not_found" };

    const [brand, siteUrl, to] = [await getStoreBrand(), getSiteUrl(), await getSupportInboxEmail()];

    return renderAndDispatch(
      {
        type: "order_received_ops",
        to,
        from: ORDERS_FROM,
        idempotencyKey: `ORDER_RECEIVED_OPS:${order.id}`,
        orderId: order.id,
        retry: opts.retry,
        client: opts.client,
      },
      () =>
        renderOrderReceivedOps({
          brand,
          siteUrl,
          orderNumber: order.orderNumber,
          orderUrl: `${siteUrl}/admin/orders/${order.id}`,
          customerEmail: order.email,
          itemCount: order.items.length,
          grandTotal: order.grandTotal,
          placedAt: order.placedAt,
        }),
    );
  } catch (err) {
    console.error("[email] sendOrderReceivedOps", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
}

// ---------------------------------------------------------------------------
// Seller new-order notification — SELLER_ORDER_RECEIVED:<orderId>  (9F-14)
//
// One email per order to the THIRD_PARTY seller who must fulfil it — the
// missing counterpart of the customer `order_confirmation` + Axiaro
// `order_received_ops` fired at checkout. FIRST_PARTY (Axiaro's own) orders are
// skipped: Axiaro already gets `order_received_ops`. Recipients are the seller's
// ACTIVE OWNER/MANAGER members + `Seller.notifyEmail` (the 9F-6b/9F-7b audience).
// Carries only fulfilment data — never the customer's email / account name /
// billing / order grand total.
// ---------------------------------------------------------------------------

/** Customer-facing label for a stored `Order.paymentMethod`. COD orders store
 *  "NONE" (no online method) — the seller is paid on the payout basis, NOT on
 *  receipt, so the label must make the COD nature explicit. */
function paymentMethodLabel(method: string): string {
  switch (method) {
    case "COD":
    case "NONE":
      return "Cash on Delivery (COD)";
    case "CARD":
      return "Card (paid online)";
    case "GCASH":
      return "GCash (paid online)";
    default:
      return method || "Cash on Delivery (COD)";
  }
}

export async function sendSellerOrderReceived(
  orderId: string,
  opts: { retry?: boolean; idempotencyKey?: string; client?: Prisma.TransactionClient } = {},
): Promise<DispatchResult> {
  try {
    const db = opts.client ?? prisma;
    const order = await db.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        orderNumber: true,
        paymentMethod: true,
        shippingAddress: true,
        sellerOrders: {
          select: {
            id: true,
            sellerId: true,
            sellerType: true,
            merchandiseSubtotal: true,
            discountAllocated: true,
            shippingFee: true,
            total: true,
            items: {
              select: { name: true, variantLabel: true, quantity: true, unitPrice: true, lineTotal: true, condition: true },
              orderBy: { id: "asc" },
            },
          },
        },
      },
    });
    if (!order) return { ok: false, status: "FAILED", error: "order_not_found" };
    const so = order.sellerOrders[0];
    if (!so) return { ok: false, status: "FAILED", error: "seller_order_not_found" };
    // 1P (Axiaro-fulfilled) orders: Axiaro already got `order_received_ops`.
    if (so.sellerType !== "THIRD_PARTY") return { ok: true, skipped: true, status: "SKIPPED" };

    const ctx = await loadSellerLifecycleEmailContext(so.sellerId, opts.client);
    if (!ctx)
      return failNoRecipient({
        type: "seller_order_received",
        idempotencyKey: opts.idempotencyKey ?? `SELLER_ORDER_RECEIVED:${order.id}`,
        subject: `New order ${order.orderNumber} — seller notification`,
        orderId: order.id,
        client: opts.client,
      });

    const shipTo = safeParse<Record<string, unknown> | null>(order.shippingAddress, null);

    return renderAndDispatch(
      {
        type: "seller_order_received",
        to: ctx.recipients,
        from: ORDERS_FROM,
        idempotencyKey: opts.idempotencyKey ?? `SELLER_ORDER_RECEIVED:${order.id}`,
        orderId: order.id,
        retry: opts.retry,
        client: opts.client,
      },
      () =>
        renderSellerOrderReceived({
          brand: ctx.brand,
          siteUrl: ctx.siteUrl,
          sellerName: ctx.sellerName,
          orderNumber: order.orderNumber,
          ordersUrl: `${ctx.siteUrl}/seller/orders`,
          orderUrl: `${ctx.siteUrl}/seller/orders/${so.id}`,
          // 9F-22: fold a "Condition: …" line under a non-NEW item; NEW items
          // are byte-identical to before (no line, no shared-helper change).
          items: so.items.map((i) => ({
            name: i.name,
            variantLabel: isNoteworthyCondition(i.condition)
              ? [i.variantLabel, `Condition: ${conditionLabel(i.condition!)}`].filter(Boolean).join(" · ")
              : i.variantLabel,
            quantity: i.quantity,
            unitPrice: i.unitPrice,
            lineTotal: i.lineTotal,
          })),
          merchandiseSubtotal: so.merchandiseSubtotal,
          discountAllocated: so.discountAllocated,
          shippingFee: so.shippingFee,
          payoutBasis: so.total,
          paymentMethodLabel: paymentMethodLabel(order.paymentMethod),
          shipTo,
        }),
    );
  } catch (err) {
    console.error("[email] sendSellerOrderReceived", err);
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

/**
 * Axiaro Operations — companion to `sendReturnRefundInitiated`. Covers ONLY
 * the bookkeeping/admin refund path (no gateway, no Payment row) — the
 * PayMongo-routed `refund_issued` / `refund_completed` (webhook.ts) stay
 * dormant and untouched. Key: RETURN_REFUND_INITIATED_OPS:<id>.
 */
export async function sendReturnRefundInitiatedOps(
  returnId: string,
  opts: { retry?: boolean; client?: Prisma.TransactionClient } = {},
): Promise<DispatchResult> {
  try {
    const db = opts.client ?? prisma;
    const ret = await db.returnRequest.findUnique({
      where: { id: returnId },
      select: {
        id: true,
        returnNumber: true,
        refundAmount: true,
        refundMethod: true,
        order: { select: { id: true, orderNumber: true } },
      },
    });
    if (!ret) return { ok: false, status: "FAILED", error: "return_not_found" };
    if (ret.refundAmount == null) return { ok: false, status: "FAILED", error: "no_refund_amount" };
    const [brand, siteUrl, to] = [await getStoreBrand(), getSiteUrl(), await getSupportInboxEmail()];

    return renderAndDispatch(
      {
        type: "return_refund_initiated_ops",
        to,
        from: ORDERS_FROM,
        idempotencyKey: `RETURN_REFUND_INITIATED_OPS:${ret.id}`,
        orderId: ret.order.id,
        retry: opts.retry,
        client: opts.client,
      },
      () =>
        renderReturnRefundInitiatedOps({
          brand,
          siteUrl,
          returnNumber: ret.returnNumber,
          orderNumber: ret.order.orderNumber,
          adminUrl: `${siteUrl}/admin/returns/${ret.id}`,
          refundAmount: ret.refundAmount as number,
          refundMethod: (ret.refundMethod ?? "").trim() || null,
        }),
    );
  } catch (err) {
    console.error("[email] sendReturnRefundInitiatedOps", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
}

/**
 * Axiaro Operations — companion to `sendReturnRefundCompleted`. Same
 * bookkeeping-only scope as `sendReturnRefundInitiatedOps`.
 * Key: RETURN_REFUND_COMPLETED_OPS:<id>.
 */
export async function sendReturnRefundCompletedOps(
  returnId: string,
  opts: { retry?: boolean; client?: Prisma.TransactionClient } = {},
): Promise<DispatchResult> {
  try {
    const db = opts.client ?? prisma;
    const ret = await db.returnRequest.findUnique({
      where: { id: returnId },
      select: {
        id: true,
        returnNumber: true,
        refundAmount: true,
        refundMethod: true,
        refundReference: true,
        order: { select: { id: true, orderNumber: true } },
      },
    });
    if (!ret) return { ok: false, status: "FAILED", error: "return_not_found" };
    if (ret.refundAmount == null) return { ok: false, status: "FAILED", error: "no_refund_amount" };
    const [brand, siteUrl, to] = [await getStoreBrand(), getSiteUrl(), await getSupportInboxEmail()];

    return renderAndDispatch(
      {
        type: "return_refund_completed_ops",
        to,
        from: ORDERS_FROM,
        idempotencyKey: `RETURN_REFUND_COMPLETED_OPS:${ret.id}`,
        orderId: ret.order.id,
        retry: opts.retry,
        client: opts.client,
      },
      () =>
        renderReturnRefundCompletedOps({
          brand,
          siteUrl,
          returnNumber: ret.returnNumber,
          orderNumber: ret.order.orderNumber,
          adminUrl: `${siteUrl}/admin/returns/${ret.id}`,
          refundAmount: ret.refundAmount as number,
          refundMethod: (ret.refundMethod ?? "").trim() || null,
          refundReference: ret.refundReference,
        }),
    );
  } catch (err) {
    console.error("[email] sendReturnRefundCompletedOps", err);
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

export async function retryEmailByLog(
  logId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<DispatchResult> {
  const log = await client.emailLog.findUnique({
    where: { id: logId },
    select: { type: true, orderId: true, userId: true, status: true, idempotencyKey: true },
  });
  if (!log) return { ok: false, status: "FAILED", error: "log_not_found" };
  if (log.status === "SENT") return { ok: true, deduped: true, status: "DEDUPED" };
  const tx = client === prisma ? undefined : (client as Prisma.TransactionClient);

  switch (log.type) {
    // 9F-18 — the delivery-failure alert carries time-of-event content and must
    // never be regenerated. If the underlying failure persists it re-alerts on
    // the next automatic attempt; the admin acts from the ORIGINAL failed row.
    case "email_failure_alert_ops":
      return { ok: false, status: "FAILED", error: "not_retryable" };

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

    // Seller product-request emails (9F-5c.1). The request id — and, for the
    // rejected key, the outcome — are encoded in the idempotency key; every
    // other value is reconstructed from the `SellerProductRequest` row. The
    // ORIGINAL key is passed straight back so the retry reuses the same
    // EmailLog row (never a second row, never a second send).
    case "seller_product_request_submitted":
    case "seller_product_request_approved":
    case "seller_product_request_rejected": {
      const parts = log.idempotencyKey.split(":");
      const requestId = parts[1];
      if (!requestId) return { ok: false, status: "FAILED", error: "no_request" };
      const shared: SellerRequestEmailOpts = { retry: true, idempotencyKey: log.idempotencyKey, client: tx };
      if (log.type === "seller_product_request_submitted") {
        return sendSellerProductRequestSubmitted(requestId, shared);
      }
      if (log.type === "seller_product_request_approved") {
        return sendSellerProductRequestApproved(requestId, shared);
      }
      const outcome: "rejected" | "changes_requested" =
        parts[2] === "changes_requested" ? "changes_requested" : "rejected";
      return sendSellerProductRequestRejected(requestId, { ...shared, outcome });
    }

    // Seller account status emails (9F-6b). The key is
    // `SELLER_ACCOUNT_<TO>:<sellerId>:<adminAuditLogId>` — the audit row id is
    // an immutable per-transition anchor (never `Seller.updatedAt`, which any
    // unrelated edit also bumps). The sender re-reads that exact audit row to
    // tell a first approval from a SUSPENDED→APPROVED reactivation.
    case "seller_account_approved":
    case "seller_account_suspended":
    case "seller_account_closed": {
      const parts = log.idempotencyKey.split(":");
      const sellerId = parts[1];
      const auditLogId = parts[2];
      if (!sellerId || !auditLogId) return { ok: false, status: "FAILED", error: "no_seller" };
      const shared: SellerLifecycleEmailOpts = { retry: true, idempotencyKey: log.idempotencyKey, client: tx };
      if (log.type === "seller_account_approved") return sendSellerAccountApproved(sellerId, auditLogId, shared);
      if (log.type === "seller_account_suspended") return sendSellerAccountSuspended(sellerId, auditLogId, shared);
      return sendSellerAccountClosed(sellerId, auditLogId, shared);
    }

    // Seller store-profile moderation emails (9F-6b). Approved/rejected key off
    // `Seller.contentReviewedAt` (dedicated to review, unlike `updatedAt`) plus
    // the resulting moderation state; submitted keys off `contentSubmittedAt`.
    // Both are re-read from the request id embedded in the key.
    case "seller_profile_approved": {
      const sellerId = log.idempotencyKey.split(":")[1];
      if (!sellerId) return { ok: false, status: "FAILED", error: "no_seller" };
      return sendSellerProfileApproved(sellerId, { retry: true, idempotencyKey: log.idempotencyKey, client: tx });
    }
    case "seller_profile_rejected": {
      const sellerId = log.idempotencyKey.split(":")[1];
      if (!sellerId) return { ok: false, status: "FAILED", error: "no_seller" };
      return sendSellerProfileRejected(sellerId, { retry: true, idempotencyKey: log.idempotencyKey, client: tx });
    }
    case "seller_profile_submitted": {
      const sellerId = log.idempotencyKey.split(":")[1];
      if (!sellerId) return { ok: false, status: "FAILED", error: "no_seller" };
      return sendSellerProfileSubmitted(sellerId, { retry: true, idempotencyKey: log.idempotencyKey, client: tx });
    }

    // Marketplace operations notifications (9F-7b). Order-scoped ones
    // (order_received_ops, the two refund ops companions) are deterministic
    // re-reads, same as order_confirmation / payment_confirmation above — no
    // key override needed. The seller-scoped ones parse their id(s) back out
    // of the key, exactly like the seller product-request / account cases.
    case "order_received_ops":
      return log.orderId ? sendOrderReceivedOps(log.orderId, { retry: true, client: tx }) : { ok: false, status: "FAILED", error: "no_order" };
    case "seller_order_received":
      return log.orderId
        ? sendSellerOrderReceived(log.orderId, { retry: true, idempotencyKey: log.idempotencyKey, client: tx })
        : { ok: false, status: "FAILED", error: "no_order" };
    case "return_refund_initiated_ops": {
      const returnId = returnIdFromOpsKey(log.idempotencyKey);
      return returnId ? sendReturnRefundInitiatedOps(returnId, { retry: true, client: tx }) : { ok: false, status: "FAILED", error: "no_return" };
    }
    case "return_refund_completed_ops": {
      const returnId = returnIdFromOpsKey(log.idempotencyKey);
      return returnId ? sendReturnRefundCompletedOps(returnId, { retry: true, client: tx }) : { ok: false, status: "FAILED", error: "no_return" };
    }
    case "seller_order_cancelled": {
      const sellerOrderId = log.idempotencyKey.split(":")[1];
      if (!sellerOrderId) return { ok: false, status: "FAILED", error: "no_seller_order" };
      return sendSellerOrderCancelled(sellerOrderId, { retry: true, idempotencyKey: log.idempotencyKey, client: tx });
    }
    case "seller_return_received": {
      const parts = log.idempotencyKey.split(":");
      const returnId = parts[1];
      const sellerId = parts[2];
      if (!returnId || !sellerId) return { ok: false, status: "FAILED", error: "no_return" };
      return sendSellerReturnReceived(returnId, sellerId, { retry: true, idempotencyKey: log.idempotencyKey, client: tx });
    }
    case "seller_settlement_recorded": {
      // Key: SETTLEMENT_RECORDED:<settlementId>. Deterministic re-read of the
      // SellerSettlement row — the ORIGINAL key is passed back so the retry
      // reuses the same EmailLog row (never a second row, never a second send).
      const settlementId = log.idempotencyKey.split(":")[1];
      if (!settlementId) return { ok: false, status: "FAILED", error: "no_settlement" };
      return sendSellerSettlementRecorded(settlementId, { retry: true, idempotencyKey: log.idempotencyKey, client: tx });
    }

    default:
      // auth emails / P2 security notices / support (contact-form) emails /
      // the CUSTOMER-facing return (P3) emails / refund_issued / the
      // PayMongo-webhook refund_completed are not retryable here: they carry
      // time-of-event content (or a single-use provider reference) that must
      // not be regenerated and re-sent later. (Their new _ops companions
      // above ARE retryable — same underlying ReturnRequest, deterministic.)
      return { ok: false, status: "FAILED", error: "not_retryable" };
  }
}

/** `RETURN_REFUND_(INITIATED|COMPLETED)_OPS:<returnId>` → `<returnId>`. */
function returnIdFromOpsKey(key: string): string {
  return key.split(":")[1] ?? "";
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
  reviewedAt: Date | null;
  status: string;
};

/**
 * Options common to the three seller product-request senders. `retry` +
 * `idempotencyKey` are set only by `retryEmailByLog` — the original call sites
 * pass nothing and every event-specific value is reconstructed from the
 * `SellerProductRequest` row (recipient, product/list info, approval state,
 * reviewedAt). `client` threads a transaction client for automated tests.
 */
type SellerRequestEmailOpts = {
  retry?: boolean;
  idempotencyKey?: string;
  client?: Prisma.TransactionClient;
};

async function loadSellerRequestEmailContext(
  requestId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<SellerRequestEmailContext | null> {
  const req = await client.sellerProductRequest.findUnique({
    where: { id: requestId },
    select: {
      proposedName: true,
      reviewStatusNote: true,
      resultProductId: true,
      reviewedAt: true,
      status: true,
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
    reviewedAt: req.reviewedAt,
    status: req.status,
  };
}

/** Seller — "we received your product request". Key: SELLER_PRODUCT_REQUEST_SUBMITTED:<id>. */
export async function sendSellerProductRequestSubmitted(
  requestId: string,
  opts: SellerRequestEmailOpts = {},
): Promise<DispatchResult> {
  try {
    const ctx = await loadSellerRequestEmailContext(requestId, opts.client);
    if (!ctx)
      return failNoRecipient({
        type: "seller_product_request_submitted",
        idempotencyKey: opts.idempotencyKey ?? `SELLER_PRODUCT_REQUEST_SUBMITTED:${requestId}`,
        subject: "Product request received — seller notification",
        client: opts.client,
      });
    return renderAndDispatch(
      {
        type: "seller_product_request_submitted",
        to: ctx.recipients,
        from: SECURITY_FROM,
        idempotencyKey: opts.idempotencyKey ?? `SELLER_PRODUCT_REQUEST_SUBMITTED:${requestId}`,
        retry: opts.retry,
        client: opts.client,
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
 * canonical product was created). Everything is derived from the request row:
 * `reviewedAt` buckets the key so a later review round sends again; `linked` vs
 * "added" comes from whether a `seller_product_request.linked` audit row exists;
 * the "Create listing" deep-link from the result product's ACTIVE variants.
 * Key: SELLER_PRODUCT_REQUEST_APPROVED:<id>:<reviewedAt ms>.
 */
export async function sendSellerProductRequestApproved(
  requestId: string,
  opts: SellerRequestEmailOpts = {},
): Promise<DispatchResult> {
  try {
    const db = opts.client ?? prisma;
    const ctx = await loadSellerRequestEmailContext(requestId, opts.client);
    if (!ctx) {
      const r = await db.sellerProductRequest.findUnique({
        where: { id: requestId },
        select: { reviewedAt: true },
      });
      const ms = (r?.reviewedAt ?? new Date(0)).getTime();
      return failNoRecipient({
        type: "seller_product_request_approved",
        idempotencyKey: opts.idempotencyKey ?? `SELLER_PRODUCT_REQUEST_APPROVED:${requestId}:${ms}`,
        subject: "Product request approved — seller notification",
        client: opts.client,
      });
    }

    const reviewedAt = ctx.reviewedAt ?? new Date();
    const linked =
      (await db.adminAuditLog.count({
        where: {
          targetType: "seller_product_request",
          targetId: requestId,
          action: "seller_product_request.linked",
        },
      })) > 0;

    let listUrl: string | null = null;
    if (ctx.resultProductId) {
      const activeVariants = await db.variant.findMany({
        where: { productId: ctx.resultProductId, status: "ACTIVE" },
        select: { id: true },
        take: 2,
      });
      listUrl =
        activeVariants.length === 1
          ? `/seller/offers/new?variantId=${activeVariants[0].id}`
          : `/seller/offers/new?q=${encodeURIComponent(ctx.productName)}`;
    }

    return renderAndDispatch(
      {
        type: "seller_product_request_approved",
        to: ctx.recipients,
        from: SECURITY_FROM,
        idempotencyKey:
          opts.idempotencyKey ?? `SELLER_PRODUCT_REQUEST_APPROVED:${requestId}:${reviewedAt.getTime()}`,
        retry: opts.retry,
        client: opts.client,
      },
      () =>
        renderSellerProductRequestApproved({
          brand: ctx.brand,
          siteUrl: ctx.siteUrl,
          sellerName: ctx.sellerName,
          productName: ctx.productName,
          requestUrl: ctx.requestUrl,
          linked,
          listUrl: listUrl ? `${ctx.siteUrl}${listUrl}` : null,
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
 * `outcome` is derived from the request's current status (REJECTED → "rejected",
 * otherwise "changes_requested"); the retry path passes it back explicitly since
 * it can read it straight off the log key.
 * Key: SELLER_PRODUCT_REQUEST_REJECTED:<id>:<outcome>:<reviewedAt ms>.
 */
export async function sendSellerProductRequestRejected(
  requestId: string,
  opts: SellerRequestEmailOpts & { outcome?: "rejected" | "changes_requested" } = {},
): Promise<DispatchResult> {
  try {
    const ctx = await loadSellerRequestEmailContext(requestId, opts.client);
    if (!ctx) {
      const r = await (opts.client ?? prisma).sellerProductRequest.findUnique({
        where: { id: requestId },
        select: { reviewedAt: true, status: true },
      });
      const branchOutcome = opts.outcome ?? (r?.status === "REJECTED" ? "rejected" : "changes_requested");
      const ms = (r?.reviewedAt ?? new Date(0)).getTime();
      return failNoRecipient({
        type: "seller_product_request_rejected",
        idempotencyKey:
          opts.idempotencyKey ?? `SELLER_PRODUCT_REQUEST_REJECTED:${requestId}:${branchOutcome}:${ms}`,
        subject: "Product request update — seller notification",
        client: opts.client,
      });
    }

    const outcome = opts.outcome ?? (ctx.status === "REJECTED" ? "rejected" : "changes_requested");
    const reviewedAt = ctx.reviewedAt ?? new Date();

    return renderAndDispatch(
      {
        type: "seller_product_request_rejected",
        to: ctx.recipients,
        from: SECURITY_FROM,
        idempotencyKey:
          opts.idempotencyKey ??
          `SELLER_PRODUCT_REQUEST_REJECTED:${requestId}:${outcome}:${reviewedAt.getTime()}`,
        retry: opts.retry,
        client: opts.client,
      },
      () =>
        renderSellerProductRequestRejected({
          brand: ctx.brand,
          siteUrl: ctx.siteUrl,
          sellerName: ctx.sellerName,
          productName: ctx.productName,
          requestUrl: ctx.requestUrl,
          outcome,
          reviewNote: ctx.reviewNote,
        }),
    );
  } catch (err) {
    console.error("[email] sendSellerProductRequestRejected", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
}

// ---------------------------------------------------------------------------
// Seller account + store-profile lifecycle notifications (Phase 9F-6b)
//
// Account (approved/suspended/closed) and profile-review (approved/rejected)
// go to the seller — same recipient resolution as the product-request emails
// (ACTIVE OWNER/MANAGER SellerUsers + Seller.notifyEmail, deduped). Profile
// SUBMITTED goes to the Axiaro ops inbox instead — never the seller.
// ---------------------------------------------------------------------------

type SellerLifecycleEmailOpts = {
  retry?: boolean;
  idempotencyKey?: string;
  client?: Prisma.TransactionClient;
};

type SellerLifecycleEmailContext = {
  brand: string;
  siteUrl: string;
  sellerName: string;
  recipients: string;
  portalUrl: string;
  settingsUrl: string;
  contentReviewNote: string | null;
};

async function loadSellerLifecycleEmailContext(
  sellerId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<SellerLifecycleEmailContext | null> {
  const seller = await client.seller.findUnique({
    where: { id: sellerId },
    select: {
      displayName: true,
      notifyEmail: true,
      contentReviewNote: true,
      sellerUsers: {
        where: { status: "ACTIVE", role: { in: ["OWNER", "MANAGER"] } },
        select: { user: { select: { email: true } } },
      },
    },
  });
  if (!seller) return null;

  const addrs = new Set<string>();
  for (const su of seller.sellerUsers) {
    const e = su.user.email?.trim().toLowerCase();
    if (e && EMAIL_RE.test(e)) addrs.add(e);
  }
  const notify = seller.notifyEmail?.trim().toLowerCase();
  if (notify && EMAIL_RE.test(notify)) addrs.add(notify);
  if (addrs.size === 0) return null;

  const [brand, siteUrl] = [await getStoreBrand(), getSiteUrl()];
  return {
    brand,
    siteUrl,
    sellerName: seller.displayName,
    recipients: [...addrs].join(", "),
    portalUrl: `${siteUrl}/seller/login`,
    settingsUrl: `${siteUrl}/seller/settings`,
    contentReviewNote: seller.contentReviewNote,
  };
}

/**
 * Seller — account status changed. `auditLogId` is the `adminAuditLog` row the
 * transition itself wrote (its id is the idempotency anchor, NOT
 * `Seller.updatedAt` — an unrelated config edit also bumps that column and
 * must never collide with or suppress a status-change email). Whether an
 * APPROVED email is a first approval or a SUSPENDED→APPROVED reactivation is
 * read back off that same audit row's `action` on every call (including
 * retry) — never a caller-supplied flag — so retry reconstructs it exactly.
 * Key: SELLER_ACCOUNT_APPROVED:<sellerId>:<auditLogId>.
 */
export async function sendSellerAccountApproved(
  sellerId: string,
  auditLogId: string,
  opts: SellerLifecycleEmailOpts = {},
): Promise<DispatchResult> {
  try {
    const db = opts.client ?? prisma;
    const ctx = await loadSellerLifecycleEmailContext(sellerId, opts.client);
    if (!ctx)
      return failNoRecipient({
        type: "seller_account_approved",
        idempotencyKey: opts.idempotencyKey ?? `SELLER_ACCOUNT_APPROVED:${sellerId}:${auditLogId}`,
        subject: "Seller account update — notification",
        client: opts.client,
      });
    const audit = await db.adminAuditLog.findUnique({ where: { id: auditLogId }, select: { action: true } });
    const reactivate = audit?.action === "seller.reactivated";

    return renderAndDispatch(
      {
        type: "seller_account_approved",
        to: ctx.recipients,
        from: SECURITY_FROM,
        idempotencyKey: opts.idempotencyKey ?? `SELLER_ACCOUNT_APPROVED:${sellerId}:${auditLogId}`,
        retry: opts.retry,
        client: opts.client,
      },
      () =>
        renderSellerAccountApproved({
          brand: ctx.brand,
          siteUrl: ctx.siteUrl,
          sellerName: ctx.sellerName,
          portalUrl: ctx.portalUrl,
          reactivate,
        }),
    );
  } catch (err) {
    console.error("[email] sendSellerAccountApproved", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
}

/** Seller — account suspended. Key: SELLER_ACCOUNT_SUSPENDED:<sellerId>:<auditLogId>. */
export async function sendSellerAccountSuspended(
  sellerId: string,
  auditLogId: string,
  opts: SellerLifecycleEmailOpts = {},
): Promise<DispatchResult> {
  try {
    const ctx = await loadSellerLifecycleEmailContext(sellerId, opts.client);
    if (!ctx)
      return failNoRecipient({
        type: "seller_account_suspended",
        idempotencyKey: opts.idempotencyKey ?? `SELLER_ACCOUNT_SUSPENDED:${sellerId}:${auditLogId}`,
        subject: "Seller account update — notification",
        client: opts.client,
      });

    return renderAndDispatch(
      {
        type: "seller_account_suspended",
        to: ctx.recipients,
        from: SECURITY_FROM,
        idempotencyKey: opts.idempotencyKey ?? `SELLER_ACCOUNT_SUSPENDED:${sellerId}:${auditLogId}`,
        retry: opts.retry,
        client: opts.client,
      },
      () =>
        renderSellerAccountSuspended({
          brand: ctx.brand,
          siteUrl: ctx.siteUrl,
          sellerName: ctx.sellerName,
          portalUrl: ctx.portalUrl,
        }),
    );
  } catch (err) {
    console.error("[email] sendSellerAccountSuspended", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
}

/** Seller — account closed (terminal). Key: SELLER_ACCOUNT_CLOSED:<sellerId>:<auditLogId>. */
export async function sendSellerAccountClosed(
  sellerId: string,
  auditLogId: string,
  opts: SellerLifecycleEmailOpts = {},
): Promise<DispatchResult> {
  try {
    const ctx = await loadSellerLifecycleEmailContext(sellerId, opts.client);
    if (!ctx)
      return failNoRecipient({
        type: "seller_account_closed",
        idempotencyKey: opts.idempotencyKey ?? `SELLER_ACCOUNT_CLOSED:${sellerId}:${auditLogId}`,
        subject: "Seller account update — notification",
        client: opts.client,
      });

    return renderAndDispatch(
      {
        type: "seller_account_closed",
        to: ctx.recipients,
        from: SECURITY_FROM,
        idempotencyKey: opts.idempotencyKey ?? `SELLER_ACCOUNT_CLOSED:${sellerId}:${auditLogId}`,
        retry: opts.retry,
        client: opts.client,
      },
      () =>
        renderSellerAccountClosed({
          brand: ctx.brand,
          siteUrl: ctx.siteUrl,
          sellerName: ctx.sellerName,
          portalUrl: ctx.portalUrl,
        }),
    );
  } catch (err) {
    console.error("[email] sendSellerAccountClosed", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
}

/**
 * Seller — store profile approved. Keyed on `Seller.contentReviewedAt` (set
 * only by the review actions, unlike `updatedAt`) plus the resulting state, so
 * a later re-review round can send again but a retry can't dupe.
 * Key: SELLER_PROFILE_APPROVED:<sellerId>:<contentReviewedAt-ms>:APPROVED.
 */
export async function sendSellerProfileApproved(
  sellerId: string,
  opts: SellerLifecycleEmailOpts = {},
): Promise<DispatchResult> {
  try {
    const db = opts.client ?? prisma;
    const row = await db.seller.findUnique({ where: { id: sellerId }, select: { contentReviewedAt: true } });
    const reviewedAt = row?.contentReviewedAt ?? new Date();
    const ctx = await loadSellerLifecycleEmailContext(sellerId, opts.client);
    if (!ctx)
      return failNoRecipient({
        type: "seller_profile_approved",
        idempotencyKey:
          opts.idempotencyKey ?? `SELLER_PROFILE_APPROVED:${sellerId}:${reviewedAt.getTime()}:APPROVED`,
        subject: "Seller profile update — notification",
        client: opts.client,
      });

    return renderAndDispatch(
      {
        type: "seller_profile_approved",
        to: ctx.recipients,
        from: SECURITY_FROM,
        idempotencyKey:
          opts.idempotencyKey ?? `SELLER_PROFILE_APPROVED:${sellerId}:${reviewedAt.getTime()}:APPROVED`,
        retry: opts.retry,
        client: opts.client,
      },
      () =>
        renderSellerProfileApproved({
          brand: ctx.brand,
          siteUrl: ctx.siteUrl,
          sellerName: ctx.sellerName,
          portalUrl: ctx.settingsUrl,
        }),
    );
  } catch (err) {
    console.error("[email] sendSellerProfileApproved", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
}

/**
 * Seller — store profile sent back (PENDING → DRAFT) with a mandatory note.
 * Key: SELLER_PROFILE_REJECTED:<sellerId>:<contentReviewedAt-ms>:DRAFT.
 */
export async function sendSellerProfileRejected(
  sellerId: string,
  opts: SellerLifecycleEmailOpts = {},
): Promise<DispatchResult> {
  try {
    const db = opts.client ?? prisma;
    const row = await db.seller.findUnique({ where: { id: sellerId }, select: { contentReviewedAt: true } });
    const reviewedAt = row?.contentReviewedAt ?? new Date();
    const ctx = await loadSellerLifecycleEmailContext(sellerId, opts.client);
    if (!ctx)
      return failNoRecipient({
        type: "seller_profile_rejected",
        idempotencyKey:
          opts.idempotencyKey ?? `SELLER_PROFILE_REJECTED:${sellerId}:${reviewedAt.getTime()}:DRAFT`,
        subject: "Seller profile update — notification",
        client: opts.client,
      });

    return renderAndDispatch(
      {
        type: "seller_profile_rejected",
        to: ctx.recipients,
        from: SECURITY_FROM,
        idempotencyKey:
          opts.idempotencyKey ?? `SELLER_PROFILE_REJECTED:${sellerId}:${reviewedAt.getTime()}:DRAFT`,
        retry: opts.retry,
        client: opts.client,
      },
      () =>
        renderSellerProfileRejected({
          brand: ctx.brand,
          siteUrl: ctx.siteUrl,
          sellerName: ctx.sellerName,
          portalUrl: ctx.settingsUrl,
          reviewNote: ctx.contentReviewNote,
        }),
    );
  } catch (err) {
    console.error("[email] sendSellerProfileRejected", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
}

/**
 * Axiaro OPERATIONS inbox — a seller's store profile is ready for review.
 * NEVER sent to the seller. Keyed on `Seller.contentSubmittedAt` (dedicated to
 * submission, set only by `submitSellerProfile`) — never `updatedAt`.
 * Key: SELLER_PROFILE_SUBMITTED:<sellerId>:<contentSubmittedAt-ms>.
 */
export async function sendSellerProfileSubmitted(
  sellerId: string,
  opts: SellerLifecycleEmailOpts = {},
): Promise<DispatchResult> {
  try {
    const db = opts.client ?? prisma;
    const seller = await db.seller.findUnique({
      where: { id: sellerId },
      select: { displayName: true, contentSubmittedAt: true },
    });
    if (!seller) return { ok: false, status: "FAILED", error: "no_seller" };
    const submittedAt = seller.contentSubmittedAt ?? new Date();
    const [brand, siteUrl, to] = [await getStoreBrand(), getSiteUrl(), await getSupportInboxEmail()];

    return renderAndDispatch(
      {
        type: "seller_profile_submitted",
        to,
        from: SUPPORT_FROM,
        idempotencyKey:
          opts.idempotencyKey ?? `SELLER_PROFILE_SUBMITTED:${sellerId}:${submittedAt.getTime()}`,
        retry: opts.retry,
        client: opts.client,
      },
      () =>
        renderSellerProfileSubmitted({
          brand,
          siteUrl,
          sellerName: seller.displayName,
          reviewUrl: `${siteUrl}/admin/sellers/${sellerId}`,
        }),
    );
  } catch (err) {
    console.error("[email] sendSellerProfileSubmitted", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
}

// ---------------------------------------------------------------------------
// Seller order / return notifications (Phase 9F-7b)
//
// Both are triggered by an ADMIN action taken on the seller's behalf (parent
// order cancellation; an admin marking a return received) — reuses the exact
// recipient resolution from the account/profile lifecycle emails above. Never
// fired for the seller's OWN self-service actions (e.g. a seller confirming
// their own return receipt already knows — see
// `src/lib/seller/return-actions.ts`).
// ---------------------------------------------------------------------------

/**
 * Seller — a parent order that included this seller's line(s) was cancelled
 * (admin-initiated; there is no seller-initiated cancellation). Keyed on the
 * `SellerOrder.id` itself — a stable, immutable per-line anchor. CANCELLED is
 * terminal (`SELLER_ORDER_STATUS_TRANSITIONS.CANCELLED = []`) and the trigger
 * only ever cascades a SellerOrder into CANCELLED once, so this key can never
 * collide with a later unrelated change — never `Seller.updatedAt`.
 * Key: SELLER_ORDER_CANCELLED:<sellerOrderId>.
 */
export async function sendSellerOrderCancelled(
  sellerOrderId: string,
  opts: SellerLifecycleEmailOpts = {},
): Promise<DispatchResult> {
  try {
    const db = opts.client ?? prisma;
    const so = await db.sellerOrder.findUnique({
      where: { id: sellerOrderId },
      select: { id: true, sellerId: true, order: { select: { orderNumber: true } } },
    });
    if (!so) return { ok: false, status: "FAILED", error: "seller_order_not_found" };
    const ctx = await loadSellerLifecycleEmailContext(so.sellerId, opts.client);
    if (!ctx)
      return failNoRecipient({
        type: "seller_order_cancelled",
        idempotencyKey: opts.idempotencyKey ?? `SELLER_ORDER_CANCELLED:${sellerOrderId}`,
        subject: `Order ${so.order.orderNumber} cancelled — seller notification`,
        client: opts.client,
      });

    // 9F-20: if this cancellation clawed back an already-settled order, add the
    // bookkeeping line. `null` (the norm) → the email is byte-for-byte unchanged.
    const clawback = await clawbackNoteFor(db, {
      sellerOrderIds: [sellerOrderId],
      returnId: null,
      sellerId: so.sellerId,
    });

    return renderAndDispatch(
      {
        type: "seller_order_cancelled",
        to: ctx.recipients,
        from: SECURITY_FROM,
        idempotencyKey: opts.idempotencyKey ?? `SELLER_ORDER_CANCELLED:${sellerOrderId}`,
        retry: opts.retry,
        client: opts.client,
      },
      () =>
        renderSellerOrderCancelled({
          brand: ctx.brand,
          siteUrl: ctx.siteUrl,
          sellerName: ctx.sellerName,
          orderNumber: so.order.orderNumber,
          ordersUrl: `${ctx.siteUrl}/seller/orders`,
          clawback,
        }),
    );
  } catch (err) {
    console.error("[email] sendSellerOrderCancelled", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
}

/**
 * The distinct seller ids (snapshotted on `OrderItem.sellerId` — never
 * re-derived from a possibly-deleted `Offer`) whose lines are part of a
 * return. Used by the RECEIVED trigger to know which sellers to notify.
 */
export async function getReturnAffectedSellerIds(
  returnId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<string[]> {
  const rows = await client.returnItem.findMany({
    where: { returnRequestId: returnId },
    select: { orderItem: { select: { sellerId: true } } },
  });
  return [...new Set(rows.map((r) => r.orderItem.sellerId).filter((v): v is string => Boolean(v)))];
}

/**
 * Seller — a return covering (at least) one of its lines was received back.
 * Admin-triggered only (`markReceivedAction`) — the seller's OWN receipt
 * confirmation (`sellerReceiveReturnAction`) does not call this, since the
 * seller already knows. Keyed on `(returnId, sellerId)`: `ReturnRequest`
 * status transitions are forward-only and guarded one-shot (same class of
 * protection the sibling customer key `RETURN_RECEIVED:<id>` already relies
 * on), so no extra timestamp is needed — never `Seller.updatedAt`.
 * Key: SELLER_RETURN_RECEIVED:<returnId>:<sellerId>.
 */
export async function sendSellerReturnReceived(
  returnId: string,
  sellerId: string,
  opts: SellerLifecycleEmailOpts = {},
): Promise<DispatchResult> {
  try {
    const db = opts.client ?? prisma;
    const ret = await db.returnRequest.findUnique({
      where: { id: returnId },
      select: { id: true, returnNumber: true, order: { select: { orderNumber: true } } },
    });
    if (!ret) return { ok: false, status: "FAILED", error: "return_not_found" };
    const ctx = await loadSellerLifecycleEmailContext(sellerId, opts.client);
    if (!ctx)
      return failNoRecipient({
        type: "seller_return_received",
        idempotencyKey: opts.idempotencyKey ?? `SELLER_RETURN_RECEIVED:${returnId}:${sellerId}`,
        subject: `Return ${ret.returnNumber} received — seller notification`,
        client: opts.client,
      });
    const items = await db.returnItem.findMany({
      where: { returnRequestId: returnId, orderItem: { sellerId } },
      select: {
        name: true,
        variantLabel: true,
        quantity: true,
        orderItem: { select: { sellerOrderId: true } },
      },
    });
    if (items.length === 0) return { ok: false, status: "FAILED", error: "no_seller_lines" };

    // 9F-20: if this return clawed back an already-settled order, add the
    // bookkeeping line. `null` (the norm) → the email is byte-for-byte unchanged.
    const soIds = [...new Set(items.map((i) => i.orderItem?.sellerOrderId).filter((v): v is string => !!v))];
    const clawback = await clawbackNoteFor(db, { sellerOrderIds: soIds, returnId, sellerId });

    return renderAndDispatch(
      {
        type: "seller_return_received",
        to: ctx.recipients,
        from: SECURITY_FROM,
        idempotencyKey: opts.idempotencyKey ?? `SELLER_RETURN_RECEIVED:${returnId}:${sellerId}`,
        retry: opts.retry,
        client: opts.client,
      },
      () =>
        renderSellerReturnReceived({
          brand: ctx.brand,
          siteUrl: ctx.siteUrl,
          sellerName: ctx.sellerName,
          orderNumber: ret.order.orderNumber,
          returnNumber: ret.returnNumber,
          ordersUrl: `${ctx.siteUrl}/seller/orders`,
          returnsUrl: `${ctx.siteUrl}/seller/returns`,
          items: items.map((i) => ({ name: i.name, variantLabel: i.variantLabel, quantity: i.quantity })),
          clawback,
        }),
    );
  } catch (err) {
    console.error("[email] sendSellerReturnReceived", err);
    return { ok: false, status: "FAILED", error: "unexpected" };
  }
}

// ---------------------------------------------------------------------------
// Seller settlement + clawback notifications (Phase 9F-20)
// ---------------------------------------------------------------------------

/**
 * 9F-20 — total clawback (centavos) for ONE clawback event, read back from the
 * durable `seller.settlement.clawback_accrued` audit rows the accrual sites
 * write post-commit. Deterministic and retry-safe (the audit rows persist);
 * returns `null` when nothing was clawed back (the common case) or when the
 * audit write did not land — the seller email then renders exactly as before.
 *
 *   returnId set   → the post-settlement return path (match on meta.returnId)
 *   returnId null  → the post-settlement cancellation path (match on meta.returnId == null)
 */
async function clawbackNoteFor(
  db: Prisma.TransactionClient | typeof prisma,
  match: { sellerOrderIds: string[]; returnId: string | null; sellerId: string },
): Promise<ClawbackNote> {
  if (match.sellerOrderIds.length === 0) return null;
  const rows = await db.adminAuditLog.findMany({
    where: {
      action: "seller.settlement.clawback_accrued",
      targetType: "seller_order",
      targetId: { in: match.sellerOrderIds },
    },
    select: { meta: true },
  });
  let total = 0;
  for (const r of rows) {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(r.meta ?? "{}") as Record<string, unknown>;
    } catch {
      continue;
    }
    if (m.sellerId !== match.sellerId) continue;
    if (match.returnId ? m.returnId !== match.returnId : m.returnId != null) continue;
    if (typeof m.clawbackDelta === "number") total += m.clawbackDelta;
  }
  if (total <= 0) return null;
  return { amount: total, reason: match.returnId ? "return" : "cancellation" };
}

/**
 * Seller — Axiaro recorded a bookkeeping settlement covering this THIRD_PARTY
 * seller's delivered, return-window-elapsed orders (plus any outstanding
 * clawbacks netted in). One email per `SellerSettlement`. Bookkeeping only — the
 * copy never implies Axiaro/PayMongo moved money; an admin-entered external
 * payment method/reference is shown as "how it was paid outside the platform".
 * Amounts come straight off the `SellerSettlement` row (9F-19 locked formula,
 * recomputed server-side by `recordSettlement`).
 * Key: SETTLEMENT_RECORDED:<settlementId>.
 */
export async function sendSellerSettlementRecorded(
  settlementId: string,
  opts: SellerLifecycleEmailOpts = {},
): Promise<DispatchResult> {
  try {
    const db = opts.client ?? prisma;
    const s = await db.sellerSettlement.findUnique({
      where: { id: settlementId },
      select: {
        id: true,
        sellerId: true,
        grossReceivable: true,
        commissionAmount: true,
        clawbackAmount: true,
        netAmount: true,
        orderCount: true,
        clawbackCount: true,
        paidAt: true,
        paymentMethod: true,
        paymentReference: true,
        note: true,
      },
    });
    if (!s) return { ok: false, status: "FAILED", error: "settlement_not_found" };
    const ctx = await loadSellerLifecycleEmailContext(s.sellerId, opts.client);
    if (!ctx)
      return failNoRecipient({
        type: "seller_settlement_recorded",
        idempotencyKey: opts.idempotencyKey ?? `SETTLEMENT_RECORDED:${s.id}`,
        subject: "Settlement recorded — seller notification",
        client: opts.client,
      });

    return renderAndDispatch(
      {
        type: "seller_settlement_recorded",
        to: ctx.recipients,
        from: SECURITY_FROM,
        idempotencyKey: opts.idempotencyKey ?? `SETTLEMENT_RECORDED:${s.id}`,
        retry: opts.retry,
        client: opts.client,
      },
      () =>
        renderSellerSettlementRecorded({
          brand: ctx.brand,
          siteUrl: ctx.siteUrl,
          sellerName: ctx.sellerName,
          settlementUrl: `${ctx.siteUrl}/seller/settlements/${s.id}`,
          paidAt: s.paidAt ? s.paidAt.toISOString().slice(0, 10) : null,
          grossReceivable: s.grossReceivable,
          commissionAmount: s.commissionAmount,
          clawbackAmount: s.clawbackAmount,
          netAmount: s.netAmount,
          orderCount: s.orderCount,
          clawbackCount: s.clawbackCount,
          paymentMethod: s.paymentMethod,
          paymentReference: s.paymentReference,
          note: s.note,
        }),
    );
  } catch (err) {
    console.error("[email] sendSellerSettlementRecorded", err);
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
