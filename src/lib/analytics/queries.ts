import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { stockStatus } from "@/lib/inventory-status";
import {
  type ResolvedRange,
  toNaiveUtcLiteral,
  addDays,
} from "@/lib/analytics/range";
import { averageCentavos } from "@/lib/analytics/format";

/**
 * Analytics aggregation (Step 18). Every number here is computed by the
 * database (COUNT / SUM / GROUP BY over indexed columns) — no list of orders or
 * products is ever pulled into memory to be totalled in JS. The browser never
 * supplies a metric; it only chooses the date range.
 *
 * ── Documented metric definitions ───────────────────────────────────────────
 *  Included order  — `placedAt ∈ [range.startUtc, range.endUtc)` AND
 *                    `status NOT IN (CANCELLED)`. This is the set behind
 *                    Orders, Order Value, Gross/Discounts/Shipping/Net, AOV,
 *                    Units Sold, Best-sellers, Category, Coupon analytics.
 *                    (REFUNDED is not produced by any current flow — refunds
 *                    are deferred with PayMongo. If it appears later it must be
 *                    added to EXCLUDED_ORDER_STATUSES.)
 *  Order Value     — SUM(Order.grandTotal) of included orders (authoritative,
 *                    immutable per-order snapshot; never recomputed from
 *                    current prices / coupons / shipping rates).
 *  Gross value     — SUM(Order.subtotal). Discounts — SUM(Order.discountTotal).
 *  Shipping        — SUM(Order.shippingFee). Net value — SUM(Order.grandTotal).
 *  Paid Revenue    — SUM(Order.grandTotal) WHERE paymentStatus = 'PAID'. This
 *                    reads an explicit authoritative field; it is NEVER inferred
 *                    from order creation. No automated payment flow exists yet
 *                    (PayMongo deferred), so this reflects only orders an admin
 *                    or the seed has explicitly reconciled as paid.
 *  Units Sold      — SUM(OrderItem.quantity) for included orders.
 *  Average Order Value — Order Value ÷ included order count (integer centavos,
 *                    rounded; 0 when there are no included orders). Not
 *                    "average paid order value" — it is not payment-based.
 *  Status breakdown — COUNT + SUM(grandTotal) grouped by the real Order.status
 *                    value, INCLUDING cancelled (this is the one place it shows).
 */

export const EXCLUDED_ORDER_STATUSES = ["CANCELLED"] as const;

type RangeBounds = Pick<ResolvedRange, "startUtc" | "endUtc" | "tz">;

const includedOrderWhere = (r: RangeBounds): Prisma.OrderWhereInput => ({
  placedAt: { gte: r.startUtc, lt: r.endUtc },
  status: { notIn: [...EXCLUDED_ORDER_STATUSES] },
});

/** Raw-SQL boundary literals: naive-UTC timestamps matching `Order.placedAt`. */
function bounds(r: RangeBounds) {
  return { lo: toNaiveUtcLiteral(r.startUtc), hi: toNaiveUtcLiteral(r.endUtc) };
}

function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") return Number(v);
  return 0;
}

// ---------------------------------------------------------------------------
// 1. Order summary
// ---------------------------------------------------------------------------

export type OrderSummary = {
  orders: number;
  cancelledOrders: number;
  grossCentavos: number;
  discountCentavos: number;
  shippingCentavos: number;
  netCentavos: number;
  unitsSold: number;
  aovCentavos: number;
};

export async function getOrderSummary(r: RangeBounds): Promise<OrderSummary> {
  const [agg, cancelled, units] = await Promise.all([
    prisma.order.aggregate({
      where: includedOrderWhere(r),
      _count: { _all: true },
      _sum: { subtotal: true, discountTotal: true, shippingFee: true, grandTotal: true },
    }),
    prisma.order.count({
      where: { placedAt: { gte: r.startUtc, lt: r.endUtc }, status: "CANCELLED" },
    }),
    prisma.orderItem.aggregate({
      where: { order: includedOrderWhere(r) },
      _sum: { quantity: true },
    }),
  ]);

  const orders = agg._count._all;
  const netCentavos = num(agg._sum.grandTotal);
  return {
    orders,
    cancelledOrders: cancelled,
    grossCentavos: num(agg._sum.subtotal),
    discountCentavos: num(agg._sum.discountTotal),
    shippingCentavos: num(agg._sum.shippingFee),
    netCentavos,
    unitsSold: num(units._sum.quantity),
    aovCentavos: averageCentavos(netCentavos, orders),
  };
}

