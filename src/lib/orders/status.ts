/**
 * Order status — the single source of truth for the admin fulfilment workflow
 * (Step 12). Pure data + pure functions, safe to import from server, client and
 * edge code.
 *
 * This does NOT introduce a new status system. The values below are exactly the
 * ones already used by the schema (`Order.status`), the checkout flow and the
 * storefront timeline (`ORDER_STATUS_FLOW` / `ORDER_STATUS_META` in
 * `@/lib/constants`). Step 12 only adds the transition rules an admin may drive.
 *
 * Payment stays deferred (Step 10): an admin can NOT move an order to PAID —
 * there is no manual payment mechanism, and we never fake one.
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

/** Whole set of moves offered in the admin UI (forward + cancel where valid). */
export function allowedNextStatuses(from: string): OrderStatus[] {
  if (!isOrderStatus(from)) return [];
  const forward = ORDER_STATUS_TRANSITIONS[from];
  const canCancel = CANCELLABLE_STATUSES.includes(from);
  return canCancel ? [...forward, "CANCELLED"] : [...forward];
}

/** Server-side guard for a status change request. */
export function canTransition(from: string, to: string): boolean {
  if (!isOrderStatus(from) || !isOrderStatus(to)) return false;
  if (to === "PAID") return false; // payment confirmation is deferred — never by hand
  if (to === "CANCELLED") return CANCELLABLE_STATUSES.includes(from);
  return ORDER_STATUS_TRANSITIONS[from].includes(to);
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
