import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isPaymentStatus } from "@/lib/payments/status";
import { getPaymentsConfig } from "@/lib/payments/config";

/**
 * Admin read layer for Payments (Step 21 P4). Uncached — admins see live data.
 * Server-side paginated. Phase 4-A: there are no Payment rows, so every list is
 * empty; the screen still renders so RBAC + the "feature disabled" banner are
 * verifiable end to end.
 */

export const PAYMENTS_PAGE_SIZE = 25;

export type AdminPaymentRow = {
  id: string;
  orderId: string;
  orderNumber: string;
  customerEmail: string;
  provider: string;
  providerId: string;
  status: string;
  amount: number;
  currency: string;
  method: string | null;
  paidAt: string | null;
  refundedAmount: number;
  createdAt: string;
};

export type AdminPaymentsListFilters = {
  q?: string;
  status?: string;
  range?: string;
  page?: number;
};

const RANGE_DAYS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 };

export async function listAdminPayments(filters: AdminPaymentsListFilters) {
  const page = Math.max(1, filters.page ?? 1);
  const AND: Prisma.PaymentWhereInput[] = [];

  if (filters.q?.trim()) {
    const q = filters.q.trim();
    AND.push({
      OR: [
        { providerId: { contains: q, mode: "insensitive" } },
        { order: { is: { orderNumber: { contains: q, mode: "insensitive" } } } },
        { order: { is: { email: { contains: q, mode: "insensitive" } } } },
      ],
    });
  }
  if (filters.status && isPaymentStatus(filters.status)) AND.push({ status: filters.status });
  if (filters.range && RANGE_DAYS[filters.range]) {
    AND.push({ createdAt: { gte: new Date(Date.now() - RANGE_DAYS[filters.range] * 864e5) } });
  }

  const where: Prisma.PaymentWhereInput = AND.length ? { AND } : {};

  const [rows, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: (page - 1) * PAYMENTS_PAGE_SIZE,
      take: PAYMENTS_PAGE_SIZE,
      select: {
        id: true,
        orderId: true,
        provider: true,
        providerId: true,
        status: true,
        amount: true,
        currency: true,
        method: true,
        paidAt: true,
        createdAt: true,
        order: { select: { orderNumber: true, email: true } },
        refunds: { where: { status: "SUCCEEDED" }, select: { amount: true } },
      },
    }),
    prisma.payment.count({ where }),
  ]);

  const mapped: AdminPaymentRow[] = rows.map((p) => ({
    id: p.id,
    orderId: p.orderId,
    orderNumber: p.order.orderNumber,
    customerEmail: p.order.email,
    provider: p.provider,
    providerId: p.providerId,
    status: p.status,
    amount: p.amount,
    currency: p.currency,
    method: p.method,
    paidAt: p.paidAt?.toISOString() ?? null,
    refundedAmount: p.refunds.reduce((n, r) => n + r.amount, 0),
    createdAt: p.createdAt.toISOString(),
  }));

  return {
    rows: mapped,
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / PAYMENTS_PAGE_SIZE)),
  };
}

/** Payment(s) for one order — used by the order-detail Payment panel. */
export async function getOrderPayments(orderId: string) {
  const rows = await prisma.payment.findMany({
    where: { orderId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      provider: true,
      providerObject: true,
      providerId: true,
      status: true,
      amount: true,
      currency: true,
      method: true,
      paidAt: true,
      failureReason: true,
      checkoutUrl: true,
      createdAt: true,
      updatedAt: true,
      refunds: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          amount: true,
          providerId: true,
          failureReason: true,
          succeededAt: true,
          createdAt: true,
          returnRequest: { select: { returnNumber: true } },
        },
      },
    },
  });
  return rows.map((p) => ({
    ...p,
    paidAt: p.paidAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    refunds: p.refunds.map((r) => ({
      ...r,
      succeededAt: r.succeededAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
  }));
}

/** Counts per status for the list header. */
export async function getPaymentCounts(): Promise<Record<string, number>> {
  const groups = await prisma.payment.groupBy({ by: ["status"], _count: { _all: true } });
  const out: Record<string, number> = { ALL: 0 };
  for (const g of groups) {
    out[g.status] = g._count._all;
    out.ALL += g._count._all;
  }
  return out;
}

/**
 * Orders that look stuck: PENDING_PAYMENT for > 24h with an AWAITING_PAYMENT
 * payment (a webhook may have been missed). Empty in Phase 4-A.
 */
export async function listStuckPayments() {
  return prisma.payment.findMany({
    where: {
      status: "AWAITING_PAYMENT",
      createdAt: { lt: new Date(Date.now() - 24 * 3600e3) },
      order: { is: { status: "PENDING_PAYMENT" } },
    },
    select: {
      id: true,
      providerId: true,
      amount: true,
      createdAt: true,
      order: { select: { id: true, orderNumber: true } },
    },
  });
}

export async function getPaymentsAdminConfig() {
  return getPaymentsConfig();
}