// ---------------------------------------------------------------------------
// 2. Order status breakdown (ALL statuses, incl. cancelled)
// ---------------------------------------------------------------------------

export type StatusRow = { status: string; count: number; netCentavos: number };

export async function getStatusBreakdown(r: RangeBounds): Promise<StatusRow[]> {
  const rows = await prisma.order.groupBy({
    by: ["status"],
    where: { placedAt: { gte: r.startUtc, lt: r.endUtc } },
    _count: { _all: true },
    _sum: { grandTotal: true },
  });
  return rows
    .map((row) => ({
      status: row.status,
      count: row._count._all,
      netCentavos: num(row._sum.grandTotal),
    }))
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// 3. Payment / paid-revenue breakdown
// ---------------------------------------------------------------------------

export type PaymentBreakdown = {
  byStatus: { paymentStatus: string; count: number; centavos: number }[];
  paidRevenueCentavos: number;
  paidOrders: number;
};

export async function getPaymentBreakdown(r: RangeBounds): Promise<PaymentBreakdown> {
  const inWindow: Prisma.OrderWhereInput = { placedAt: { gte: r.startUtc, lt: r.endUtc } };
  const [grouped, paid] = await Promise.all([
    prisma.order.groupBy({
      by: ["paymentStatus"],
      where: inWindow,
      _count: { _all: true },
      _sum: { grandTotal: true },
    }),
    prisma.order.aggregate({
      where: { ...inWindow, paymentStatus: "PAID" },
      _count: { _all: true },
      _sum: { grandTotal: true },
    }),
  ]);
  return {
    byStatus: grouped
      .map((g) => ({
        paymentStatus: g.paymentStatus,
        count: g._count._all,
        centavos: num(g._sum.grandTotal),
      }))
      .sort((a, b) => b.count - a.count),
    paidRevenueCentavos: num(paid._sum.grandTotal),
    paidOrders: paid._count._all,
  };
}

// ---------------------------------------------------------------------------
// 4. Daily trend (order count + order value), bucketed by store-local day
// ---------------------------------------------------------------------------

export type TrendPoint = { day: string; orders: number; valueCentavos: number };

export async function getOrderTrend(r: RangeBounds): Promise<TrendPoint[]> {
  const { lo, hi } = bounds(r);
  const rows = await prisma.$queryRaw<{ day: string; orders: number; value: string }[]>(Prisma.sql`
    SELECT (date_trunc('day', "placedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${r.tz})::date)::text AS day,
           COUNT(*)::int AS orders,
           COALESCE(SUM("grandTotal"), 0)::text AS value
    FROM "Order"
    WHERE "placedAt" >= ${lo}::timestamp
      AND "placedAt" <  ${hi}::timestamp
      AND "status" NOT IN ('CANCELLED')
    GROUP BY 1
    ORDER BY 1
  `);

  const byDay = new Map(rows.map((row) => [row.day, row]));
  const series: TrendPoint[] = [];
  // Zero-fill every local calendar day in the range so the chart has no gaps.
  const startDay = firstLocalDay(r);
  const lastDay = lastLocalDay(r);
  for (let day = startDay; day <= lastDay; day = addDays(day, 1)) {
    const hit = byDay.get(day);
    series.push({
      day,
      orders: hit ? num(hit.orders) : 0,
      valueCentavos: hit ? num(hit.value) : 0,
    });
    if (series.length > 400) break; // hard guard (MAX_RANGE_DAYS caps this earlier)
  }
  return series;
}

function firstLocalDay(r: RangeBounds): string {
  return localDay(r.startUtc, r.tz);
}
function lastLocalDay(r: RangeBounds): string {
  // endUtc is exclusive local midnight → the last included day is the day before.
  return addDays(localDay(r.endUtc, r.tz), -1);
}
function localDay(instant: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

// ---------------------------------------------------------------------------
// 5 + 10. Product performance (also powers the best-sellers card + CSV export)
// ---------------------------------------------------------------------------

export type ProductPerfRow = {
  productId: string;
  name: string;
  slug: string;
  status: string;
  units: number;
  orders: number;
  valueCentavos: number;
  avgSellCentavos: number;
  currentStock: number;
  available: number;
};

export type ProductPerfSort = "units" | "value" | "orders";

// Order by the aggregate EXPRESSION (numeric), not the SELECT alias — `value`
// is emitted as text for safe serialisation and would otherwise sort lexically.
const PERF_SORT_EXPR: Record<ProductPerfSort, Prisma.Sql> = {
  units: Prisma.sql`SUM(oi.quantity)`,
  value: Prisma.sql`SUM(oi."lineTotal")`,
  orders: Prisma.sql`COUNT(DISTINCT oi."orderId")`,
};

export async function getProductPerformance(
  r: RangeBounds,
  opts: { page?: number; pageSize?: number; sort?: ProductPerfSort } = {},
): Promise<{ rows: ProductPerfRow[]; total: number; page: number; pageCount: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 10));
  const sort = opts.sort ?? "units";
  const { lo, hi } = bounds(r);

  const [countRow, grouped] = await Promise.all([
    prisma.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT COUNT(DISTINCT oi."productId")::int AS n
      FROM "OrderItem" oi
      JOIN "Order" o ON o.id = oi."orderId"
      WHERE o."placedAt" >= ${lo}::timestamp
        AND o."placedAt" <  ${hi}::timestamp
        AND o."status" NOT IN ('CANCELLED')
    `),
    prisma.$queryRaw<{ productId: string; units: number; orders: number; value: string }[]>(Prisma.sql`
      SELECT oi."productId"                       AS "productId",
             SUM(oi.quantity)::int                AS units,
             COUNT(DISTINCT oi."orderId")::int    AS orders,
             COALESCE(SUM(oi."lineTotal"), 0)::text AS value
      FROM "OrderItem" oi
      JOIN "Order" o ON o.id = oi."orderId"
      WHERE o."placedAt" >= ${lo}::timestamp
        AND o."placedAt" <  ${hi}::timestamp
        AND o."status" NOT IN ('CANCELLED')
      GROUP BY oi."productId"
      ORDER BY ${PERF_SORT_EXPR[sort]} DESC, SUM(oi.quantity) DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    `),
  ]);

  const total = num(countRow[0]?.n);
  const ids = grouped.map((g) => g.productId);
  const products = ids.length
    ? await prisma.product.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          variants: {
            select: {
              inventory: { select: { quantity: true, reserved: true } },
            },
          },
        },
      })
    : [];
  const byId = new Map(products.map((p) => [p.id, p]));

  const rows: ProductPerfRow[] = grouped.map((g) => {
    const p = byId.get(g.productId);
    let currentStock = 0;
    let available = 0;
    for (const v of p?.variants ?? []) {
      if (!v.inventory) continue;
      currentStock += v.inventory.quantity;
      available += Math.max(0, v.inventory.quantity - v.inventory.reserved);
    }
    const units = num(g.units);
    const valueCentavos = num(g.value);
    return {
      productId: g.productId,
      name: p?.name ?? "(deleted product)",
      slug: p?.slug ?? "",
      status: p?.status ?? "UNKNOWN",
      units,
      orders: num(g.orders),
      valueCentavos,
      avgSellCentavos: units > 0 ? Math.round(valueCentavos / units) : 0,
      currentStock,
      available,
    };
  });

  return { rows, total, page, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

// ---------------------------------------------------------------------------
// 11. Category performance
//
// LIMITATION: OrderItem has no historical category snapshot, so this attributes
// each line to the product's CURRENT category. If a product is re-categorised,
// past sales move with it. This is surfaced in the UI, not hidden.
// ---------------------------------------------------------------------------

export type CategoryPerfRow = {
  categoryId: string;
  name: string;
  units: number;
  orders: number;
  valueCentavos: number;
};

export async function getCategoryPerformance(r: RangeBounds): Promise<CategoryPerfRow[]> {
  const { lo, hi } = bounds(r);
  const rows = await prisma.$queryRaw<
    { categoryId: string; name: string; units: number; orders: number; value: string }[]
  >(Prisma.sql`
    SELECT c.id                                 AS "categoryId",
           c.name                               AS name,
           SUM(oi.quantity)::int                AS units,
           COUNT(DISTINCT oi."orderId")::int    AS orders,
           COALESCE(SUM(oi."lineTotal"), 0)::text AS value
    FROM "OrderItem" oi
    JOIN "Order" o    ON o.id = oi."orderId"
    JOIN "Product" p  ON p.id = oi."productId"
    JOIN "Category" c ON c.id = p."categoryId"
    WHERE o."placedAt" >= ${lo}::timestamp
      AND o."placedAt" <  ${hi}::timestamp
      AND o."status" NOT IN ('CANCELLED')
    GROUP BY c.id, c.name
    ORDER BY SUM(oi."lineTotal") DESC
  `);
  return rows.map((row) => ({
    categoryId: row.categoryId,
    name: row.name,
    units: num(row.units),
    orders: num(row.orders),
    valueCentavos: num(row.value),
  }));
}

// ---------------------------------------------------------------------------
// 12 + 13. Customer metrics
//
// Definitions:
//  Total customers        — User rows with role 'CUSTOMER' (the maintained
//                           coarse mirror of the RBAC tables). All-time.
//  New customers          — those whose `createdAt` falls in the range.
//  Customers with orders  — distinct non-null Order.userId for included orders
//                           in the range.
//  Repeat customers       — customers with ≥ 2 included orders in the range.
//  Avg orders / customer  — included orders with a user ÷ customers with orders.
//  Guest orders           — included orders with a null userId (shown for
//                           context; they have no customer record).
// ---------------------------------------------------------------------------

export type CustomerMetrics = {
  totalCustomers: number;
  newCustomers: number;
  customersWithOrders: number;
  repeatCustomers: number;
  guestOrders: number;
  avgOrdersPerCustomer: number;
  allTimeCustomersWithOrders: number;
};

export async function getCustomerMetrics(r: RangeBounds): Promise<CustomerMetrics> {
  const { lo, hi } = bounds(r);
  const included = includedOrderWhere(r);

  const [total, newC, withOrdersRow, repeatRow, guest, ordersWithUser, allTimeRow] = await Promise.all([
    prisma.user.count({ where: { role: "CUSTOMER" } }),
    prisma.user.count({ where: { role: "CUSTOMER", createdAt: { gte: r.startUtc, lt: r.endUtc } } }),
    prisma.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT COUNT(DISTINCT "userId")::int AS n
      FROM "Order"
      WHERE "placedAt" >= ${lo}::timestamp AND "placedAt" < ${hi}::timestamp
        AND "status" NOT IN ('CANCELLED') AND "userId" IS NOT NULL
    `),
    prisma.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT COUNT(*)::int AS n FROM (
        SELECT "userId"
        FROM "Order"
        WHERE "placedAt" >= ${lo}::timestamp AND "placedAt" < ${hi}::timestamp
          AND "status" NOT IN ('CANCELLED') AND "userId" IS NOT NULL
        GROUP BY "userId"
        HAVING COUNT(*) >= 2
      ) t
    `),
    prisma.order.count({ where: { ...included, userId: null } }),
    prisma.order.count({ where: { ...included, userId: { not: null } } }),
    prisma.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT COUNT(DISTINCT "userId")::int AS n
      FROM "Order" WHERE "status" NOT IN ('CANCELLED') AND "userId" IS NOT NULL
    `),
  ]);

  const customersWithOrders = num(withOrdersRow[0]?.n);
  return {
    totalCustomers: total,
    newCustomers: newC,
    customersWithOrders,
    repeatCustomers: num(repeatRow[0]?.n),
    guestOrders: guest,
    avgOrdersPerCustomer:
      customersWithOrders > 0 ? Math.round((ordersWithUser / customersWithOrders) * 100) / 100 : 0,
    allTimeCustomersWithOrders: num(allTimeRow[0]?.n),
  };
}

