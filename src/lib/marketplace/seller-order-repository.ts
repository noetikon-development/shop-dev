import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  canTransitionSellerOrder,
  isSellerOrderStatus,
  sellerCanCancelSellerOrder,
  shipmentStatusForSellerOrder,
  type SellerOrderStatus,
} from "@/lib/marketplace/seller-order-status";
import {
  getCourier,
  isCourierCode,
  isSafeTrackingUrl,
  buildTrackingUrl,
  courierLabel,
} from "@/lib/orders/couriers";
import { canTransition, CANCELLABLE_STATUSES } from "@/lib/orders/status";
import { restoreOfferStock } from "@/lib/marketplace/offer-inventory";
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
          _count: { select: { sellerOrders: true } },
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
 * Roll the customer-facing parent `Order` forward when every `SellerOrder` on it
 * has reached the milestone the current seller just moved to (9F-12b).
 *
 *   - SHIPPED   → parent `PROCESSING → SHIPPED` (only from PROCESSING), copying
 *                 the seller's OWN Shipment carrier/tracking onto the Order and
 *                 stamping `shippedAt`. No second Shipment is created.
 *   - DELIVERED → parent `SHIPPED | OUT_FOR_DELIVERY → DELIVERED`, stamping
 *                 `deliveredAt` (the settlement return-window anchor).
 *
 * All-or-nothing: if ANY SellerOrder is not yet at the target, or the parent is
 * not in the expected state, this is a no-op (returns null). No `PARTIALLY_*`
 * status. Payment fields are NEVER touched (a COD order ships/delivers while
 * still `paymentStatus = PENDING`). Runs inside the caller's tx so the parent
 * transition and its `OrderEvent` commit atomically with the SellerOrder move.
 * The audit row + customer notification are fired by the caller AFTER commit.
 * Returns null (not an error) when nothing was rolled — the seller's own
 * transition still succeeds.
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

  if (sellerTo === "SHIPPED") {
    // Every SellerOrder shipped or beyond, and the parent still in PROCESSING.
    if (!order.sellerOrders.every((s) => SHIPPED_OR_BEYOND.has(s.status))) return null;
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

  // DELIVERED — every SellerOrder delivered, parent in a shipped state.
  if (!order.sellerOrders.every((s) => s.status === "DELIVERED")) return null;
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
      restockedUnits: number;
      restockedLines: number;
      clawbackEvents: SellerOrderClawbackEvent[];
    }
  | SellerOrderRepoError;

/** Thrown inside the tx when the atomic parent-Order gate matches 0 rows. */
class ParentOrderMovedError extends Error {}

