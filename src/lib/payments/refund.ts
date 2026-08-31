import "server-only";
import { prisma } from "@/lib/prisma";
import { getPaymentsConfig } from "@/lib/payments/config";
import { createRefund, PaymongoNotConfiguredError } from "@/lib/payments/paymongo";
import { isPaidPaymentStatus } from "@/lib/payments/status";

/**
 * Decides how a P3 return refund is settled (Step 21 P4).
 *
 *   "provider"    — the order has a PAID PayMongo Payment AND online payment is
 *                   live: the refund is issued through PayMongo and completed by
 *                   the webhook.
 *   "bookkeeping"  — everything else (COD, orders placed before P4, orders with
 *                   no Payment row, or online payment disabled): the P3 flow is
 *                   used exactly as before — no money moves, Order.paymentStatus
 *                   is not touched.
 *
 * PHASE 4-A: `onlinePaymentEnabled` is false, so this ALWAYS returns
 * "bookkeeping" and the provider code below is never reached.
 */

export type RefundRoute =
  | { route: "bookkeeping"; reason: string }
  | {
      route: "provider";
      payment: { id: string; providerId: string; amount: number; method: string | null };
      alreadyRefunded: number;
    };

export async function refundRouteForOrder(orderId: string): Promise<RefundRoute> {
  const config = await getPaymentsConfig();
  if (!config.onlinePaymentEnabled) {
    return { route: "bookkeeping", reason: "online_payment_disabled" };
  }
  if (config.mode !== "live") {
    return { route: "bookkeeping", reason: "not_live_mode" };
  }

  const payment = await prisma.payment.findFirst({
    where: { orderId, status: { in: ["PAID", "PARTIALLY_REFUNDED"] } },
    orderBy: { paidAt: "desc" },
    select: { id: true, providerId: true, amount: true, method: true, status: true },
  });
  if (!payment || !isPaidPaymentStatus(payment.status)) {
    return { route: "bookkeeping", reason: "no_paid_payment" };
  }

  // Extract the provider payment id (pay_xxx) — for a checkout session we stored
  // the session id, so a real integration resolves the nested payment id. In
  // Phase 4-A this branch is unreachable; the shape is here for 4-D.
  const agg = await prisma.paymentRefund.aggregate({
    where: { paymentId: payment.id, status: { in: ["PENDING", "PROCESSING", "SUCCEEDED"] } },
    _sum: { amount: true },
  });

  return {
    route: "provider",
    payment: {
      id: payment.id,
      providerId: payment.providerId,
      amount: payment.amount,
      method: payment.method,
    },
    alreadyRefunded: agg._sum.amount ?? 0,
  };
}

export type InitiateProviderRefundResult =
  | { ok: true; paymentRefundId: string }
  | { ok: false; error: string };

/**
 * DORMANT in Phase 4-A. Creates a PaymentRefund row and calls PayMongo. The
 * webhook (`refund.updated`) completes it. Callers must have verified the
 * `issue_refunds` permission first.
 */
export async function initiateProviderRefund(params: {
  returnRequestId: string;
  paymentId: string;
  providerPaymentId: string;
  amount: number;
  reason: string;
}): Promise<InitiateProviderRefundResult> {
  // Guard: never create a PaymentRefund without a live config.
  const config = await getPaymentsConfig();
  if (!config.onlinePaymentEnabled || config.mode !== "live") {
    return { ok: false, error: "Online payment is not live — use the bookkeeping refund." };
  }

  const refund = await prisma.paymentRefund.create({
    data: {
      paymentId: params.paymentId,
      returnRequestId: params.returnRequestId,
      amount: params.amount,
      reason: params.reason,
      status: "PENDING",
    },
    select: { id: true },
  });

  try {
    const remote = await createRefund(
      { amount: params.amount, paymentId: params.providerPaymentId, reason: params.reason },
      `refund:${params.returnRequestId}`,
    );
    await prisma.paymentRefund.update({
      where: { id: refund.id },
      data: { providerId: remote.id, status: "PROCESSING" },
    });
    return { ok: true, paymentRefundId: refund.id };
  } catch (err) {
    const detail =
      err instanceof PaymongoNotConfiguredError
        ? "PayMongo is not configured."
        : err instanceof Error
          ? err.message
          : "refund request failed";
    await prisma.paymentRefund.update({
      where: { id: refund.id },
      data: { status: "FAILED", failureReason: detail.slice(0, 300) },
    });
    return { ok: false, error: detail };
  }
}