// ---------------------------------------------------------------------------
// 14. Coupon analytics — from immutable CouponRedemption snapshots
// ---------------------------------------------------------------------------

export type CouponMetrics = {
  redemptions: number;
  discountCentavos: number;
  top: { code: string; redemptions: number; discountCentavos: number }[];
};

export async function getCouponMetrics(r: RangeBounds): Promise<CouponMetrics> {
  // A redemption counts when its order is not cancelled (mirrors the checkout
  // usage-limit rule). `amount` is the discount snapshot taken at order time —
  // never the current Coupon config.
  const where: Prisma.CouponRedemptionWhereInput = {
    createdAt: { gte: r.startUtc, lt: r.endUtc },
    order: { status: { not: "CANCELLED" } },
  };
  const [agg, byCode] = await Promise.all([
    prisma.couponRedemption.aggregate({ where, _count: { _all: true }, _sum: { amount: true } }),
    prisma.couponRedemption.groupBy({
      by: ["code"],
      where,
      _count: { _all: true },
      _sum: { amount: true },
      orderBy: { _count: { code: "desc" } },
      take: 5,
    }),
  ]);
  return {
    redemptions: agg._count._all,
    discountCentavos: num(agg._sum.amount),
    top: byCode.map((c) => ({
      code: c.code,
      redemptions: c._count._all,
      discountCentavos: num(c._sum.amount),
    })),
  };
}

