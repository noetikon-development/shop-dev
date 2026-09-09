import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isPaymentStatus } from "@/lib/payments/status";
import { getPaymentsConfig } from "@/lib/payments/config";
import { writeAudit } from "@/lib/admin/audit";
import { cleanUserText } from "@/lib/ugc";

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

/**
 * 9F-43B — the latest `order.cod_payment_confirmed` audit row for an order, for
 * the admin order-detail "COD payment recorded on … by …" display. Null when
 * COD cash has not been confirmed. Follows the audit-display pattern used by the
 * seller-product-request detail view.
 */
export async function getCodPaymentConfirmation(orderId: string): Promise<{
  at: string;
  byEmail: string | null;
  reference: string | null;
  amountConfirmed: number | null;
} | null> {
  const row = await prisma.adminAuditLog.findFirst({
    where: { action: "order.cod_payment_confirmed", targetType: "order", targetId: orderId },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, meta: true, actor: { select: { email: true } } },
  });
  if (!row) return null;
  let reference: string | null = null;
  let amountConfirmed: number | null = null;
  try {
    const meta = JSON.parse(row.meta) as Record<string, unknown>;
    reference = typeof meta.remittanceReference === "string" && meta.remittanceReference.trim() ? meta.remittanceReference : null;
    amountConfirmed = typeof meta.amountConfirmed === "number" ? meta.amountConfirmed : null;
  } catch {
    // leave defaults
  }
  return { at: row.createdAt.toISOString(), byEmail: row.actor?.email ?? null, reference, amountConfirmed };
}

// ---------------------------------------------------------------------------
// 9F-43B — COD cash collection confirmation (core)
// ---------------------------------------------------------------------------

/**
 * Payment.status values that mean "this order carries a real online payment
 * attempt" — the set the admin order detail query already uses for
 * `hasOnlinePayment`. An order with any such row is NEVER treated as COD.
 */
export const COD_ONLINE_PAYMENT_STATUSES = ["PENDING", "AWAITING_PAYMENT", "PAID", "PARTIALLY_REFUNDED", "REFUNDED"] as const;

export type ConfirmCodPaymentInput = {
  orderId: string;
  remittanceReference?: string | null;
  note?: string | null;
};

export type ConfirmCodPaymentResult =
  | { ok: true; alreadyConfirmed?: boolean }
  | {
      ok: false;
      code:
        | "NOT_FOUND"
        | "HAS_ONLINE_PAYMENT"
        | "NOT_COD"
        | "NOT_DELIVERED"
        | "CANCELLED"
        | "REFUNDED"
        | "INVALID_STATE";
      error: string;
    };

class CodConfirmConflict extends Error {}

/**
 * Record that Axiaro has received the remitted COD cash for a delivered
 * cash-on-delivery order: `paymentStatus` PENDING/UNPAID → PAID. This is the
 * reusable core — the `manage_payments` permission check lives in the thin
 * server action (`confirmCodPaymentAction` in `payment-actions.ts`); this
 * function takes an explicit `actor` and is `client`-aware for tests, exactly
 * like `recordSettlement`.
 *
 * Guards (typed result codes, never a throw for a rejection):
 *   NOT_FOUND          — no such order
 *   HAS_ONLINE_PAYMENT — an active Payment row exists, or paymentMethod is CARD
 *   NOT_COD            — paymentMethod is neither NONE nor COD (e.g. GCASH)
 *   CANCELLED          — order is cancelled
 *   REFUNDED           — paymentStatus is REFUNDED / PARTIALLY_REFUNDED
 *   { ok:true, alreadyConfirmed:true } — paymentStatus is already PAID (no write)
 *   NOT_DELIVERED      — order status is not DELIVERED
 *   INVALID_STATE      — paymentStatus is not PENDING / UNPAID, or the
 *                        status-guarded write lost a race
 *
 * The confirmed amount is ALWAYS `Order.grandTotal`. One transaction:
 * status-guarded `updateMany` (count must be 1) + `OrderEvent{status:"PAID"}` +
 * `AdminAuditLog{action:"order.cod_payment_confirmed"}`. NO Payment /
 * PaymentRefund / WebhookEvent row is ever created.
 */
