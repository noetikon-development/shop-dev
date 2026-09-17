import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  canTransitionSellerOrder,
  isSellerOrderStatus,
  sellerCanCancelSellerOrder,
  sellerOrderStatusesBehind,
  sellerOrderTargetForParentStatus,
  shipmentStatusForSellerOrder,
  type SellerOrderStatus,
} from "@/lib/marketplace/seller-order-status";
import { getCourier, isCourierCode, courierLabel } from "@/lib/orders/couriers";
import { canTransition, CANCELLABLE_STATUSES } from "@/lib/orders/status";
import { restoreOfferStock } from "@/lib/marketplace/offer-inventory";
import { refundRouteForOrder, createAttributedPaymentRefund } from "@/lib/payments/refund";
import { getPaymentsConfig } from "@/lib/payments/config";
import { resolveShippingProvider } from "@/lib/shipping/registry";
import { writeAudit, type AuditInput } from "@/lib/admin/audit";
import type { SellerContext } from "@/lib/marketplace/types";

/**
 * Seller-scoped SellerOrder / Shipment data access (Phase 9F-2).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The ONLY sanctioned way for `/seller` code to read or mutate a `SellerOrder`
 * or `Shipment`. Every function REQUIRES a `SellerContext` and scopes on
 * `sellerId` — a seller can never see or change another seller's seller-orders,
 * shipments, items, or customer address. Ownership is re-checked INSIDE each
 * write transaction with a status-guarded `updateMany` (0 rows ⇒ someone else
 * moved it ⇒ abort).
 *
 * NEVER touches: `Inventory` / `InventoryAdjustment` / `Variant.stock`, payments.
 *
 * Phase 9F-30B adds ONE more scoped exception: `sellerCancelSellerOrder` — the
 * owning 3P seller declining / cancelling an order they can't fulfil. It reuses
 * the EXISTING cancellation architecture (`admin/order-actions.ts` `cancelOrderAction`):
 * the parent `Order` → CANCELLED (atomic status gate = the one-shot guard),
 * `OfferInventory` restored per `OrderItem.offerId` (`restoreOfferStock` +
 * `OfferAdjustment(CANCELLATION)`), `Product.soldCount` rolled back, `SellerOrder`
 * → CANCELLED with `commissionAmount` zeroed (+ a settlement clawback IF the row
 * was somehow already settled — it never can be from PENDING_PAYMENT/PROCESSING,
 * kept only for symmetry), one `OrderEvent`. The customer email + ops audit are
 * fired by the caller AFTER commit; the seller is NOT emailed about their own
 * cancellation. Single-seller only (this phase) — a multi-seller parent is refused.
 *
 * Phase 9F-12b adds ONE scoped exception: when a seller advances a SellerOrder
 * to SHIPPED / DELIVERED and EVERY SellerOrder on the parent Order has reached
 * that same milestone, the parent customer-facing `Order` is rolled forward
 * inside the same transaction (`Order.status` + courier/tracking snapshot +
 * `shippedAt` / `deliveredAt` + one `OrderEvent`). The seller-actor audit row is
 * written AFTER the transaction commits (best-effort, like the 1P path); the
 * customer notification (existing `sendOrderShipped` / `sendOrderDelivered`,
 * idempotency-keyed) and page revalidation are fired by the caller. Payment
 * status/method are never touched — a COD order ships and delivers while still
 * `paymentStatus = PENDING` (payment is collected on delivery). The FIRST_PARTY /
 * admin fulfilment path is unchanged and never reaches this code (Axiaro has no
 * seller session).
 * ─────────────────────────────────────────────────────────────────────────────
 */

type Client = Prisma.TransactionClient | typeof prisma;

export type SellerOrderRepoError =
  | { ok: false; code: "NOT_FOUND"; error: string }
  | { ok: false; code: "VALIDATION"; error: string }
  | { ok: false; code: "CONFLICT"; error: string }
  | { ok: false; code: "STALE"; error: string }
  | { ok: false; code: "INVARIANT"; error: string };

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const SELLER_ORDER_LIST_SELECT = {
  id: true,
  status: true,
  total: true,
  merchandiseSubtotal: true,
  shippingFee: true,
  createdAt: true,
  updatedAt: true,
  order: { select: { orderNumber: true, status: true, placedAt: true } },
  items: { select: { quantity: true } },
  shipments: { select: { id: true, status: true } },
} satisfies Prisma.SellerOrderSelect;

export type SellerOrderListOptions = { status?: string; q?: string; skip?: number; take?: number };

function listWhere(ctx: SellerContext, opts: SellerOrderListOptions): Prisma.SellerOrderWhereInput {
  const where: Prisma.SellerOrderWhereInput = { sellerId: ctx.sellerId };
  if (opts.status && isSellerOrderStatus(opts.status)) where.status = opts.status;
  if (opts.q?.trim()) {
    where.order = { is: { orderNumber: { contains: opts.q.trim(), mode: "insensitive" } } };
  }
  return where;
}

export async function listSellerOrders(
  ctx: SellerContext,
  opts: SellerOrderListOptions = {},
  client: Client = prisma,
) {
  return client.sellerOrder.findMany({
    where: listWhere(ctx, opts),
    orderBy: { createdAt: "desc" },
    skip: opts.skip,
    take: opts.take,
    select: SELLER_ORDER_LIST_SELECT,
  });
}

export async function countSellerOrders(
  ctx: SellerContext,
  opts: SellerOrderListOptions = {},
  client: Client = prisma,
): Promise<number> {
  return client.sellerOrder.count({ where: listWhere(ctx, opts) });
}

export async function sellerOrderStatusCounts(
  ctx: SellerContext,
  client: Client = prisma,
): Promise<Record<SellerOrderStatus, number>> {
  const rows = await client.sellerOrder.groupBy({
    by: ["status"],
    where: { sellerId: ctx.sellerId },
    _count: { _all: true },
  });
  const out = {
    PENDING_PAYMENT: 0,
    PROCESSING: 0,
    READY_TO_SHIP: 0,
    SHIPPED: 0,
    DELIVERED: 0,
    CANCELLED: 0,
  } as Record<SellerOrderStatus, number>;
  for (const r of rows) if (isSellerOrderStatus(r.status)) out[r.status] = r._count._all;
  return out;
}

