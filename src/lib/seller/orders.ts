import "server-only";
import {
  listSellerOrders,
  countSellerOrders,
  sellerOrderStatusCounts,
  getSellerOrderForSeller,
} from "@/lib/marketplace/seller-order-repository";
import {
  allowedSellerOrderMoves,
  isParentOrderFulfillable,
} from "@/lib/marketplace/seller-order-status";
import { getCourier } from "@/lib/orders/couriers";
import type { SellerContext } from "@/lib/marketplace/types";

/** Read models for the `/seller/orders` pages. All seller-scoped via the repo. */

const PAGE_SIZE = 20;

function safeAddress(json: string | null): Record<string, string> | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" ? (v as Record<string, string>) : null;
  } catch {
    return null;
  }
}

export type SellerOrderRow = {
  id: string;
  orderNumber: string;
  status: string;
  parentStatus: string;
  placedAt: Date;
  itemCount: number;
  total: number;
  hasShipment: boolean;
};

export async function listSellerOrdersPage(
  ctx: SellerContext,
  opts: { status?: string; q?: string; page?: number } = {},
) {
  const page = Math.max(1, opts.page ?? 1);
  const filters = {
    status: opts.status && opts.status !== "ALL" ? opts.status : undefined,
    q: opts.q?.trim() || undefined,
  };
  const [rows, total] = await Promise.all([
    listSellerOrders(ctx, { ...filters, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
    countSellerOrders(ctx, filters),
  ]);

  return {
    rows: rows.map<SellerOrderRow>((r) => ({
      id: r.id,
      orderNumber: r.order.orderNumber,
      status: r.status,
      parentStatus: r.order.status,
      placedAt: r.order.placedAt,
      itemCount: r.items.reduce((n, i) => n + i.quantity, 0),
      total: r.total,
      hasShipment: r.shipments.length > 0,
    })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}

export async function getSellerOrderCounts(ctx: SellerContext) {
  const counts = await sellerOrderStatusCounts(ctx);
  const open = counts.PENDING_PAYMENT + counts.PROCESSING + counts.READY_TO_SHIP;
  return { counts, open };
}

export type SellerOrderShipmentView = {
  id: string;
  carrier: string | null;
  carrierName: string | null;
  carrierLabel: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
  status: string;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  note: string | null;
};

export type SellerOrderDetailView = {
  id: string;
  orderNumber: string;
  status: string;
  parentStatus: string;
  parentFulfillable: boolean;
  parentCancelled: boolean;
  placedAt: Date;
  updatedAt: Date;
  shippingMethodName: string | null;
  merchandiseSubtotal: number;
  discountAllocated: number;
  shippingFee: number;
  total: number;
  ship: {
    recipient: string;
    phone: string | null;
    lines: string[];
  } | null;
  items: {
    id: string;
    name: string;
    variantLabel: string | null;
    sku: string | null;
    imageUrl: string | null;
    unitPrice: number;
    quantity: number;
    lineTotal: number;
  }[];
  shipment: SellerOrderShipmentView | null;
  allowedMoves: string[];
};

export async function getSellerOrderDetail(
  ctx: SellerContext,
  sellerOrderId: string,
): Promise<SellerOrderDetailView | null> {
  const so = await getSellerOrderForSeller(ctx, sellerOrderId);
  if (!so) return null;

  const addr = safeAddress(so.order.shippingAddress);
  const ship = addr
    ? {
        recipient:
          [addr.firstName, addr.lastName].filter(Boolean).join(" ") || addr.recipient || "—",
        phone: addr.phone || null,
        lines: [
          addr.company || "",
          addr.line1 || "",
          addr.line2 || "",
          [addr.barangay, addr.city].filter(Boolean).join(", "),
          [addr.province, addr.postalCode].filter(Boolean).join(" "),
          addr.region || "",
          addr.country || "",
        ].filter(Boolean),
      }
    : null;

  const s = so.shipments[0] ?? null;
  const shipment: SellerOrderShipmentView | null = s
    ? {
        id: s.id,
        carrier: s.carrier,
        carrierName: s.carrierName,
        carrierLabel: s.carrierName || getCourier(s.carrier)?.name || s.carrier || "—",
        trackingNumber: s.trackingNumber,
        trackingUrl: s.trackingUrl,
        status: s.status,
        shippedAt: s.shippedAt,
        deliveredAt: s.deliveredAt,
        note: s.note,
      }
    : null;

  return {
    id: so.id,
    orderNumber: so.order.orderNumber,
    status: so.status,
    parentStatus: so.order.status,
    parentFulfillable: isParentOrderFulfillable(so.order.status),
    parentCancelled: so.order.status === "CANCELLED",
    placedAt: so.order.placedAt,
    updatedAt: so.updatedAt,
    shippingMethodName: so.shippingMethodName,
    merchandiseSubtotal: so.merchandiseSubtotal,
    discountAllocated: so.discountAllocated,
    shippingFee: so.shippingFee,
    total: so.total,
    ship,
    items: so.items,
    shipment,
    allowedMoves: allowedSellerOrderMoves(so.status, { parentOrderStatus: so.order.status }),
  };
}