export async function confirmCodPaymentReceived(
  input: ConfirmCodPaymentInput,
  actor: { userId: string; email: string },
  externalTx?: Prisma.TransactionClient,
): Promise<ConfirmCodPaymentResult> {
  const orderId = String(input.orderId ?? "").trim();
  if (!orderId || orderId.length > 64) return { ok: false, code: "NOT_FOUND", error: "Order not found." };

  const run = async (tx: Prisma.TransactionClient): Promise<ConfirmCodPaymentResult> => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        paymentMethod: true,
        paymentStatus: true,
        grandTotal: true,
        payments: {
          where: { status: { in: [...COD_ONLINE_PAYMENT_STATUSES] } },
          select: { id: true },
          take: 1,
        },
      },
    });
    if (!order) return { ok: false, code: "NOT_FOUND", error: "Order not found." };

    if (order.payments.length > 0) {
      return {
        ok: false,
        code: "HAS_ONLINE_PAYMENT",
        error: "This order has an online payment record — its payment status is managed by the payment provider, not here.",
      };
    }
    if (order.paymentMethod === "CARD") {
      return { ok: false, code: "HAS_ONLINE_PAYMENT", error: "This is a card order — it is confirmed by the payment provider, not here." };
    }
    if (order.paymentMethod !== "NONE" && order.paymentMethod !== "COD") {
      return { ok: false, code: "NOT_COD", error: "This is not a cash-on-delivery order." };
    }
    if (order.status === "CANCELLED") {
      return { ok: false, code: "CANCELLED", error: "This order is cancelled." };
    }
    if (order.paymentStatus === "REFUNDED" || order.paymentStatus === "PARTIALLY_REFUNDED") {
      return { ok: false, code: "REFUNDED", error: "This order has been refunded — its payment cannot be re-confirmed." };
    }
    if (order.paymentStatus === "PAID") {
      return { ok: true, alreadyConfirmed: true }; // idempotent — no OrderEvent, no audit
    }
    if (order.status !== "DELIVERED") {
      return { ok: false, code: "NOT_DELIVERED", error: "COD payment can only be confirmed once the order is delivered." };
    }
    if (order.paymentStatus !== "PENDING" && order.paymentStatus !== "UNPAID") {
      return { ok: false, code: "INVALID_STATE", error: `Cannot confirm COD payment from status ${order.paymentStatus}.` };
    }

    // Status-guarded write — the concurrency + duplicate guard. If a parallel
    // request moved the order out of {PENDING,UNPAID} + DELIVERED + {NONE,COD},
    // this touches 0 rows and the whole transaction rolls back: no OrderEvent,
    // no audit row, nothing partially committed.
    const res = await tx.order.updateMany({
      where: {
        id: order.id,
        paymentStatus: { in: ["PENDING", "UNPAID"] },
        status: "DELIVERED",
        paymentMethod: { in: ["NONE", "COD"] },
      },
      data: { paymentStatus: "PAID", updatedAt: new Date() },
    });
    if (res.count !== 1) throw new CodConfirmConflict();

    await tx.orderEvent.create({
      data: { orderId: order.id, status: "PAID", title: "Payment received", detail: null },
    });

    const remittanceReference = input.remittanceReference
      ? cleanUserText(input.remittanceReference).trim() || null
      : null;
    const note = input.note ? cleanUserText(input.note).trim() || null : null;

    await writeAudit(
      {
        actorUserId: actor.userId,
        action: "order.cod_payment_confirmed",
        targetType: "order",
        targetId: order.id,
        summary: `${actor.email} recorded COD cash received for order ${order.orderNumber}: paymentStatus ${order.paymentStatus} → PAID`,
        meta: {
          orderNumber: order.orderNumber,
          from: order.paymentStatus,
          to: "PAID",
          paymentMethod: order.paymentMethod,
          amountConfirmed: order.grandTotal,
          grandTotal: order.grandTotal,
          remittanceReference,
          note,
          confirmedAt: new Date().toISOString(),
          bookkeepingOnly: true,
        },
      },
      tx,
    );

    return { ok: true };
  };

  try {
    return externalTx ? await run(externalTx) : await prisma.$transaction(run);
  } catch (err) {
    if (err instanceof CodConfirmConflict) {
      return { ok: false, code: "INVALID_STATE", error: "The order changed while you were confirming it — reload and try again." };
    }
    throw err;
  }
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
