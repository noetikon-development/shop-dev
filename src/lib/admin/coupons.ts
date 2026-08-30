import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { couponState, type CouponState } from "@/lib/coupons";

/**
 * Admin read layer for coupon management (Step 14). Uncached — admins see live
 * data. The lifecycle "state" (Draft / Scheduled / Active / Expired / Disabled /
 * Archived) is DERIVED from `active` + dates + `archivedAt` + usage — there is no
 * second status column.
 *
 * "Uses" shown here is the LIVE count of `CouponRedemption` rows whose order is
 * not CANCELLED — the same number the checkout limit check enforces. The
 * `Coupon.usedCount` mirror is not used for display.
 */

export const COUPONS_PAGE_SIZE = 20;

export type AdminCouponSort = "newest" | "oldest" | "code" | "most_used" | "ending_soon";

export type AdminCouponListFilters = {
  q?: string;
  state?: string;
  sort?: AdminCouponSort;
  page?: number;
};

export type AdminCouponRow = {
  id: string;
  code: string;
  description: string | null;
  type: string;
  value: number;
  maxDiscount: number | null;
  minSubtotal: number;
  startsAt: string | null;
  expiresAt: string | null;
  usageLimit: number | null;
  perCustomerLimit: number | null;
  uses: number;
  state: CouponState;
  createdAt: string;
  updatedAt: string;
};

const SORT_ORDER: Record<AdminCouponSort, Prisma.CouponOrderByWithRelationInput> = {
  newest: { createdAt: "desc" },
  oldest: { createdAt: "asc" },
  code: { code: "asc" },
  most_used: { usedCount: "desc" },
  ending_soon: { expiresAt: "asc" },
};

async function liveUsesByCoupon(couponIds: string[]): Promise<Map<string, number>> {
  if (couponIds.length === 0) return new Map();
  const rows = await prisma.couponRedemption.groupBy({
    by: ["couponId"],
    where: { couponId: { in: couponIds }, order: { status: { not: "CANCELLED" } } },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.couponId, r._count._all]));
}

export async function listAdminCoupons(filters: AdminCouponListFilters) {
  const page = Math.max(1, filters.page ?? 1);
  const sort: AdminCouponSort = filters.sort ?? "newest";
  const now = new Date();

  const where: Prisma.CouponWhereInput = {};
  if (filters.q) {
    const q = filters.q.trim();
    if (q) {
      where.OR = [
        { code: { contains: q, mode: "insensitive" } },
        { description: { contains: q, mode: "insensitive" } },
      ];
    }
  }
  // Archived coupons are hidden unless explicitly requested.
  if (filters.state !== "ARCHIVED") where.archivedAt = null;

  // The state is derived, so it can't be a SQL filter. The coupon set is small —
  // load the (search-)filtered rows, then filter/paginate the state in memory.
  const all = await prisma.coupon.findMany({
    where,
    orderBy: [SORT_ORDER[sort], { id: "asc" }],
  });

  const uses = await liveUsesByCoupon(all.map((c) => c.id));

  let mapped: AdminCouponRow[] = all.map((c) => ({
    id: c.id,
    code: c.code,
    description: c.description,
    type: c.type,
    value: c.value,
    maxDiscount: c.maxDiscount,
    minSubtotal: c.minSubtotal,
    startsAt: c.startsAt?.toISOString() ?? null,
    expiresAt: c.expiresAt?.toISOString() ?? null,
    usageLimit: c.usageLimit,
    perCustomerLimit: c.perCustomerLimit,
    uses: uses.get(c.id) ?? 0,
    state: couponState(c, now),
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  }));

  const STATES: CouponState[] = ["DRAFT", "SCHEDULED", "ACTIVE", "EXPIRED", "DISABLED", "ARCHIVED"];
  if (filters.state && STATES.includes(filters.state as CouponState)) {
    mapped = mapped.filter((c) => c.state === filters.state);
  }

  const total = mapped.length;
  const start = (page - 1) * COUPONS_PAGE_SIZE;
  return {
    rows: mapped.slice(start, start + COUPONS_PAGE_SIZE),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / COUPONS_PAGE_SIZE)),
  };
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export type AdminCouponDetail = Awaited<ReturnType<typeof getAdminCoupon>>;

export async function getAdminCoupon(id: string) {
  const coupon = await prisma.coupon.findUnique({ where: { id } });
  if (!coupon) return null;

  const [uses, recent] = await Promise.all([
    prisma.couponRedemption.count({
      where: { couponId: id, order: { status: { not: "CANCELLED" } } },
    }),
    prisma.couponRedemption.findMany({
      where: { couponId: id },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        code: true,
        amount: true,
        createdAt: true,
        user: { select: { email: true, name: true } },
        order: { select: { orderNumber: true, status: true } },
      },
    }),
  ]);

  return {
    ...coupon,
    startsAt: coupon.startsAt?.toISOString() ?? null,
    expiresAt: coupon.expiresAt?.toISOString() ?? null,
    archivedAt: coupon.archivedAt?.toISOString() ?? null,
    createdAt: coupon.createdAt.toISOString(),
    updatedAt: coupon.updatedAt.toISOString(),
    state: couponState(coupon),
    uses,
    redemptions: recent.map((r) => ({
      id: r.id,
      code: r.code,
      amount: r.amount,
      createdAt: r.createdAt.toISOString(),
      customer: r.user?.name ?? r.user?.email ?? "—",
      orderNumber: r.order.orderNumber,
      orderStatus: r.order.status,
    })),
  };
}
