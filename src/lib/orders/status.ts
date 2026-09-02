/**
 * Order status — the single source of truth for the admin fulfilment workflow
 * (Step 12; fulfilment/courier/tracking added in Step 13). Pure data + pure
 * functions, safe to import from server, client and edge code.
 *
 * This does NOT introduce a new status system. The values below are exactly the
 * ones already used by the schema (`Order.status`), the checkout flow and the
 * storefront timeline (`ORDER_STATUS_FLOW` / `ORDER_STATUS_META` in
 * `@/lib/constants`). The "fulfilment status" IS `Order.status` — there is no
 * separate fulfilment enum.
 *
 * Payment stays deferred (Step 10): an admin can NOT move an order to PAID —
 * there is no manual payment mechanism, and we never fake one.
 *
 * Phase 7B adds ONE scoped relaxation: a "Confirm order" admin action may move
 * an order from PENDING_PAYMENT to PROCESSING when it carries no online payment
 * (cash / pay-on-delivery). It does NOT touch payment status and never implies
 * money changed hands — see `confirmOrderAction`. An order with an online
 * Payment row is still only ever confirmed by the verified PayMongo webhook.
 */

import { ORDER_STATUS_META } from "@/lib/constants";

/** Every status an order can hold, as already defined on the model. */
export const ORDER_STATUSES = [
  "PENDING_PAYMENT",
  "PENDING",
  "PAID",
  "PROCESSING",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "CANCELLED",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export function isOrderStatus(value: string): value is OrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(value);
}

/** Payment statuses already used by the model / checkout. Display only. */
export const PAYMENT_STATUS_LABEL: Record<string, string> = {
  PENDING: "Awaiting payment",
  UNPAID: "Unpaid",
  PAID: "Paid",
  REFUNDED: "Refunded",
};

/**
 * Forward status transitions an admin with `manage_orders` may perform.
 *
 * PENDING_PAYMENT has NO forward move: the natural next step is PAID, and
 * confirming payment belongs to the deferred payment step — an admin must not
 * mark an order paid by hand. Cancellation is a separate action (see
 * `CANCELLABLE_STATUSES`), not listed here.
 */
export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING_PAYMENT: [],
  PENDING: ["PROCESSING"],
  PAID: ["PROCESSING"],
  PROCESSING: ["SHIPPED"],
  SHIPPED: ["OUT_FOR_DELIVERY", "DELIVERED"],
  OUT_FOR_DELIVERY: ["DELIVERED"],
  DELIVERED: [],
  CANCELLED: [],
};

/**
 * Statuses from which an order may still be cancelled. Once goods are dispatched
 * (SHIPPED and later) or the order is already terminal, cancellation is not
 * offered. PAID is excluded: cancelling a paid order implies a refund, and
 * refunds are part of the deferred payment step.
 */
export const CANCELLABLE_STATUSES: OrderStatus[] = [
  "PENDING_PAYMENT",
  "PENDING",
  "PROCESSING",
];

/**
 * The fulfilment milestones. Transitions INTO these go through the dedicated
 * Step 13 fulfilment actions (which capture courier / tracking / timestamps),
 * never the generic status action.
 */
export const FULFILLMENT_STATUSES: OrderStatus[] = [
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
];

export function isFulfillmentStatus(status: string): boolean {
  return (FULFILLMENT_STATUSES as string[]).includes(status);
}

/** Whole set of moves offered in the admin UI (forward + cancel where valid). */
export function allowedNextStatuses(
  from: string,
  opts?: { storePickup?: boolean },
): OrderStatus[] {
  if (!isOrderStatus(from)) return [];
  const forward = [...ORDER_STATUS_TRANSITIONS[from]];
  // Store-pickup orders never go through SHIPPED / OUT_FOR_DELIVERY — they go
  // straight from PROCESSING to DELIVERED (collected).
  if (opts?.storePickup && from === "PROCESSING" && !forward.includes("DELIVERED")) {
    forward.push("DELIVERED");
  }
  const canCancel = CANCELLABLE_STATUSES.includes(from);
  return canCancel ? [...forward, "CANCELLED"] : forward;
}

/**
 * Server-side guard for a status change request.
 *
 * - `storePickup` allows the single extra transition PROCESSING → DELIVERED (a
 *   collected pickup order).
 * - `codConfirm` allows the single extra transition PENDING_PAYMENT → PROCESSING
 *   for the "Confirm order" action on an order with no online payment. The
 *   caller (`confirmOrderAction`) is responsible for verifying there is no
 *   active Payment row before passing this.
 *
 * Neither flag relaxes anything else, and `to === "PAID"` is always rejected.
 */
export function canTransition(
  from: string,
  to: string,
  opts?: { storePickup?: boolean; codConfirm?: boolean },
): boolean {
  if (!isOrderStatus(from) || !isOrderStatus(to)) return false;
  if (to === "PAID") return false; // payment confirmation is deferred — never by hand
  if (to === "CANCELLED") return CANCELLABLE_STATUSES.includes(from);
  if (opts?.storePickup && from === "PROCESSING" && to === "DELIVERED") return true;
  if (opts?.codConfirm && from === "PENDING_PAYMENT" && to === "PROCESSING") return true;
  return ORDER_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * True when the "Confirm order" (pay-on-delivery) action applies: the order is
 * still PENDING_PAYMENT. The caller must ALSO confirm there is no active online
 * Payment before offering / performing the action.
 */
export function isConfirmablePendingPayment(from: string): boolean {
  return from === "PENDING_PAYMENT";
}

export function isCancellable(from: string): boolean {
  return isOrderStatus(from) && CANCELLABLE_STATUSES.includes(from);
}

export function orderStatusLabel(status: string): string {
  return ORDER_STATUS_META[status]?.label ?? status;
}

type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

/** Map the storefront meta tone onto the admin StatusBadge tones. */
export function orderStatusTone(status: string): BadgeTone {
  switch (ORDER_STATUS_META[status]?.tone) {
    case "positive":
      return "success";
    case "progress":
      return "info";
    case "negative":
      return "danger";
    default:
      return "neutral";
  }
}

export function paymentStatusTone(paymentStatus: string): BadgeTone {
  switch (paymentStatus) {
    case "PAID":
      return "success";
    case "REFUNDED":
      return "info";
    case "PENDING":
      return "warning";
    default:
      return "neutral";
  }
}
