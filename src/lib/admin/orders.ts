import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isOrderStatus } from "@/lib/orders/status";

/**
 * Admin read layer for Order Management (Step 12). Uncached — admins see live
 * data. Every query is server-side paginated and selects only what the screen
 * needs; the browser never receives the full order dataset.
 *
 * Historical accuracy: the order list and detail read the immutable snapshots
 * already stored on Order / OrderItem (name, SKU, unit price, line total,
 * address JSON, shipping method code/name/fee, totals). The current Product /
 * ShippingMethod / Address records are never consulted to represent a past
 * order.
 */

export const ORDERS_PAGE_SIZE = 20;

export type AdminOrderSort =
  | "newest"
  | "oldest"
  | "total_desc"
  | "total_asc"
  | "updated";

export type AdminOrderListFilters = {
  q?: string;
  status?: string;
  paymentStatus?: string;
  range?: string; // "7d" | "30d" | "90d"
  sort?: AdminOrderSort;
  page?: number;
};

export type AdminOrderRow = {
  id: string;
  orderNumber: string;
  customerName: string;
  customerEmail: string;
  placedAt: string;
  updatedAt: string;
  status: string;
  paymentStatus: string;
  paymentMethod: string;
  shippingMethodLabel: string;
  courier: string | null;
  courierName: string | null;
  trackingNumber: string | null;
  itemCount: number;
  grandTotal: number;
};

const RANGE_DAYS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 };

const SORT_ORDER: Record<AdminOrderSort, Prisma.OrderOrderByWithRelationInput> = {
  newest: { placedAt: "desc" },
  oldest: { placedAt: "asc" },
  total_desc: { grandTotal: "desc" },
  total_asc: { grandTotal: "asc" },
  updated: { updatedAt: "desc" },
};

function shippingLabel(o: { shippingMethodName: string | null; shippingMethod: string }): string {
  if (o.shippingMethodName) return o.shippingMethodName;
  // Pre-Step-11 orders only have the legacy code/id string.
  return o.shippingMethod ? o.shippingMethod : "—";
}

export async function listAdminOrders(filters: AdminOrderListFilters) {
  const page = Math.max(1, filters.page ?? 1);
  const sort: AdminOrderSort = filters.sort ?? "newest";

  const AND: Prisma.OrderWhereInput[] = [];

  if (filters.q) {
    const q = filters.q.trim();
    if (q) {
      AND.push({
        OR: [
          { orderNumber: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
          { trackingNumber: { contains: q, mode: "insensitive" } },
          { user: { is: { name: { contains: q, mode: "insensitive" } } } },
          { user: { is: { email: { contains: q, mode: "insensitive" } } } },
        ],
      });
    }
  }

  if (filters.status && isOrderStatus(filters.status)) {
    AND.push({ status: filters.status });
  }
  if (filters.paymentStatus && /^[A-Z_]{2,20}$/.test(filters.paymentStatus)) {
    AND.push({ paymentStatus: filters.paymentStatus });
  }
  if (filters.range && RANGE_DAYS[filters.range]) {
    const cutoff = new Date(Date.now() - RANGE_DAYS[filters.range] * 24 * 60 * 60 * 1000);
    AND.push({ placedAt: { gte: cutoff } });
  }

  const where: Prisma.OrderWhereInput = AND.length ? { AND } : {};

  const [rows, total] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: [SORT_ORDER[sort], { id: "asc" }],
      skip: (page - 1) * ORDERS_PAGE_SIZE,
      take: ORDERS_PAGE_SIZE,
      select: {
        id: true,
        orderNumber: true,
        email: true,
        placedAt: true,
        updatedAt: true,
        status: true,
        paymentStatus: true,
        paymentMethod: true,
        shippingMethod: true,
        shippingMethodName: true,
        courier: true,
        courierName: true,
        trackingNumber: true,
        grandTotal: true,
        user: { select: { name: true, email: true } },
        _count: { select: { items: true } },
      },
    }),
    prisma.order.count({ where }),
  ]);

  const mapped: AdminOrderRow[] = rows.map((o) => ({
    id: o.id,
    orderNumber: o.orderNumber,
    customerName: o.user?.name ?? "—",
    customerEmail: o.user?.email ?? o.email,
    placedAt: o.placedAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
    status: o.status,
    paymentStatus: o.paymentStatus,
    paymentMethod: o.paymentMethod,
    shippingMethodLabel: shippingLabel(o),
    courier: o.courier,
    courierName: o.courierName,
    trackingNumber: o.trackingNumber,
    itemCount: o._count.items,
    grandTotal: o.grandTotal,
  }));

  return {
    rows: mapped,
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / ORDERS_PAGE_SIZE)),
  };
}

