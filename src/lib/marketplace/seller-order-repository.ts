import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  canTransitionSellerOrder,
  isSellerOrderStatus,
  shipmentStatusForSellerOrder,
  type SellerOrderStatus,
} from "@/lib/marketplace/seller-order-status";
import { getCourier, isCourierCode, isSafeTrackingUrl, buildTrackingUrl } from "@/lib/orders/couriers";
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
 * 9F-2 NEVER touches: `Order.status`, `OrderEvent`, the parent order's
 * courier/tracking columns, `Inventory` / `InventoryAdjustment` / `Variant.stock`,
 * `OfferInventory`, payments, settlement. It only writes `SellerOrder.status`
 * and `Shipment`.
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
      order: { select: { orderNumber: true, status: true, placedAt: true, shippingAddress: true } },
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

export type SellerOrderMutationResult = { ok: true; status: SellerOrderStatus } | SellerOrderRepoError;

/**
 * Advance a SellerOrder along its own fulfilment machine. Guards:
 *   - the SellerOrder belongs to `ctx.sellerId`
 *   - the parent `Order.status` permits fulfilment (never PENDING_PAYMENT / CANCELLED)
 *   - the transition is a declared forward move (or the READY_TO_SHIP→PROCESSING un-ready)
 *   - SHIPPED requires a shippable Shipment (carrier set + tracking present unless
 *     the carrier needs none)
 * On SHIPPED / DELIVERED the seller's own Shipment rows are stamped to match.
 * `Order.status` / `OrderEvent` are NOT touched.
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
        order: { select: { status: true } },
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

    return { ok: true, status: to };
  };

  try {
    if (externalTx) return await run(externalTx);
    return await prisma.$transaction(run);
  } catch (err) {
    console.error("[seller-order-repository] advanceSellerOrderStatus failed", err);
    return { ok: false, code: "VALIDATION", error: "Could not update the order." };
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
