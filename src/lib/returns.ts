import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { SETTING_FIELD_BY_KEY, decodeSettingValue } from "@/lib/admin/settings-registry";

/**
 * Returns / RMA — server-only domain logic (Step 21 P3).
 *
 * Eligibility, remaining-returnable maths and return-number generation. All
 * reads here are UNCACHED (customers and admins see live state) and every query
 * that can be reached by a customer is scoped by `userId` at the call site.
 *
 * Nothing in this module mutates Order / OrderItem / Variant / Inventory.
 */

type Client = Prisma.TransactionClient | typeof prisma;

// ---------------------------------------------------------------------------
// Configuration (Store Settings — read uncached, safe outside a request scope)
// ---------------------------------------------------------------------------

export type ReturnsConfig = {
  windowDays: number;
  instructions: string;
  policyUrl: string;
};

const DEFAULT_WINDOW_DAYS = Number(SETTING_FIELD_BY_KEY["returns.windowDays"]?.default ?? 30);

export async function getReturnsConfig(): Promise<ReturnsConfig> {
  try {
    const rows = await prisma.storeSetting.findMany({
      where: { key: { in: ["returns.windowDays", "returns.instructions", "returns.policyUrl"] } },
      select: { key: true, value: true },
    });
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    const windowRaw = byKey.get("returns.windowDays");
    const windowDays =
      windowRaw != null
        ? Number(decodeSettingValue(windowRaw, "number"))
        : DEFAULT_WINDOW_DAYS;
    return {
      windowDays: Number.isFinite(windowDays) && windowDays > 0 ? Math.floor(windowDays) : DEFAULT_WINDOW_DAYS,
      instructions: (byKey.get("returns.instructions") ?? "").trim(),
      policyUrl: (byKey.get("returns.policyUrl") ?? "").trim(),
    };
  } catch {
    return { windowDays: DEFAULT_WINDOW_DAYS, instructions: "", policyUrl: "" };
  }
}

// ---------------------------------------------------------------------------
// Return-number generation — RET-<YYMMDD>-<nextval>. `return_number_seq` starts
// at 100001, so the suffix is always 6+ digits.
// ---------------------------------------------------------------------------