/** Exact distinct-coupon count for the range (no `take` cap). */
export async function getDistinctCouponCount(r: RangeBounds): Promise<number> {
  const rows = await prisma.couponRedemption.groupBy({
    by: ["code"],
    where: {
      createdAt: { gte: r.startUtc, lt: r.endUtc },
      order: { status: { not: "CANCELLED" } },
    },
  });
  return rows.length;
}

// ---------------------------------------------------------------------------
// 15. Inventory insights (current state — NOT range-scoped, read-only)
// ---------------------------------------------------------------------------

export type InventoryInsights = {
  activeVariants: number;
  totalVariants: number;
  outOfStock: number;
  lowStock: number;
  productsNeedingReorder: number;
  retailValueCentavos: number;
  costValueCentavos: number | null;
  costCoverage: { withCost: number; total: number };
};

export async function getInventoryInsights(): Promise<InventoryInsights> {
  const [activeVariants, totalVariants, statusRow, reorderRow, valueRow] = await Promise.all([
    prisma.variant.count({ where: { status: "ACTIVE" } }),
    prisma.variant.count(),
    prisma.$queryRaw<{ out: number; low: number }[]>(Prisma.sql`
      SELECT
        COUNT(*) FILTER (WHERE i.quantity - i.reserved <= 0)::int AS out,
        COUNT(*) FILTER (WHERE i.quantity - i.reserved > 0
                           AND i.quantity - i.reserved <= i."reorderPoint")::int AS low
      FROM "Inventory" i
      JOIN "Variant" v ON v.id = i."variantId"
      WHERE v.status = 'ACTIVE'
    `),
    prisma.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT COUNT(DISTINCT v."productId")::int AS n
      FROM "Inventory" i
      JOIN "Variant" v ON v.id = i."variantId"
      WHERE v.status = 'ACTIVE' AND i.quantity - i.reserved <= i."reorderPoint"
    `),
    prisma.$queryRaw<{ retail: string; cost: string | null; withcost: number; total: number }[]>(Prisma.sql`
      SELECT
        COALESCE(SUM(i.quantity * v.price), 0)::text AS retail,
        SUM(i.quantity * p."costPrice")::text        AS cost,
        COUNT(*) FILTER (WHERE p."costPrice" IS NOT NULL)::int AS withcost,
        COUNT(*)::int                                AS total
      FROM "Inventory" i
      JOIN "Variant" v ON v.id = i."variantId"
      JOIN "Product" p ON p.id = v."productId"
      WHERE v.status = 'ACTIVE'
    `),
  ]);

  const v = valueRow[0];
  return {
    activeVariants,
    totalVariants,
    outOfStock: num(statusRow[0]?.out),
    lowStock: num(statusRow[0]?.low),
    productsNeedingReorder: num(reorderRow[0]?.n),
    retailValueCentavos: num(v?.retail),
    costValueCentavos: v?.cost == null ? null : num(v.cost),
    costCoverage: { withCost: num(v?.withcost), total: num(v?.total) },
  };
}

// ---------------------------------------------------------------------------
// 16. Low-stock report (current state, read-only, paginated in memory)
// ---------------------------------------------------------------------------

export type LowStockRow = {
  productId: string;
  productName: string;
  productSlug: string;
  optionLabel: string;
  sku: string;
  onHand: number;
  reserved: number;
  available: number;
  reorderPoint: number;
  status: "LOW_STOCK" | "OUT_OF_STOCK";
};

export async function getLowStockReport(
  opts: { page?: number; pageSize?: number } = {},
): Promise<{ rows: LowStockRow[]; total: number; page: number; pageCount: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 25));

  // Catalog is a few hundred variants — load ACTIVE ones, filter the derived
  // "available ≤ reorderPoint" condition in memory (same pattern as
  // src/lib/admin/inventory.ts). No stock is touched.
  const all = await prisma.inventory.findMany({
    where: { variant: { status: "ACTIVE" } },
    select: {
      sku: true,
      quantity: true,
      reserved: true,
      reorderPoint: true,
      variant: {
        select: {
          product: { select: { id: true, name: true, slug: true } },
          optionValues: {
            select: { optionValue: { select: { value: true, option: { select: { name: true } } } } },
          },
        },
      },
    },
  });

  const flagged: LowStockRow[] = [];
  for (const inv of all) {
    const status = stockStatus(inv.quantity, inv.reserved, inv.reorderPoint);
    if (status !== "LOW_STOCK" && status !== "OUT_OF_STOCK") continue;
    flagged.push({
      productId: inv.variant.product.id,
      productName: inv.variant.product.name,
      productSlug: inv.variant.product.slug,
      optionLabel:
        inv.variant.optionValues
          .map((ov) => `${ov.optionValue.option.name}: ${ov.optionValue.value}`)
          .join(" · ") || "Default",
      sku: inv.sku,
      onHand: inv.quantity,
      reserved: inv.reserved,
      available: Math.max(0, inv.quantity - inv.reserved),
      reorderPoint: inv.reorderPoint,
      status,
    });
  }
  flagged.sort(
    (a, b) =>
      a.onHand - a.reserved - (b.onHand - b.reserved) || a.productName.localeCompare(b.productName),
  );

  const total = flagged.length;
  const start = (page - 1) * pageSize;
  return {
    rows: flagged.slice(start, start + pageSize),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

// ---------------------------------------------------------------------------
// Dashboard aggregator
// ---------------------------------------------------------------------------

export type DashboardData = {
  summary: OrderSummary;
  previousSummary: OrderSummary | null;
  status: StatusRow[];
  payment: PaymentBreakdown;
  previousPayment: PaymentBreakdown | null;
  trend: TrendPoint[];
  topProducts: ProductPerfRow[];
  productTotal: number;
  categories: CategoryPerfRow[];
  customers: CustomerMetrics;
  coupons: CouponMetrics;
  distinctCoupons: number;
  inventory: InventoryInsights;
  lowStock: { rows: LowStockRow[]; total: number };
  hasAnyData: boolean;
};

export async function loadDashboard(
  range: RangeBounds,
  opts: { previous?: RangeBounds | null; productSort?: ProductPerfSort } = {},
): Promise<DashboardData> {
  const prev = opts.previous ?? null;

  const [
    summary,
    previousSummary,
    status,
    payment,
    previousPayment,
    trend,
    productPerf,
    categories,
    customers,
    coupons,
    distinctCoupons,
    inventory,
    lowStock,
  ] = await Promise.all([
    getOrderSummary(range),
    prev ? getOrderSummary(prev) : Promise.resolve(null),
    getStatusBreakdown(range),
    getPaymentBreakdown(range),
    prev ? getPaymentBreakdown(prev) : Promise.resolve(null),
    getOrderTrend(range),
    getProductPerformance(range, { page: 1, pageSize: 10, sort: opts.productSort ?? "units" }),
    getCategoryPerformance(range),
    getCustomerMetrics(range),
    getCouponMetrics(range),
    getDistinctCouponCount(range),
    getInventoryInsights(),
    getLowStockReport({ page: 1, pageSize: 8 }),
  ]);

  const hasAnyData =
    summary.orders > 0 ||
    summary.cancelledOrders > 0 ||
    customers.newCustomers > 0 ||
    coupons.redemptions > 0;

  return {
    summary,
    previousSummary,
    status,
    payment,
    previousPayment,
    trend,
    topProducts: productPerf.rows,
    productTotal: productPerf.total,
    categories,
    customers,
    coupons,
    distinctCoupons,
    inventory,
    lowStock: { rows: lowStock.rows, total: lowStock.total },
    hasAnyData,
  };
}