// ---------------------------------------------------------------------------
// Order detail
// ---------------------------------------------------------------------------

export type AdminOrderDetail = Awaited<ReturnType<typeof getAdminOrder>>;

function parseAddress(json: string | null): Record<string, string> | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" ? (v as Record<string, string>) : null;
  } catch {
    return null;
  }
}

export async function getAdminOrder(id: string) {
  const order = await prisma.order.findUnique({
    where: { id },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      paymentStatus: true,
      paymentMethod: true,
      email: true,
      phone: true,
      placedAt: true,
      updatedAt: true,
      note: true,
      subtotal: true,
      shippingFee: true,
      discountTotal: true,
      grandTotal: true,
      couponCode: true,
      shippingMethod: true,
      shippingMethodCode: true,
      shippingMethodName: true,
      shippingAddress: true,
      billingAddress: true,
      courier: true,
      courierName: true,
      trackingNumber: true,
      trackingUrl: true,
      shippedAt: true,
      deliveredAt: true,
      fulfillmentNote: true,
      user: { select: { id: true, name: true, email: true, phone: true } },
      items: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          name: true,
          variantLabel: true,
          sku: true,
          imageUrl: true,
          unitPrice: true,
          quantity: true,
          lineTotal: true,
          productId: true,
          variantId: true,
        },
      },
      events: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          status: true,
          title: true,
          detail: true,
          location: true,
          createdAt: true,
        },
      },
      // Presence of an online payment attempt — used to decide whether the
      // "Confirm order" (pay-on-delivery) action applies. An order with one of
      // these is confirmed only by the verified PayMongo webhook.
      payments: {
        where: { status: { in: ["PENDING", "AWAITING_PAYMENT", "PAID", "PARTIALLY_REFUNDED", "REFUNDED"] } },
        select: { id: true },
        take: 1,
      },
    },
  });

  if (!order) return null;

  const shippingAddress = parseAddress(order.shippingAddress);
  const snapshotName =
    [shippingAddress?.firstName, shippingAddress?.lastName].filter(Boolean).join(" ") ||
    shippingAddress?.recipient ||
    "";

  const { payments, ...rest } = order;

  return {
    ...rest,
    placedAt: order.placedAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    shippedAt: order.shippedAt?.toISOString() ?? null,
    deliveredAt: order.deliveredAt?.toISOString() ?? null,
    events: order.events.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
    /** True when an online payment attempt exists — "Confirm order" then does NOT apply. */
    hasOnlinePayment: payments.length > 0,
    shippingAddress,
    billingAddress: parseAddress(order.billingAddress),
    // Header convenience: the linked account name, else the (immutable) shipping
    // snapshot name.
    customerName: order.user?.name || snapshotName || "—",
  };
}

/** Distinct payment-status values present, for the list filter dropdown. */
export async function orderPaymentStatuses(): Promise<string[]> {
  const rows = await prisma.order.findMany({
    distinct: ["paymentStatus"],
    select: { paymentStatus: true },
    orderBy: { paymentStatus: "asc" },
  });
  return rows.map((r) => r.paymentStatus);
}