export async function nextReturnNumber(client: Client = prisma): Promise<string> {
  const d = new Date();
  const stamp = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}${String(
    d.getDate(),
  ).padStart(2, "0")}`;
  const rows = await client.$queryRaw<{ v: bigint }[]>`SELECT nextval('return_number_seq') AS v`;
  return `RET-${stamp}-${String(rows[0].v).padStart(5, "0")}`;
}

// ---------------------------------------------------------------------------
// Remaining-returnable quantity per order line
// ---------------------------------------------------------------------------

/**
 * For every OrderItem of `orderId`, how many units may still be returned:
 *   ordered quantity − Σ(ReturnItem.quantity on returns NOT rejected/cancelled)
 *
 * A REJECTED or CANCELLED return frees its quantity again; a RECEIVED /
 * REFUND_COMPLETED one does not.
 */
export async function remainingReturnableByOrderItem(
  orderId: string,
  client: Client = prisma,
): Promise<Map<string, number>> {
  const items = await client.orderItem.findMany({
    where: { orderId },
    select: { id: true, quantity: true },
  });

  const consumed = await client.returnItem.groupBy({
    by: ["orderItemId"],
    where: {
      orderItem: { orderId },
      returnRequest: { status: { notIn: ["REJECTED", "CANCELLED"] } },
    },
    _sum: { quantity: true },
  });
  const consumedByItem = new Map(consumed.map((c) => [c.orderItemId, c._sum.quantity ?? 0]));

  const out = new Map<string, number>();
  for (const it of items) {
    out.set(it.id, Math.max(0, it.quantity - (consumedByItem.get(it.id) ?? 0)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-item delivery state (multi-seller-aware)
// ---------------------------------------------------------------------------

/** The parent-Order fields `orderItemDeliveryState` needs — a subset of `Order`. */
export type ReturnEligibilityOrder = {
  status: string;
  deliveredAt: Date | null;
  placedAt: Date;
};

/** The owning SellerOrder's fields, or `null` for a pre-marketplace legacy line
 *  (`OrderItem.sellerOrderId` predates the 9E-3C-1 backfill). */
export type ReturnEligibilitySellerOrder = {
  status: string;
  shipments: { deliveredAt: Date | null }[];
} | null;

/**
 * Whether a single `OrderItem` is itself "delivered" for return-eligibility
 * purposes, and the timestamp its own return window should count from.
 *
 * A marketplace-era line (its `sellerOrder` is present) is judged by ITS OWN
 * `SellerOrder.status` — never the aggregate parent `Order.status`, which can
 * legitimately still read PROCESSING while a sibling SellerOrder lags behind
 * (the 9F-12b / 9F-35B rollup only advances the parent once EVERY SellerOrder
 * reaches a milestone). A pre-marketplace legacy line (`sellerOrder` null) has
 * no per-seller signal to consult, so it keeps the ORIGINAL whole-order check
 * byte-for-byte — this function changes nothing for it.
 *
 * The delivered timestamp prefers the owning SellerOrder's own `Shipment`
 * (`shipments[0]`, the same "take the one shipment row" convention already
 * used by `rollUpParentOrder` in seller-order-repository.ts), falling back to
 * the parent Order's `deliveredAt`/`placedAt` only if a DELIVERED SellerOrder
 * somehow has no shipment row — never a hard failure, and never a stricter
 * window than before.
 */
export function orderItemDeliveryState(
  order: ReturnEligibilityOrder,
  sellerOrder: ReturnEligibilitySellerOrder,
): { delivered: boolean; deliveredAt: Date | null } {
  if (sellerOrder) {
    if (sellerOrder.status !== "DELIVERED") return { delivered: false, deliveredAt: null };
    return {
      delivered: true,
      deliveredAt: sellerOrder.shipments[0]?.deliveredAt ?? order.deliveredAt ?? order.placedAt,
    };
  }
  if (order.status !== "DELIVERED") return { delivered: false, deliveredAt: null };
  return { delivered: true, deliveredAt: order.deliveredAt ?? order.placedAt };
}

/** Whether `deliveredAt` is still within the configured return window. Shared
 *  ms-math so the customer and admin paths can never drift apart on it. */
export function withinReturnWindow(deliveredAt: Date, windowDays: number, now: number = Date.now()): boolean {
  return now <= deliveredAt.getTime() + windowDays * 24 * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export type ReturnIneligibilityCode =
  | "not_found"
  | "not_delivered"
  | "window_expired"
  | "already_open"
  | "nothing_returnable";

export type EligibleLine = {
  orderItemId: string;
  productId: string;
  variantId: string | null;
  name: string;
  variantLabel: string | null;
  sku: string | null;
  unitPrice: number;
  orderedQuantity: number;
  remaining: number;
};

export type ReturnEligibility =
  | {
      eligible: true;
      order: { id: string; orderNumber: string; email: string; userId: string | null; grandTotal: number; shippingFee: number };
      lines: EligibleLine[];
    }
  | { eligible: false; code: ReturnIneligibilityCode; existingReturnNumber?: string };

const OPEN_RETURN_STATUSES = ["REQUESTED", "APPROVED", "RECEIVED", "REFUND_INITIATED"] as const;

/**
 * Customer self-service eligibility for `orderNumber`, scoped to `userId`.
 * Returns the returnable lines when eligible.
 *
 * Delivered/window are evaluated PER LINE via `orderItemDeliveryState` — a
 * line whose own SellerOrder is DELIVERED is eligible even while a sibling
 * SellerOrder on the same Order is still PROCESSING/SHIPPED; that sibling's
 * lines simply aren't included. The aggregate `Order.status` is never used as
 * a stand-in for an individual line's delivery state (only a pre-marketplace
 * legacy line, which has no SellerOrder at all, still falls back to it).
 */
export async function returnEligibility(
  userId: string,
  orderNumber: string,
): Promise<ReturnEligibility> {
  const order = await prisma.order.findUnique({
    where: { orderNumber },
    select: {
      id: true,
      orderNumber: true,
      email: true,
      userId: true,
      status: true,
      placedAt: true,
      deliveredAt: true,
      grandTotal: true,
      shippingFee: true,
      items: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          productId: true,
          variantId: true,
          name: true,
          variantLabel: true,
          sku: true,
          unitPrice: true,
          quantity: true,
          sellerOrder: { select: { status: true, shipments: { select: { deliveredAt: true } } } },
        },
      },
    },
  });

  if (!order || order.userId !== userId) return { eligible: false, code: "not_found" };

  const { windowDays } = await getReturnsConfig();
  const now = Date.now();
  const deliveryByItem = new Map(
    order.items.map((it) => [it.id, orderItemDeliveryState(order, it.sellerOrder)]),
  );

  const anyDelivered = [...deliveryByItem.values()].some((d) => d.delivered);
  if (!anyDelivered) return { eligible: false, code: "not_delivered" };

  const deliveredWithinWindow = order.items.filter((it) => {
    const d = deliveryByItem.get(it.id)!;
    return d.delivered && d.deliveredAt !== null && withinReturnWindow(d.deliveredAt, windowDays, now);
  });
  if (deliveredWithinWindow.length === 0) return { eligible: false, code: "window_expired" };

  const openReturn = await prisma.returnRequest.findFirst({
    where: { orderId: order.id, status: { in: [...OPEN_RETURN_STATUSES] } },
    select: { returnNumber: true },
  });
  if (openReturn) {
    return { eligible: false, code: "already_open", existingReturnNumber: openReturn.returnNumber };
  }

  const remaining = await remainingReturnableByOrderItem(order.id);
  const lines: EligibleLine[] = deliveredWithinWindow
    .map((it) => ({
      orderItemId: it.id,
      productId: it.productId,
      variantId: it.variantId,
      name: it.name,
      variantLabel: it.variantLabel,
      sku: it.sku,
      unitPrice: it.unitPrice,
      orderedQuantity: it.quantity,
      remaining: remaining.get(it.id) ?? 0,
    }))
    .filter((l) => l.remaining > 0);

  if (lines.length === 0) return { eligible: false, code: "nothing_returnable" };

  return {
    eligible: true,
    order: {
      id: order.id,
      orderNumber: order.orderNumber,
      email: order.email,
      userId: order.userId,
      grandTotal: order.grandTotal,
      shippingFee: order.shippingFee,
    },
    lines,
  };
}

/** A customer-safe sentence for an ineligibility code. No internal detail. */
export function describeIneligibility(code: ReturnIneligibilityCode): string {
  switch (code) {
    case "not_found":
      return "We couldn't find that order on your account.";
    case "not_delivered":
      return "You can start a return once the order has been delivered.";
    case "window_expired":
      return "The return window for this order has passed. Contact us if you still need help.";
    case "already_open":
      return "There's already an open return for this order.";
    case "nothing_returnable":
      return "All items on this order have already been requested for return.";
  }
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

const RETURN_DETAIL_SELECT = {
  id: true,
  returnNumber: true,
  status: true,
  reason: true,
  customerNote: true,
  resolutionNote: true,
  adminAssisted: true,
  refundAmount: true,
  refundMethod: true,
  refundReference: true,
  refundInitiatedAt: true,
  refundCompletedAt: true,
  restockedAt: true,
  returnDestination: true, // 9F-41B — frozen at approval; NULL on legacy rows
  returnDestinationSetAt: true,
  createdAt: true,
  updatedAt: true,
  order: { select: { id: true, orderNumber: true, grandTotal: true, shippingFee: true } },
  items: {
    orderBy: { id: "asc" as const },
    select: {
      id: true,
      orderItemId: true,
      productId: true,
      variantId: true,
      name: true,
      variantLabel: true,
      sku: true,
      unitPrice: true,
      quantity: true,
      refundAmount: true,
      restockQuantity: true,
      condition: true,
    },
  },
} satisfies Prisma.ReturnRequestSelect;

/** A single return for the account area — scoped to `userId`, `staffNote` never selected. */
export async function getCustomerReturn(userId: string, returnNumber: string) {
  const row = await prisma.returnRequest.findFirst({
    where: { returnNumber, userId },
    select: RETURN_DETAIL_SELECT,
  });
  return row;
}

/** The customer's returns list. */
export async function listCustomerReturns(userId: string) {
  return prisma.returnRequest.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      returnNumber: true,
      status: true,
      reason: true,
      createdAt: true,
      refundAmount: true,
      order: { select: { orderNumber: true } },
      _count: { select: { items: true } },
    },
  });
}

/** Whether a given order already has any return (used to gate the "start a return" UI). */
export async function orderHasOpenReturn(orderId: string): Promise<{ open: boolean; returnNumber?: string }> {
  const r = await prisma.returnRequest.findFirst({
    where: { orderId, status: { in: [...OPEN_RETURN_STATUSES] } },
    select: { returnNumber: true },
  });
  return r ? { open: true, returnNumber: r.returnNumber } : { open: false };
}
