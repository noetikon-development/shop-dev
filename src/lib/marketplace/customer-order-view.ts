import { sellerCanCancelSellerOrder } from "@/lib/marketplace/seller-order-status";

/**
 * Pure, presentation-support helpers for the customer-facing order/return
 * pages (multi-seller UI phase). No I/O, no business rule of their own — each
 * one composes an ALREADY-canonical signal (never a new eligibility rule) so
 * the UI can never drift from what the server actually enforces:
 *   - `allSellerOrdersCancellable` reuses the exact `sellerCanCancelSellerOrder`
 *     gate the cancellation safety fix (`orders/cancellation.ts`) already uses
 *     server-side.
 *   - `hasUndeliveredSellerLines` / `groupOrderItemsBySeller` only describe
 *     already-fetched `SellerOrder.status` data for display; they never touch
 *     `returnEligibility()` or change which items the server accepts.
 */

export type CustomerOrderSellerOrder = {
  id: string;
  sellerName: string;
  sellerType: string;
  status: string;
  // Store Pickup order-confirmation display (9F-49 confirmation-page step).
  // The historical, frozen-at-order-time pickup location for THIS SellerOrder
  // — never the live PickupLocation row. NULL for non-PICKUP orders.
  pickupLocationId?: string | null;
  pickupLocationSnapshot?: unknown;
  shipments: {
    carrier: string | null;
    carrierName: string | null;
    trackingNumber: string | null;
    trackingUrl: string | null;
    shippedAt: Date | null;
    deliveredAt: Date | null;
  }[];
};

/** Whether a customer could cancel the WHOLE order right now — mirrors the
 *  server's own per-SellerOrder gate exactly (all-or-nothing, same as
 *  `orders/cancellation.ts`'s `SellerOrderNotCancellableError` check). An
 *  order with no SellerOrders (a legacy pre-marketplace row) is vacuously
 *  true here, matching `[].every(...)` — the caller still gates on
 *  `isCancellable(order.status)` first, unchanged. */
export function allSellerOrdersCancellable(sellerOrders: { status: string }[]): boolean {
  return sellerOrders.every((so) => sellerCanCancelSellerOrder(so.status));
}

/** Whether at least one SellerOrder on a genuinely multi-seller order hasn't
 *  delivered yet — used only to decide whether to show a short explanatory
 *  note when a return is eligible but not every line on the order is (yet)
 *  part of it. A single-seller (or legacy, zero-SellerOrder) order never
 *  shows this note — it's not needed there. */
export function hasUndeliveredSellerLines(sellerOrders: { status: string }[]): boolean {
  return sellerOrders.length > 1 && sellerOrders.some((so) => so.status !== "DELIVERED");
}

export type OrderSellerGroup<T> = {
  sellerOrder: CustomerOrderSellerOrder;
  items: T[];
};

/**
 * Group an order's items by their owning SellerOrder, for the customer-facing
 * multi-seller item list. Items with no matching SellerOrder (a legacy line
 * predating the marketplace backfill, or an id that doesn't resolve) are
 * returned separately in `ungrouped` rather than silently dropped.
 */
export function groupOrderItemsBySeller<T extends { sellerOrderId: string | null }>(
  items: T[],
  sellerOrders: CustomerOrderSellerOrder[],
): { groups: OrderSellerGroup<T>[]; ungrouped: T[] } {
  const groups: OrderSellerGroup<T>[] = sellerOrders
    .map((so) => ({ sellerOrder: so, items: items.filter((it) => it.sellerOrderId === so.id) }))
    .filter((g) => g.items.length > 0);
  const groupedIds = new Set(sellerOrders.map((so) => so.id));
  const ungrouped = items.filter((it) => !it.sellerOrderId || !groupedIds.has(it.sellerOrderId));
  return { groups, ungrouped };
}
