/**
 * SellerOrder fulfilment state machine (Phase 9F-2) — PURE, framework-free.
 *
 * This is the seller plane's OWN fulfilment status (`SellerOrder.status`, defined
 * on the model in 9E-3C-1). It is SEPARATE from `Order.status` (the customer-
 * facing timeline the admin drives) — 9F-2 never touches `Order.status`, its
 * events, courier/tracking columns, or any customer-visible field. The parent-
 * order rollup is a later phase (9E-3E).
 *
 * Vocabulary (exactly the model comment):
 *   PENDING_PAYMENT | PROCESSING | READY_TO_SHIP | SHIPPED | DELIVERED | CANCELLED
 *
 * Seller-driven transitions:
 *   PENDING_PAYMENT → PROCESSING       "accept" — only once the PARENT order is
 *                                      payment-cleared (Order.status is a
 *                                      fulfilment status, not PENDING_PAYMENT)
 *   PROCESSING      → READY_TO_SHIP    picked & packed
 *   READY_TO_SHIP   → SHIPPED          requires a Shipment (carrier + tracking,
 *                                      unless the carrier needs no tracking)
 *   READY_TO_SHIP   → PROCESSING       un-ready (nothing dispatched yet)
 *   SHIPPED         → DELIVERED        confirmed delivered
 *
 * CANCELLED is terminal and is NEVER set by the seller plane in 9F-2 — an order
 * is cancelled on the customer / admin side. A SellerOrder whose parent Order is
 * CANCELLED offers no transitions.
 */

export const SELLER_ORDER_STATUSES = [
  "PENDING_PAYMENT",
  "PROCESSING",
  "READY_TO_SHIP",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
] as const;

export type SellerOrderStatus = (typeof SELLER_ORDER_STATUSES)[number];

export function isSellerOrderStatus(v: string): v is SellerOrderStatus {
  return (SELLER_ORDER_STATUSES as readonly string[]).includes(v);
}

export const SELLER_ORDER_STATUS_TRANSITIONS: Record<SellerOrderStatus, SellerOrderStatus[]> = {
  PENDING_PAYMENT: ["PROCESSING"],
  PROCESSING: ["READY_TO_SHIP"],
  READY_TO_SHIP: ["SHIPPED", "PROCESSING"],
  SHIPPED: ["DELIVERED"],
  DELIVERED: [],
  CANCELLED: [],
};

/**
 * Parent `Order.status` values that permit the seller to work the order. Payment
 * confirmation / cancellation stay entirely on the parent order (admin + the
 * deferred payment step) — the seller can only fulfil an order the platform has
 * already accepted.
 */
export const PARENT_ORDER_FULFILLABLE = [
  "PROCESSING",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
] as const;

export function isParentOrderFulfillable(parentOrderStatus: string): boolean {
  return (PARENT_ORDER_FULFILLABLE as readonly string[]).includes(parentOrderStatus);
}

/**
 * Server-side guard for a seller status change.
 *   - `to` must be a declared forward move from `from`
 *   - the parent order must be in a fulfillable state
 *   - `SHIPPED` additionally requires `hasShipment` (a carrier + tracking bundle),
 *     enforced by the caller which passes the flag
 */
export function canTransitionSellerOrder(
  from: string,
  to: string,
  opts: { parentOrderStatus: string; hasShippableShipment?: boolean },
): boolean {
  if (!isSellerOrderStatus(from) || !isSellerOrderStatus(to)) return false;
  if (!isParentOrderFulfillable(opts.parentOrderStatus)) return false;
  if (!SELLER_ORDER_STATUS_TRANSITIONS[from].includes(to)) return false;
  if (to === "SHIPPED" && !opts.hasShippableShipment) return false;
  return true;
}

/** The moves to offer in the portal for a given state. */
export function allowedSellerOrderMoves(
  from: string,
  opts: { parentOrderStatus: string },
): SellerOrderStatus[] {
  if (!isSellerOrderStatus(from)) return [];
  if (!isParentOrderFulfillable(opts.parentOrderStatus)) return [];
  return [...SELLER_ORDER_STATUS_TRANSITIONS[from]];
}

const LABELS: Record<string, string> = {
  PENDING_PAYMENT: "Awaiting confirmation",
  PROCESSING: "Preparing",
  READY_TO_SHIP: "Ready to ship",
  SHIPPED: "Shipped",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
};

export function sellerOrderStatusLabel(status: string): string {
  return LABELS[status] ?? status;
}

type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

export function sellerOrderStatusTone(status: string): BadgeTone {
  switch (status) {
    case "DELIVERED":
      return "success";
    case "SHIPPED":
    case "READY_TO_SHIP":
      return "info";
    case "PROCESSING":
      return "warning";
    case "CANCELLED":
      return "danger";
    default:
      return "neutral";
  }
}

// --- Shipment ---------------------------------------------------------------

export const SHIPMENT_STATUSES = ["PENDING", "SHIPPED", "DELIVERED"] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

/** The shipment status that mirrors a seller-order status, or null (no change). */
export function shipmentStatusForSellerOrder(sellerOrderStatus: string): ShipmentStatus | null {
  if (sellerOrderStatus === "SHIPPED") return "SHIPPED";
  if (sellerOrderStatus === "DELIVERED") return "DELIVERED";
  return null;
}
