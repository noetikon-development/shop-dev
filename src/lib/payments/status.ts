/**
 * Payment / PayMongo state machine (Step 21 P4, Phase 4-A). Pure data + pure
 * functions — safe to import from server, client and edge code. Mirrors the
 * shape of `src/lib/orders/status.ts` and `src/lib/returns/status.ts`.
 *
 * Phase 4-A is DORMANT: online payment is gated off, no PayMongo API is called,
 * and no Payment row can ever be created. These values describe the machine the
 * webhook will drive once Phase 4-B enables it.
 */

// ---------------------------------------------------------------------------
// Payment.status
// ---------------------------------------------------------------------------

export const PAYMENT_STATUSES = [
  "PENDING", // row created, checkout session not yet made
  "AWAITING_PAYMENT", // hosted session created, customer paying
  "PAID", // verified webhook: money captured
  "FAILED", // verified webhook: payment declined
  "EXPIRED", // session TTL elapsed with no payment
  "CANCELLED", // order cancelled before payment
  "REFUND_PENDING", // a refund has been requested but not yet settled
  "PARTIALLY_REFUNDED", // Σ succeeded refunds < amount
  "REFUNDED", // Σ succeeded refunds == amount
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export function isPaymentStatus(v: string): v is PaymentStatus {
  return (PAYMENT_STATUSES as readonly string[]).includes(v);
}

/** Statuses that count as "this order has a live/settled payment attempt". */
export const ACTIVE_PAYMENT_STATUSES: PaymentStatus[] = [
  "PENDING",
  "AWAITING_PAYMENT",
  "PAID",
  "PARTIALLY_REFUNDED",
];

/** A payment attempt the customer could still complete. */
export function isOpenPaymentStatus(status: string): boolean {
  return status === "PENDING" || status === "AWAITING_PAYMENT";
}

/** Money has been captured (fully or partly still ours). */
export function isPaidPaymentStatus(status: string): boolean {
  return status === "PAID" || status === "PARTIALLY_REFUNDED";
}

/**
 * Valid forward transitions. Retrying a FAILED / EXPIRED payment does NOT
 * transition the row — it creates a new Payment row for the same order.
 */
export const PAYMENT_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  PENDING: ["AWAITING_PAYMENT", "CANCELLED", "EXPIRED"],
  AWAITING_PAYMENT: ["PAID", "FAILED", "EXPIRED", "CANCELLED"],
  PAID: ["REFUND_PENDING", "PARTIALLY_REFUNDED", "REFUNDED"],
  REFUND_PENDING: ["PARTIALLY_REFUNDED", "REFUNDED", "PAID"], // PAID = refund failed, back to normal
  PARTIALLY_REFUNDED: ["REFUND_PENDING", "REFUNDED"],
  FAILED: [],
  EXPIRED: [],
  CANCELLED: [],
  REFUNDED: [],
};

export function canTransitionPayment(from: string, to: string): boolean {
  if (!isPaymentStatus(from) || !isPaymentStatus(to)) return false;
  return PAYMENT_TRANSITIONS[from].includes(to);
}

export const PAYMENT_STATUS_LABEL: Record<string, string> = {
  PENDING: "Not started",
  AWAITING_PAYMENT: "Awaiting payment",
  PAID: "Paid",
  FAILED: "Failed",
  EXPIRED: "Expired",
  CANCELLED: "Cancelled",
  REFUND_PENDING: "Refund pending",
  PARTIALLY_REFUNDED: "Partially refunded",
  REFUNDED: "Refunded",
};

export function paymentStatusLabel(status: string): string {
  return PAYMENT_STATUS_LABEL[status] ?? status;
}

type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

export function paymentStatusTone(status: string): BadgeTone {
  switch (status) {
    case "PAID":
      return "success";
    case "AWAITING_PAYMENT":
    case "PENDING":
    case "REFUND_PENDING":
      return "warning";
    case "PARTIALLY_REFUNDED":
    case "REFUNDED":
      return "info";
    case "FAILED":
    case "EXPIRED":
    case "CANCELLED":
      return "danger";
    default:
      return "neutral";
  }
}

// ---------------------------------------------------------------------------
// PaymentRefund.status
// ---------------------------------------------------------------------------

export const PAYMENT_REFUND_STATUSES = ["PENDING", "PROCESSING", "SUCCEEDED", "FAILED"] as const;
export type PaymentRefundStatus = (typeof PAYMENT_REFUND_STATUSES)[number];

export function isPaymentRefundStatus(v: string): v is PaymentRefundStatus {
  return (PAYMENT_REFUND_STATUSES as readonly string[]).includes(v);
}

export const PAYMENT_REFUND_STATUS_LABEL: Record<string, string> = {
  PENDING: "Pending",
  PROCESSING: "Processing",
  SUCCEEDED: "Succeeded",
  FAILED: "Failed",
};

// ---------------------------------------------------------------------------
// Order.paymentStatus — extend the existing vocabulary with PARTIALLY_REFUNDED.
// The Order.paymentStatus column is a free-form string; this is the display map.
// P4 only ever writes it from a verified webhook (never manually, never inferred).
// ---------------------------------------------------------------------------

export const ORDER_PAYMENT_STATUS_LABEL: Record<string, string> = {
  PENDING: "Awaiting payment",
  UNPAID: "Unpaid",
  PAID: "Paid",
  PARTIALLY_REFUNDED: "Partially refunded",
  REFUNDED: "Refunded",
};

// ---------------------------------------------------------------------------
// Provider method → the existing Order.paymentMethod vocabulary (COD|CARD|GCASH|NONE)
// ---------------------------------------------------------------------------

/** Map a PayMongo payment-method type onto the store's coarse method label. */
export function orderPaymentMethodFromProvider(providerMethod: string | null | undefined): string {
  switch ((providerMethod ?? "").toLowerCase()) {
    case "gcash":
      return "GCASH";
    case "card":
    case "paymaya":
    case "grab_pay":
    case "dob":
    case "billease":
      return "CARD"; // closest bucket in the existing enum
    default:
      return "NONE";
  }
}

// ---------------------------------------------------------------------------
// Webhook event types this integration handles. Anything else is acknowledged
// and marked IGNORED so the provider stops retrying.
// ---------------------------------------------------------------------------

export const HANDLED_WEBHOOK_TYPES = [
  "checkout_session.payment.paid",
  "payment.paid",
  "payment.failed",
  "checkout_session.expired",
  "refund.updated",
] as const;

export type HandledWebhookType = (typeof HANDLED_WEBHOOK_TYPES)[number];

export function isHandledWebhookType(t: string): t is HandledWebhookType {
  return (HANDLED_WEBHOOK_TYPES as readonly string[]).includes(t);
}