/**
 * One SellerOrder for this seller, with everything the fulfilment screen needs
 * and NOTHING that belongs to the customer account or another seller:
 *   - the parent order NUMBER, placed date, and status (to gate the workflow)
 *   - the shipping ADDRESS snapshot (recipient + phone + address — needed to ship)
 *   - THIS seller's OrderItems + THIS seller's shipments
 * It deliberately does NOT select `Order.email`, `Order.phone`, `Order.userId`,
 * `Order.billingAddress`, `Order.grandTotal`, or sibling SellerOrders.
 */
export async function getSellerOrderForSeller(
  ctx: SellerContext,
  sellerOrderId: string,
  client: Client = prisma,
) {
  return client.sellerOrder.findFirst({
    where: { id: sellerOrderId, sellerId: ctx.sellerId },
    select: {
      id: true,
      status: true,
      total: true,
      merchandiseSubtotal: true,
      discountAllocated: true,
      shippingFee: true,
      shippingMethodName: true,
      createdAt: true,
      updatedAt: true,
      order: {
        select: {
          orderNumber: true,
          status: true,
          placedAt: true,
          shippingAddress: true,
        },
      },
      items: {
        select: {
          id: true,
          name: true,
          variantLabel: true,
          sku: true,
          imageUrl: true,
          unitPrice: true,
          quantity: true,
          lineTotal: true,
        },
        orderBy: { id: "asc" },
      },
      shipments: {
        select: {
          id: true,
          carrier: true,
          carrierName: true,
          trackingNumber: true,
          trackingUrl: true,
          status: true,
          shippedAt: true,
          deliveredAt: true,
          note: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Writes — ownership + status re-checked inside the transaction
// ---------------------------------------------------------------------------

/**
 * When a seller status change rolls the customer-facing parent Order forward
 * (9F-12b), this describes it so the caller can revalidate the storefront pages
 * and fire the existing customer notification.
 */
export type ParentOrderRollup = {
  id: string;
  orderNumber: string;
  rolledTo: "SHIPPED" | "DELIVERED";
};

export type SellerOrderMutationResult =
  | {
      ok: true;
      status: SellerOrderStatus;
      from: SellerOrderStatus;
      /** The parent customer Order this SellerOrder belongs to — always present. */
      orderId: string;
      orderNumber: string;
      /** Set only when this transition ALSO rolled the parent Order forward (9F-12b). */
      parentOrder?: ParentOrderRollup;
    }
  | SellerOrderRepoError;

/** SellerOrder statuses that count as "shipped or beyond" for the SHIPPED rollup. */
const SHIPPED_OR_BEYOND: ReadonlySet<string> = new Set(["SHIPPED", "DELIVERED"]);

/**
 * The audit entry for a seller-driven parent-Order rollup (9F-12b). Pure — the
 * actor is ALWAYS the authenticated seller user (`ctx.userId`), and the entry is
 * written by `advanceSellerOrderStatus` AFTER the rollup transaction commits
 * (best-effort, exactly like the 1P admin fulfilment audit — a logging failure
 * must never poison the transition).
 */
export function rollupAuditInput(
  ctx: Pick<SellerContext, "userId" | "sellerId" | "sellerName">,
  rollup: ParentOrderRollup,
  sellerOrderId: string,
): AuditInput {
  const verb = rollup.rolledTo === "SHIPPED" ? "shipped" : "delivered";
  return {
    actorUserId: ctx.userId,
    action: rollup.rolledTo === "SHIPPED" ? "order.shipped" : "order.delivered",
    targetType: "order",
    targetId: rollup.id,
    summary: `Seller ${ctx.sellerName} advanced order ${rollup.orderNumber} to ${rollup.rolledTo} — all seller orders ${verb}`,
    meta: {
      orderNumber: rollup.orderNumber,
      to: rollup.rolledTo,
      trigger: "seller_rollup",
      sellerOrderId,
      actorSellerId: ctx.sellerId,
    },
  };
}

/**
 * Roll the customer-facing parent `Order` forward when every ACTIVE (non-
 * CANCELLED) `SellerOrder` on it has reached the milestone the current seller
 * just moved to (9F-12b; CANCELLED made non-blocking in 9F-44E).
 *
 *   - SHIPPED   → parent `PROCESSING → SHIPPED` (only from PROCESSING), copying
 *                 the seller's OWN Shipment carrier/tracking onto the Order and
 *                 stamping `shippedAt`. No second Shipment is created.
 *   - DELIVERED → parent `SHIPPED | OUT_FOR_DELIVERY → DELIVERED`, stamping
 *                 `deliveredAt` (the settlement return-window anchor).
 *
 * A CANCELLED SellerOrder is excluded from the "every" check on BOTH branches —
 * a seller who cancelled can never block a sibling's shipment/delivery from
 * rolling the parent forward. If every SellerOrder on the order is CANCELLED,
 * `active` is empty and this returns null unconditionally: an all-cancelled
 * order becomes `Order.status = CANCELLED` through the EXISTING cancellation
 * cascade (`sellerCancelSellerOrder`'s last-active-seller lock, or the
 * whole-order cancel path) — never through this function, which must not be
 * able to accidentally roll an all-cancelled order to SHIPPED/DELIVERED.
 * `sellerType` (FIRST_PARTY/THIRD_PARTY) plays no part in this predicate — the
 * rollup is keyed purely on `SellerOrder.status`.
 *
 * Beyond that, still all-or-nothing: if any ACTIVE SellerOrder is not yet at
 * the target, or the parent is not in the expected state, this is a no-op
 * (returns null). No `PARTIALLY_*` status. Payment fields are NEVER touched (a
 * COD order ships/delivers while still `paymentStatus = PENDING`). Runs inside
 * the caller's tx so the parent transition and its `OrderEvent` commit
 * atomically with the SellerOrder move. The audit row + customer notification
 * are fired by the caller AFTER commit. Returns null (not an error) when
 * nothing was rolled — the seller's own transition still succeeds.
 */
async function rollUpParentOrder(
  tx: Prisma.TransactionClient,
  sellerOrderId: string,
  sellerTo: "SHIPPED" | "DELIVERED",
): Promise<ParentOrderRollup | null> {
  const so = await tx.sellerOrder.findUnique({
    where: { id: sellerOrderId },
    select: {
      shipments: {
        select: { carrier: true, carrierName: true, trackingNumber: true, trackingUrl: true },
      },
      order: {
        select: {
          id: true,
          orderNumber: true,
          status: true,
          sellerOrders: { select: { status: true } },
        },
      },
    },
  });
  if (!so) return null;
  const order = so.order;

  // CANCELLED siblings never block a rollup. An all-CANCELLED order (empty
  // `active`) is deliberately excluded from BOTH branches below — that parent
  // transition belongs to the cancellation cascade, not here.
  const active = order.sellerOrders.filter((s) => s.status !== "CANCELLED");
  if (active.length === 0) return null;

  if (sellerTo === "SHIPPED") {
    // Every ACTIVE SellerOrder shipped or beyond, and the parent still in PROCESSING.
    if (!active.every((s) => SHIPPED_OR_BEYOND.has(s.status))) return null;
    if (order.status !== "PROCESSING" || !canTransition("PROCESSING", "SHIPPED")) return null;

    const ship = so.shipments[0] ?? null;
    const res = await tx.order.updateMany({
      where: { id: order.id, status: "PROCESSING" },
      data: {
        status: "SHIPPED",
        shippedAt: new Date(),
        courier: ship?.carrier ?? null,
        courierName: ship?.carrierName ?? null,
        trackingNumber: ship?.trackingNumber ?? null,
        trackingUrl: ship?.trackingUrl ?? null,
        updatedAt: new Date(),
      },
    });
    if (res.count === 0) return null; // lost the race — someone else moved it

    const detail =
      [
        ship ? courierLabel(ship.carrier, ship.carrierName) : null,
        ship?.trackingNumber ? `Tracking ${ship.trackingNumber}` : null,
      ]
        .filter(Boolean)
        .join(" · ") || null;
    await tx.orderEvent.create({
      data: { orderId: order.id, status: "SHIPPED", title: "Order shipped", detail },
    });
    return { id: order.id, orderNumber: order.orderNumber, rolledTo: "SHIPPED" };
  }

  // DELIVERED — every ACTIVE SellerOrder delivered, parent in a shipped state.
  if (!active.every((s) => s.status === "DELIVERED")) return null;
  if (
    (order.status !== "SHIPPED" && order.status !== "OUT_FOR_DELIVERY") ||
    !canTransition(order.status, "DELIVERED")
  ) {
    return null;
  }
  const res = await tx.order.updateMany({
    where: { id: order.id, status: { in: ["SHIPPED", "OUT_FOR_DELIVERY"] } },
    data: { status: "DELIVERED", deliveredAt: new Date(), updatedAt: new Date() },
  });
  if (res.count === 0) return null;

  await tx.orderEvent.create({
    data: { orderId: order.id, status: "DELIVERED", title: "Delivered", detail: null },
  });
  return { id: order.id, orderNumber: order.orderNumber, rolledTo: "DELIVERED" };
}

/**
 * Advance a SellerOrder along its own fulfilment machine. Guards:
 *   - the SellerOrder belongs to `ctx.sellerId`
 *   - the parent `Order.status` permits fulfilment (never PENDING_PAYMENT / CANCELLED)
 *   - the transition is a declared forward move (or the READY_TO_SHIP→PROCESSING un-ready)
 *   - SHIPPED requires a shippable Shipment (carrier set + tracking present unless
 *     the carrier needs none)
 * On SHIPPED / DELIVERED the seller's own Shipment rows are stamped to match, and
 * — when EVERY SellerOrder on the parent has reached that milestone — the parent
 * customer `Order` is rolled forward too (9F-12b; see `rollUpParentOrder`). The
 * success result then carries `parentOrder` so the caller can revalidate the
 * storefront and send the existing customer notification.
 */
export async function advanceSellerOrderStatus(
  ctx: SellerContext,
  sellerOrderId: string,
  to: string,
  externalTx?: Prisma.TransactionClient,
): Promise<SellerOrderMutationResult> {
  if (!isSellerOrderStatus(to)) {
    return { ok: false, code: "VALIDATION", error: "Unknown status." };
  }

  const run = async (tx: Prisma.TransactionClient): Promise<SellerOrderMutationResult> => {
    const so = await tx.sellerOrder.findFirst({
      where: { id: sellerOrderId, sellerId: ctx.sellerId },
      select: {
        id: true,
        status: true,
        order: { select: { id: true, orderNumber: true, status: true } },
        shipments: { select: { carrier: true, trackingNumber: true } },
      },
    });
    if (!so) return { ok: false, code: "NOT_FOUND", error: "No such order for this seller." };

    const hasShippableShipment = so.shipments.some((s) => {
      if (!s.carrier || !isCourierCode(s.carrier)) return false;
      const def = getCourier(s.carrier);
      return def?.requiresTracking ? Boolean(s.trackingNumber) : true;
    });

    if (
      !canTransitionSellerOrder(so.status, to, {
        parentOrderStatus: so.order.status,
        hasShippableShipment,
      })
    ) {
      if (to === "SHIPPED" && !hasShippableShipment) {
        return { ok: false, code: "VALIDATION", error: "Add a carrier and tracking number before marking this shipped." };
      }
      return { ok: false, code: "VALIDATION", error: `Can't move this order from ${so.status} to ${to}.` };
    }

    // Atomic, status-guarded write.
    const res = await tx.sellerOrder.updateMany({
      where: { id: sellerOrderId, sellerId: ctx.sellerId, status: so.status },
      data: { status: to, updatedAt: new Date() },
    });
    if (res.count === 0) return { ok: false, code: "STALE", error: "This order was updated elsewhere — reload and try again." };

    const shipmentStatus = shipmentStatusForSellerOrder(to);
    if (shipmentStatus) {
      const stamp =
        shipmentStatus === "SHIPPED"
          ? { status: "SHIPPED", shippedAt: new Date() }
          : { status: "DELIVERED", deliveredAt: new Date() };
      await tx.shipment.updateMany({ where: { sellerOrderId }, data: stamp });
    }

    // 9F-12b: once every SellerOrder on this order has reached SHIPPED / DELIVERED,
    // roll the customer-facing parent Order forward in the same transaction.
    let parentOrder: ParentOrderRollup | undefined;
    if (to === "SHIPPED" || to === "DELIVERED") {
      parentOrder = (await rollUpParentOrder(tx, sellerOrderId, to)) ?? undefined;
    }

    return {
      ok: true,
      status: to,
      from: so.status as SellerOrderStatus,
      orderId: so.order.id,
      orderNumber: so.order.orderNumber,
      parentOrder,
    };
  };

  try {
    if (externalTx) return await run(externalTx);
    const result = await prisma.$transaction(run);
    // 9F-12b: record the seller as the actor for a parent-Order rollup — AFTER
    // the transaction commits. Best-effort (writeAudit never throws); a logging
    // failure must not undo a committed transition. The caller sends the
    // customer notification + revalidates the storefront.
    if (result.ok && result.parentOrder) {
      await writeAudit(rollupAuditInput(ctx, result.parentOrder, sellerOrderId));
    }
    return result;
  } catch (err) {
    console.error("[seller-order-repository] advanceSellerOrderStatus failed", err);
    return { ok: false, code: "VALIDATION", error: "Could not update the order." };
  }
}

// ---------------------------------------------------------------------------
// 9F-30B — seller cancels / declines an order it can't fulfil
// ---------------------------------------------------------------------------

export type SellerOrderClawbackEvent = {
  sellerOrderId: string;
  sellerId: string;
  clawbackDelta: number;
  newOutstandingClawback: number;
};

export type SellerCancelResult =
  | {
      ok: true;
      from: SellerOrderStatus;
      orderId: string;
      orderNumber: string;
      previousParentStatus: string;
      /** True when this seller was the LAST active SellerOrder on the order,
       *  so the parent Order was ALSO cancelled in this same transaction —
       *  the existing whole-order-cancel semantics apply in that case
       *  (customer notified, OrderEvent reads "Order cancelled"). False for a
       *  multi-seller order where at least one sibling SellerOrder is still
       *  active — the parent Order's own status is untouched by the
       *  cancellation itself, though `parentRollup` below may still have
       *  advanced it forward (SHIPPED/DELIVERED) in the SAME transaction if
       *  this cancellation was the last thing blocking that. */
      parentAlsoCancelled: boolean;
      restockedUnits: number;
      restockedLines: number;
      clawbackEvents: SellerOrderClawbackEvent[];
      /** Set only when removing this cancelled SellerOrder let the parent
       *  Order's EXISTING SHIPPED/DELIVERED rollup (9F-12b) advance — e.g. a
       *  sibling was already DELIVERED but the parent was stuck at
       *  PROCESSING because this now-cancelled seller hadn't shipped yet.
       *  Never set when `parentAlsoCancelled` is true. */
      parentRollup?: ParentOrderRollup;
      /** 9F-60 — the PENDING PaymentRefund created for this seller's share when
       *  the parent Order has an eligible PAID/PARTIALLY_REFUNDED Payment AND
       *  provider routing is live; `null` for COD, no Payment, a bookkeeping-
       *  routed order, or the (dormant-today) feature being off. The caller
       *  invokes the provider call AFTER this transaction has committed —
       *  never from in here (see `sellerCancelOrderAction`). */
      paymentRefundId: string | null;
    }
  | SellerOrderRepoError;

/**
 * The owning seller cancels a `SellerOrder` (PENDING_PAYMENT = decline,
 * PROCESSING = cancel) because they can't fulfil it — its OWN SellerOrder
 * only, regardless of how many other sellers are on the same parent Order.
 *
 * Guards / idempotency:
 *   - SellerOrder scoped to `ctx.sellerId`; status must be PENDING_PAYMENT / PROCESSING
 *     (`sellerCanCancelSellerOrder` — the same predicate the whole-order
 *     cancellation safety gate in `orders/cancellation.ts` reuses)
 *   - the parent Order must still be in `CANCELLABLE_STATUSES` (in practice this
 *     is already implied whenever THIS seller is itself still decline-eligible —
 *     the parent can only have advanced past PROCESSING once EVERY SellerOrder,
 *     including this one, has shipped)
 *   - the SellerOrder write is status-guarded (`updateMany` on `{id, sellerId,
 *     status: so.status}`) — 0 rows ⇒ STALE. THIS is now the one-shot
 *     idempotency gate for this seller's own reversal (inventory / soldCount /
 *     settlement below), independent of the parent Order's fate.
 *
 * Parent-Order cascade (multi-seller-safe): after this SellerOrder is
 * confirmed cancelled, every sibling `SellerOrder` row on the same parent is
 * locked with `SELECT ... FOR UPDATE` (the same idiom `restoreOfferStock`
 * already uses to lock `OfferInventory`) before deciding whether any of them
 * is still active. Locking ALL sibling rows up front serializes two sellers
 * declining at the same moment — whichever transaction's lock acquires first
 * forces the other to wait and then see the up-to-date (already-committed)
 * status, so "am I the last one" can never be answered incorrectly by both
 * concurrent callers. The parent Order is cancelled ONLY when no sibling is
 * left active; otherwise it is left completely untouched — no new status
 * value, no schema change. If the guarded parent-Order UPDATE matches 0 rows
 * (e.g. an admin already moved it, or a fulfilment cascade shipped it in the
 * meantime), this is treated as a benign no-op, NOT an error — this seller's
 * own already-committed cancellation must never be rolled back because of
 * something that happened to the parent afterward.
 *
 * Never touches payments, `Order.paymentStatus`, `Inventory`, the returns/refund
 * flow, or another seller's rows/inventory/commission/settlement.
 */
export async function sellerCancelSellerOrder(
  ctx: SellerContext,
  sellerOrderId: string,
  reason: string,
  externalTx?: Prisma.TransactionClient,
): Promise<SellerCancelResult> {
  const cleanReason = reason.trim();
  if (!cleanReason) {
    return { ok: false, code: "VALIDATION", error: "Add a reason so Axiaro and the customer know why." };
  }

  // Checked ONCE, OUTSIDE the transaction — the common case today (feature
  // off in every environment) then makes ZERO extra queries during the
  // transaction below. Calling `getPaymentsConfig()` (a plain, non-tx query)
  // from inside the transaction was tried first and caused a genuine
  // regression: it adds an extra pooled connection to every single
  // cancellation, and under real concurrent cancellations (the existing
  // sibling-lock race test) that contention produced spurious transaction
  // failures. Hoisting it out fixes that while staying fully correct — when
  // the feature IS live (future), `refundRouteForOrder` below still does its
  // own authoritative, tx-scoped Payment lookup.
  const refundFeatureLive = await getPaymentsConfig().then((c) => c.onlinePaymentEnabled && c.mode === "live");

  const run = async (tx: Prisma.TransactionClient): Promise<SellerCancelResult> => {
    const so = await tx.sellerOrder.findFirst({
      where: { id: sellerOrderId, sellerId: ctx.sellerId },
      select: {
        id: true,
        status: true,
        total: true,
        commissionAmount: true,
        settlementId: true,
        settlementClawbackAmount: true,
        order: { select: { id: true, orderNumber: true, status: true } },
        items: { select: { id: true, offerId: true, quantity: true, productId: true } },
      },
    });
    if (!so) return { ok: false, code: "NOT_FOUND", error: "No such order for this seller." };

    if (!sellerCanCancelSellerOrder(so.status)) {
      return {
        ok: false,
        code: "VALIDATION",
        error: `An order that is ${so.status.toLowerCase().replace("_", " ")} can't be cancelled here.`,
      };
    }
    if (!(CANCELLABLE_STATUSES as string[]).includes(so.order.status)) {
      return {
        ok: false,
        code: "CONFLICT",
        error: "The customer order has already moved on — reload and check its status.",
      };
    }

    // 1. SellerOrder → CANCELLED, status-guarded + commission zeroed (the sale it
    //    was earned on no longer exists). 0 rows ⇒ someone else moved it. This is
    //    now the one-shot gate for steps 2–4 below — they run at most once
    //    regardless of what happens to the parent Order afterward.
    const soRes = await tx.sellerOrder.updateMany({
      where: { id: sellerOrderId, sellerId: ctx.sellerId, status: so.status },
      data: { status: "CANCELLED", commissionAmount: 0, updatedAt: new Date() },
    });
    if (soRes.count === 0) {
      return { ok: false, code: "STALE", error: "This order was updated elsewhere — reload and try again." };
    }

    // 2. Reverse exactly what checkout's SALE deducted — OfferInventory per
    //    OrderItem.offerId + OfferAdjustment(CANCELLATION). Scoped to `so.items`
    //    (this SellerOrder's own OrderItems only) — never another seller's.
    let restockedUnits = 0;
    let restockedLines = 0;
    const soldBackByProduct = new Map<string, number>();
    for (const it of so.items) {
      if (it.quantity <= 0) continue;
      if (it.offerId) {
        const res = await restoreOfferStock(
          {
            offerId: it.offerId,
            units: it.quantity,
            reason: "CANCELLATION",
            note: `Order ${so.order.orderNumber} cancelled by seller ${ctx.sellerName} · item ${it.id}`,
            actorUserId: ctx.userId,
          },
          tx,
        );
        if (!res.ok) throw new Error(res.error ?? "Could not restore a line — cancellation aborted.");
      }
      restockedUnits += it.quantity;
      restockedLines += 1;
      soldBackByProduct.set(it.productId, (soldBackByProduct.get(it.productId) ?? 0) + it.quantity);
    }

    // 3. Undo the soldCount bump checkout made (never below zero).
    for (const [productId, qty] of soldBackByProduct) {
      await tx.$executeRaw`
        UPDATE "Product" SET "soldCount" = GREATEST(0, "soldCount" - ${qty})
        WHERE "id" = ${productId}`;
    }

    // 4. Settlement clawback — ONLY if this SellerOrder was somehow already
    //    settled. It never can be from PENDING_PAYMENT / PROCESSING (settlement
    //    needs DELIVERED), but keep the branch symmetric with cancelOrderAction.
    const clawbackEvents: SellerOrderClawbackEvent[] = [];
    if (so.settlementId !== null) {
      const delta = Math.max(0, so.total - so.commissionAmount);
      await tx.sellerOrder.update({
        where: { id: sellerOrderId },
        data: {
          settlementStatus: "CLAWED_BACK",
          settlementClawbackAmount: { increment: delta },
        },
      });
      if (delta > 0) {
        clawbackEvents.push({
          sellerOrderId,
          sellerId: ctx.sellerId,
          clawbackDelta: delta,
          newOutstandingClawback: so.settlementClawbackAmount + delta,
        });
      }
    }

    // 5. Concurrency-safe "last active seller" cascade. Lock EVERY SellerOrder
    //    row on this parent Order (including the one just cancelled above) so a
    //    concurrent decline on a sibling can never race this decision — it must
    //    wait for this lock, then see this seller's row as already CANCELLED.
    const siblings = await tx.$queryRaw<{ id: string; status: string }[]>`
      SELECT "id", "status" FROM "SellerOrder" WHERE "orderId" = ${so.order.id} FOR UPDATE`;
    const anySiblingStillActive = siblings.some((s) => s.id !== sellerOrderId && s.status !== "CANCELLED");

    let parentAlsoCancelled = false;
    if (!anySiblingStillActive) {
      // Guarded — a benign no-op (not an error) if the parent already moved on
      // for some other reason (e.g. an admin cancelled it, or a fulfilment
      // cascade shipped it) between our read above and reaching here. This
      // seller's own already-committed cancellation must never roll back
      // because of that.
      const cancelledOrder = await tx.$executeRaw`
        UPDATE "Order" SET "status" = 'CANCELLED', "updatedAt" = now()
        WHERE "id" = ${so.order.id}
          AND "status" IN ('PENDING_PAYMENT', 'PENDING', 'PROCESSING')`;
      parentAlsoCancelled = cancelledOrder > 0;
    }

    // 5a. Re-evaluate the SHIPPED/DELIVERED rollup now that a cancelled
    //     sibling can no longer block it (launch-readiness audit finding).
    //     Reuses the EXISTING, unmodified `rollUpParentOrder()` — no new
    //     eligibility logic, no new lock. Only attempted when a sibling is
    //     still active; when none are, the all-cancelled cascade above
    //     already owns the parent transition (and `rollUpParentOrder`'s own
    //     `active.length === 0` guard would no-op here anyway, so this can
    //     never turn an all-cancelled order into SHIPPED/DELIVERED).
    //
    //     Tried SHIPPED-then-DELIVERED, in that order, inside this SAME
    //     transaction: a parent stuck at PROCESSING because this seller
    //     hadn't shipped yet — while a sibling is already DELIVERED — needs
    //     both steps to catch up in one go. Each call re-reads live state and
    //     is independently self-guarded (a no-op unless its OWN precondition
    //     now holds), exactly like two ordinary sequential fulfilment
    //     advances would be. `rollUpParentOrder` decides purely from every
    //     ACTIVE sibling's status (already re-fetched fresh inside it) — the
    //     specific sibling id passed in only supplies which SellerOrder's own
    //     Shipment gets copied onto the parent for the SHIPPED branch, the
    //     same "whichever seller" ambiguity the existing 9F-12b design
    //     already accepts for a normal multi-seller shipment.
    //
    //     Safe under concurrency: this runs AFTER the sibling `FOR UPDATE`
    //     lock above, which already holds every SellerOrder row on this
    //     parent Order for the rest of this transaction — no new lock is
    //     acquired here, so this cannot introduce a new deadlock or race
    //     against a concurrent sibling cancellation. A concurrent
    //     `advanceSellerOrderStatus` on a sibling only ever locks its own one
    //     row via a status-guarded `updateMany`; it cannot be waiting on a
    //     lock this transaction needs while this transaction waits on it, so
    //     no cross-path deadlock is possible either.
    let parentRollup: ParentOrderRollup | undefined;
    if (anySiblingStillActive) {
      const activeSibling = siblings.find((s) => s.id !== sellerOrderId && s.status !== "CANCELLED");
      if (activeSibling) {
        // Both calls always run — a parent stuck at PROCESSING needs the
        // SHIPPED hop to land BEFORE the DELIVERED check's own precondition
        // (order.status already SHIPPED/OUT_FOR_DELIVERY) can pass. Using
        // `??` here would short-circuit the DELIVERED attempt the moment
        // SHIPPED fired, stranding a fully-DELIVERED order at SHIPPED.
        const shippedRollup = await rollUpParentOrder(tx, activeSibling.id, "SHIPPED");
        const deliveredRollup = await rollUpParentOrder(tx, activeSibling.id, "DELIVERED");
        parentRollup = deliveredRollup ?? shippedRollup ?? undefined;
      }
    }

    // 5b. Seller-aware refund-row creation (9F-60) — DB ONLY, no PayMongo call
    //     here. Runs AFTER the sibling-lock cascade above so the well-tested
    //     "last active seller" decision is fully resolved first; the new
    //     Payment `FOR UPDATE` lock this acquires is a different lock family
    //     than the SellerOrder locks above, and no other code path acquires
    //     these two lock families in the opposite order, so this ordering
    //     introduces no deadlock risk (architecture audit, 9F-59-cancel-audit).
    //     `refundRouteForOrder` / `createAttributedPaymentRefund` are the
    //     EXISTING, unmodified (besides an added optional `db` param) seller-
    //     aware refund foundation — reused verbatim, not reimplemented.
    //     Skipped entirely for COD / no Payment / bookkeeping-routed orders /
    //     the feature being off (today, always — Phase 4-A dormant). A cap
    //     rejection here (not expected in practice: `so.total` is exactly the
    //     seller's own ceiling, read inside this same transaction) must never
    //     fail the cancellation itself — refund attribution is best-effort on
    //     top of it, never a precondition.
    let paymentRefundId: string | null = null;
    if (refundFeatureLive) {
      const routing = await refundRouteForOrder(so.order.id, tx);
      if (routing.route === "provider") {
        const created = await createAttributedPaymentRefund(
          {
            paymentId: routing.payment.id,
            returnRequestId: null,
            sellerOrderId,
            amount: so.total,
            reason: "seller_cancellation",
          },
          tx,
        );
        if (created.ok) paymentRefundId = created.paymentRefundId;
      }
    }

    // 6. Timeline event on the customer-facing order — accurate to what
    //    actually happened. The whole-order wording is used ONLY when this
    //    seller really was the last one and the parent was cancelled too,
    //    consistent with the existing single-seller / whole-order semantics.
    await tx.orderEvent.create({
      data: {
        orderId: so.order.id,
        status: "CANCELLED",
        title: parentAlsoCancelled ? "Order cancelled" : "Seller order cancelled",
        detail: parentAlsoCancelled
          ? `Cancelled by the seller. Reason: ${cleanReason}`
          : `${ctx.sellerName}'s items were cancelled by the seller. Reason: ${cleanReason}`,
      },
    });

    return {
      ok: true,
      from: so.status as SellerOrderStatus,
      orderId: so.order.id,
      orderNumber: so.order.orderNumber,
      previousParentStatus: so.order.status,
      parentAlsoCancelled,
      restockedUnits,
      restockedLines,
      clawbackEvents,
      parentRollup,
      paymentRefundId,
    };
  };

  try {
    if (externalTx) return await run(externalTx);
    return await prisma.$transaction(run);
  } catch (err) {
    console.error("[seller-order-repository] sellerCancelSellerOrder failed", err);
    return { ok: false, code: "VALIDATION", error: "Could not cancel the order." };
  }
}

export type ShipmentInput = {
  carrier: string;
  carrierName?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  note?: string | null;
};

export type SaveShipmentResult = { ok: true; shipmentId: string } | SellerOrderRepoError;

/**
 * Create the SellerOrder's shipment, or update it if one already exists. MVP:
 * exactly one shipment per SellerOrder (the schema comment) — a second create is
 * refused. Scoped so a seller can only ever touch a shipment on THEIR own
 * SellerOrder.
 *
 * 9F-47C: validation / normalisation now runs through the shipping provider
 * resolved from store config. Production resolves to the MANUAL provider (fail
 * closed), whose `createShipment` is the same pure `resolveManualShipment` check
 * as before — same errors, same normalised fields. The transaction, the
 * one-shipment-per-SellerOrder guard, the ownership checks and the persisted
 * columns are unchanged; the provider-integration columns stay NULL for manual
 * shipments.
 */
export async function saveSellerShipment(
  ctx: SellerContext,
  sellerOrderId: string,
  input: ShipmentInput,
  shipmentId?: string,
  externalTx?: Prisma.TransactionClient,
): Promise<SaveShipmentResult> {
  const provider = await resolveShippingProvider();
  const outcome = await provider.createShipment({ sellerOrderId, ...input });
  if (!outcome.ok) return { ok: false, code: "VALIDATION", error: outcome.error };
  const resolved = {
    data: {
      carrier: outcome.value.carrier,
      carrierName: outcome.value.carrierName,
      trackingNumber: outcome.value.trackingNumber,
      trackingUrl: outcome.value.trackingUrl,
      note: outcome.value.note,
    },
  };

  const run = async (tx: Prisma.TransactionClient): Promise<SaveShipmentResult> => {
    const so = await tx.sellerOrder.findFirst({
      where: { id: sellerOrderId, sellerId: ctx.sellerId },
      select: { id: true, status: true, order: { select: { status: true } }, shipments: { select: { id: true } } },
    });
    if (!so) return { ok: false, code: "NOT_FOUND", error: "No such order for this seller." };
    if (so.status === "CANCELLED" || so.status === "DELIVERED") {
      return { ok: false, code: "VALIDATION", error: "This order can no longer be edited." };
    }

    if (shipmentId) {
      const owned = await tx.shipment.findFirst({
        where: { id: shipmentId, sellerOrder: { id: sellerOrderId, sellerId: ctx.sellerId } },
        select: { id: true, status: true },
      });
      if (!owned) return { ok: false, code: "NOT_FOUND", error: "No such shipment for this order." };
      if (owned.status === "DELIVERED") {
        return { ok: false, code: "VALIDATION", error: "A delivered shipment can't be edited." };
      }
      await tx.shipment.update({ where: { id: owned.id }, data: resolved.data });
      return { ok: true, shipmentId: owned.id };
    }

    if (so.shipments.length > 0) {
      return { ok: false, code: "CONFLICT", error: "This order already has a shipment — edit that one." };
    }
    const created = await tx.shipment.create({
      data: { sellerOrderId, ...resolved.data, status: "PENDING" },
      select: { id: true },
    });
    return { ok: true, shipmentId: created.id };
  };

  try {
    if (externalTx) return await run(externalTx);
    return await prisma.$transaction(run);
  } catch (err) {
    console.error("[seller-order-repository] saveSellerShipment failed", err);
    return { ok: false, code: "VALIDATION", error: "Could not save the shipment." };
  }
}

// ---------------------------------------------------------------------------
// 9F-35B — admin fulfilment → SellerOrder cascade
//
// When an Axiaro admin advances the customer-facing parent Order
// (admin/fulfillment-actions.ts + admin/order-actions.ts), bring every
// SellerOrder on it to the matching seller-plane state, so a THIRD_PARTY order
// can never reach SHIPPED / DELIVERED while its SellerOrder is still
// PENDING_PAYMENT / PROCESSING (9F-35A P1-5 — that strands the seller order and
// blocks settlement forever, since eligibility needs BOTH planes at DELIVERED).
//
// This is the FORWARD sibling of the CANCELLED cascade (9F-3 / 9F-30B): it
// deliberately does NOT route through `advanceSellerOrderStatus` /
// `SELLER_ORDER_STATUS_TRANSITIONS` (the seller's own machine). Every write is
// status-guarded and forward-only — a SellerOrder the seller already advanced
// past the target, or a CANCELLED one, is left exactly as it is. The parent
// Order / OrderEvent / customer notification stay entirely with the admin
// action; this touches only SellerOrder + its Shipment, never Order, and never
// inventory, the customer plane, or settlement fields.
// ---------------------------------------------------------------------------

/** Courier / tracking bundle the admin captured on a SHIPPED transition. */
export type AdminCascadeCourier = {
  courier: string | null;
  courierName: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
};

export type SellerOrderCascadeRow = {
  sellerOrderId: string;
  sellerId: string;
  sellerType: string;
  from: SellerOrderStatus;
  to: SellerOrderStatus;
  shipment: "created" | "stamped" | "none";
};

export type SellerOrderCascadeResult = {
  ok: true;
  /** null when the parent status has no seller-plane counterpart (e.g. OUT_FOR_DELIVERY). */
  target: SellerOrderStatus | null;
  cascaded: SellerOrderCascadeRow[];
};

/**
 * The audit entry for ONE admin-induced SellerOrder cascade hop (9F-35B). Pure —
 * the actor is the admin user; written by `cascadeSellerOrderFromParent` AFTER
 * its transaction commits (best-effort, matching the 9F-12b rollup-audit
 * discipline — a logging failure never undoes a committed cascade, and a
 * rolled-back test never persists audit rows because the externalTx path skips
 * this entirely).
 */
export function adminCascadeAuditInput(
  args: { actorUserId: string | null; orderId: string; orderNumber: string; parentStatus: string },
  row: SellerOrderCascadeRow,
): AuditInput {
  // A null actor means a system caller (e.g. the PayMongo webhook's own
  // PAID→PROCESSING auto-advance) rather than an admin click — same nullable
  // convention the webhook already uses for its OWN audit rows.
  const system = args.actorUserId === null;
  return {
    actorUserId: args.actorUserId,
    action: "seller_order.status_changed",
    targetType: "seller_order",
    targetId: row.sellerOrderId,
    summary:
      `${system ? "System (payment webhook)" : "Admin"} fulfilment of order ${args.orderNumber} advanced seller order ` +
      `${row.sellerOrderId} (${row.sellerType === "FIRST_PARTY" ? "1P" : "3P"}): ${row.from} → ${row.to}`,
    meta: {
      trigger: system ? "payment_webhook_cascade" : "admin_fulfillment_cascade",
      orderId: args.orderId,
      orderNumber: args.orderNumber,
      sellerOrderId: row.sellerOrderId,
      sellerId: row.sellerId,
      from: row.from,
      to: row.to,
      parentStatus: args.parentStatus,
      shipment: row.shipment,
    },
  };
}

/**
 * Cascade the seller plane forward after an admin advanced the parent Order.
 *
 * `parentStatus` is the status the admin JUST moved the Order to. The mapping
 * (`sellerOrderTargetForParentStatus`):
 *   PROCESSING       → SellerOrder PENDING_PAYMENT             → PROCESSING
 *   SHIPPED          → SellerOrder PENDING_PAYMENT/PROCESSING/READY_TO_SHIP → SHIPPED (+ Shipment)
 *   OUT_FOR_DELIVERY → no seller-plane move (clean no-op)
 *   DELIVERED        → SellerOrder * (except DELIVERED/CANCELLED) → DELIVERED (+ Shipment.deliveredAt)
 *
 * Shipment side-effects run for THIRD_PARTY rows only — a 1P shadow SellerOrder
 * tracks the parent for bookkeeping, but Axiaro's own fulfilment carries
 * courier/tracking on the Order, not a Shipment row. On a SHIPPED cascade a
 * SellerOrder with no Shipment gets one seeded from `courier`; one that already
 * has a Shipment (the seller made it) is only stamped, never duplicated.
 *
 * Best-effort: the parent Order transition has already committed and a missed
 * hop self-heals on the next admin fulfilment step (each target's "behind" set
 * contains every lower status). Always resolves `{ ok: true }`.
 */
export async function cascadeSellerOrderFromParent(
  args: {
    orderId: string;
    orderNumber: string;
    parentStatus: string;
    /** Admin user id — the cascade audit actor. Null for a system caller (e.g.
     *  the payment webhook's own auto-advance — no human actor to attribute). */
    actorUserId: string | null;
    /** Courier/tracking to seed a Shipment on a SHIPPED cascade; ignored otherwise. */
    courier?: AdminCascadeCourier;
  },
  externalTx?: Prisma.TransactionClient,
): Promise<SellerOrderCascadeResult> {
  const target = sellerOrderTargetForParentStatus(args.parentStatus);
  if (!target) return { ok: true, target: null, cascaded: [] };
  const behind = sellerOrderStatusesBehind(target);
  if (behind.length === 0) return { ok: true, target, cascaded: [] };

  const run = async (tx: Prisma.TransactionClient): Promise<SellerOrderCascadeRow[]> => {
    const rows = await tx.sellerOrder.findMany({
      where: { orderId: args.orderId, status: { in: behind } },
      select: {
        id: true,
        status: true,
        sellerId: true,
        sellerType: true,
        shipments: { select: { id: true, status: true } },
      },
    });

    const out: SellerOrderCascadeRow[] = [];
    for (const so of rows) {
      // Status-guarded: if the seller advanced this row between our read and
      // this write, 0 rows match and we skip it — never a backwards move.
      const upd = await tx.sellerOrder.updateMany({
        where: { id: so.id, status: so.status },
        data: { status: target, updatedAt: new Date() },
      });
      if (upd.count === 0) continue;

      let shipment: SellerOrderCascadeRow["shipment"] = "none";
      if (so.sellerType === "THIRD_PARTY") {
        if (target === "SHIPPED") {
          if (so.shipments.length === 0) {
            const c = args.courier;
            if (c?.courier && isCourierCode(c.courier)) {
              await tx.shipment.create({
                data: {
                  sellerOrderId: so.id,
                  carrier: c.courier,
                  carrierName: c.courierName,
                  trackingNumber: c.trackingNumber,
                  trackingUrl: c.trackingUrl,
                  status: "SHIPPED",
                  shippedAt: new Date(),
                },
              });
              shipment = "created";
            }
          } else {
            await tx.shipment.updateMany({
              where: { sellerOrderId: so.id, status: { not: "DELIVERED" } },
              data: { status: "SHIPPED", shippedAt: new Date() },
            });
            shipment = "stamped";
          }
        } else if (target === "DELIVERED") {
          const r = await tx.shipment.updateMany({
            where: { sellerOrderId: so.id, status: { not: "DELIVERED" } },
            data: { status: "DELIVERED", deliveredAt: new Date() },
          });
          shipment = r.count > 0 ? "stamped" : "none";
        }
      }

      out.push({
        sellerOrderId: so.id,
        sellerId: so.sellerId,
        sellerType: so.sellerType,
        from: so.status as SellerOrderStatus,
        to: target,
        shipment,
      });
    }
    return out;
  };

  let cascaded: SellerOrderCascadeRow[];
  try {
    cascaded = externalTx ? await run(externalTx) : await prisma.$transaction(run);
  } catch (err) {
    console.error("[seller-order-repository] cascadeSellerOrderFromParent failed", err);
    return { ok: true, target, cascaded: [] };
  }

  // Audit — one row per hop actually taken. Post-commit, best-effort, and only
  // on the production (non-externalTx) path so a rolled-back test never persists
  // audit rows (same discipline as the 9F-12b rollup audit).
  if (!externalTx) {
    for (const row of cascaded) {
      await writeAudit(adminCascadeAuditInput(args, row));
    }
  }

  return { ok: true, target, cascaded };
}