/**
 * The owning seller cancels a `SellerOrder` (PENDING_PAYMENT = decline,
 * PROCESSING = cancel) because they can't fulfil it. Reuses the same reversal
 * the admin `cancelOrderAction` performs — this phase is single-seller, so the
 * seller's SellerOrder IS the whole order and cancelling it cancels the parent.
 *
 * Guards / idempotency (identical mechanism to `cancelOrderAction`):
 *   - SellerOrder scoped to `ctx.sellerId`; status must be PENDING_PAYMENT / PROCESSING
 *   - the parent Order must still be in `CANCELLABLE_STATUSES`
 *   - a single atomic `UPDATE "Order" … WHERE status IN (cancellable)` is the
 *     one-shot gate: 0 rows ⇒ the order already moved on ⇒ nothing is restored
 *   - the SellerOrder write is status-guarded too (0 rows ⇒ STALE)
 *
 * Never touches payments, `Order.paymentStatus`, `Inventory`, the returns/refund
 * flow, or another seller's rows.
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
        order: {
          select: {
            id: true,
            orderNumber: true,
            status: true,
            sellerOrders: { select: { id: true } },
          },
        },
        items: { select: { id: true, offerId: true, quantity: true, productId: true } },
      },
    });
    if (!so) return { ok: false, code: "NOT_FOUND", error: "No such order for this seller." };

    if (so.order.sellerOrders.length !== 1) {
      return {
        ok: false,
        code: "VALIDATION",
        error: "This order has items from more than one seller — contact Axiaro to cancel it.",
      };
    }
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
    //    was earned on no longer exists). 0 rows ⇒ someone else moved it.
    const soRes = await tx.sellerOrder.updateMany({
      where: { id: sellerOrderId, sellerId: ctx.sellerId, status: so.status },
      data: { status: "CANCELLED", commissionAmount: 0, updatedAt: new Date() },
    });
    if (soRes.count === 0) {
      return { ok: false, code: "STALE", error: "This order was updated elsewhere — reload and try again." };
    }

    // 2. Parent Order → CANCELLED — the atomic one-shot gate for the reversal
    //    below. 0 rows ⇒ the order was shipped / delivered / cancelled since we
    //    read it ⇒ abort the WHOLE tx (rolls back the SellerOrder write) so
    //    inventory is never restored against an order that's still live.
    const cancelledOrder = await tx.$executeRaw`
      UPDATE "Order" SET "status" = 'CANCELLED', "updatedAt" = now()
      WHERE "id" = ${so.order.id}
        AND "status" IN ('PENDING_PAYMENT', 'PENDING', 'PROCESSING')`;
    if (cancelledOrder === 0) throw new ParentOrderMovedError();

    // 3. Reverse exactly what checkout's SALE deducted — OfferInventory per
    //    OrderItem.offerId + OfferAdjustment(CANCELLATION). Same as
    //    cancelOrderAction's offer-native branch. Runs at most once (step 2 gate).
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

    // 4. Undo the soldCount bump checkout made (never below zero).
    for (const [productId, qty] of soldBackByProduct) {
      await tx.$executeRaw`
        UPDATE "Product" SET "soldCount" = GREATEST(0, "soldCount" - ${qty})
        WHERE "id" = ${productId}`;
    }

    // 5. Settlement clawback — ONLY if this SellerOrder was somehow already
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

    // 6. Timeline event on the customer-facing order.
    await tx.orderEvent.create({
      data: {
        orderId: so.order.id,
        status: "CANCELLED",
        title: "Order cancelled",
        detail: `Cancelled by the seller. Reason: ${cleanReason}`,
      },
    });

    return {
      ok: true,
      from: so.status as SellerOrderStatus,
      orderId: so.order.id,
      orderNumber: so.order.orderNumber,
      previousParentStatus: so.order.status,
      restockedUnits,
      restockedLines,
      clawbackEvents,
    };
  };

  try {
    if (externalTx) return await run(externalTx);
    return await prisma.$transaction(run);
  } catch (err) {
    if (err instanceof ParentOrderMovedError) {
      return { ok: false, code: "CONFLICT", error: "The order changed while you were cancelling it. Reload and try again." };
    }
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

function resolveShipment(
  input: ShipmentInput,
): { ok: true; data: { carrier: string; carrierName: string | null; trackingNumber: string | null; trackingUrl: string | null; note: string | null } } | { ok: false; error: string } {
  const carrier = input.carrier?.trim();
  if (!carrier || !isCourierCode(carrier)) return { ok: false, error: "Choose a valid carrier." };
  const def = getCourier(carrier);

  const trackingNumber = input.trackingNumber?.trim() || null;
  if (trackingNumber && !/^[A-Za-z0-9_-]{1,40}$/.test(trackingNumber)) {
    return { ok: false, error: "Tracking number: up to 40 letters, numbers, hyphens or underscores." };
  }
  if (def?.requiresTracking && !trackingNumber) {
    return { ok: false, error: `${def.name} needs a tracking number.` };
  }

  let carrierName = input.carrierName?.trim() || null;
  if (carrier === "OTHER" && !carrierName) return { ok: false, error: "Enter the courier name." };
  if (!carrierName && carrier !== "OTHER") carrierName = def?.name ?? null;

  let trackingUrl = input.trackingUrl?.trim() || null;
  if (trackingUrl && !isSafeTrackingUrl(trackingUrl)) {
    return { ok: false, error: "Tracking link must be a valid https:// URL." };
  }
  if (!trackingUrl && trackingNumber) trackingUrl = buildTrackingUrl(carrier, trackingNumber);

  const note = input.note?.trim() || null;
  if (note && note.length > 300) return { ok: false, error: "Note is too long (max 300)." };

  return { ok: true, data: { carrier, carrierName, trackingNumber, trackingUrl, note } };
}

/**
 * Create the SellerOrder's shipment, or update it if one already exists. MVP:
 * exactly one shipment per SellerOrder (the schema comment) — a second create is
 * refused. Scoped so a seller can only ever touch a shipment on THEIR own
 * SellerOrder.
 */
export async function saveSellerShipment(
  ctx: SellerContext,
  sellerOrderId: string,
  input: ShipmentInput,
  shipmentId?: string,
  externalTx?: Prisma.TransactionClient,
): Promise<SaveShipmentResult> {
  const resolved = resolveShipment(input);
  if (!resolved.ok) return { ok: false, code: "VALIDATION", error: resolved.error };

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
