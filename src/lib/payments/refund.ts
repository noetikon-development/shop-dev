import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getPaymentsConfig } from "@/lib/payments/config";
import { createRefund, PaymongoNotConfiguredError } from "@/lib/payments/paymongo";
import { isPaidPaymentStatus } from "@/lib/payments/status";

type Db = Prisma.TransactionClient | typeof prisma;
const REFUND_LIVE_STATUSES = ["PENDING", "PROCESSING", "SUCCEEDED"] as const;

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
 * Seller attribution for a ReturnRequest-derived refund (foundation phase —
 * schema-only PaymentRefund.sellerOrderId, added ahead of any refund logic
 * that populates it). Walks ReturnRequest -> ReturnItem -> OrderItem ->
 * SellerOrder and returns the ONE distinct SellerOrder every line in the
 * return belongs to.
 *
 * A ReturnRequest is NOT guaranteed seller-homogeneous — both
 * `requestReturnAction` (customer) and `adminCreateReturnAction` (admin) let
 * a caller select lines across every eligible seller on a multi-seller order
 * in ONE return, and `PaymentRefund.returnRequestId` is `@unique` (at most
 * one PaymentRefund per ReturnRequest) — confirmed by reading both action
 * files and the schema, not assumed. So a single provider refund can never
 * legitimately carry more than one SellerOrder's attribution.
 *
 * `mixed: true` means exactly that genuinely-mixed case was found. Per this
 * phase's explicit scope, no split-refund / PaymentRefundAllocation
 * mechanism is invented for it — `sellerOrderId` stays `null`, the same
 * sanctioned fallback already used for a legacy line with no SellerOrder at
 * all. Only the Payment-level cap applies to that refund; it is not
 * attributed to (and does not draw against) any one seller's cap.
 */
export type ReturnSellerAttribution = { sellerOrderId: string | null; mixed: boolean };

export async function deriveReturnSellerOrderId(
  returnRequestId: string,
  db: Db = prisma,
): Promise<ReturnSellerAttribution> {
  const rows = await db.returnItem.findMany({
    where: { returnRequestId },
    select: { orderItem: { select: { sellerOrderId: true } } },
  });
  const distinct = new Set(
    rows.map((r) => r.orderItem.sellerOrderId).filter((v): v is string => Boolean(v)),
  );
  if (distinct.size === 1) return { sellerOrderId: [...distinct][0], mixed: false };
  if (distinct.size === 0) return { sellerOrderId: null, mixed: false };
  console.warn(
    "[refund] ReturnRequest spans more than one SellerOrder — refund left unattributed (sellerOrderId NULL), no split-refund mechanism exists",
    { returnRequestId, sellerOrderIds: [...distinct] },
  );
  return { sellerOrderId: null, mixed: true };
}

export type CreateAttributedRefundResult =
  | { ok: true; paymentRefundId: string }
  | { ok: false; code: "PAYMENT_NOT_FOUND" | "PAYMENT_CAP_EXCEEDED" | "SELLER_CAP_EXCEEDED"; error: string };

/**
 * The atomic core: locks the Payment row, computes both caps from a
 * consistent read, and creates the PaymentRefund row — all inside the SAME
 * transaction, so two concurrent callers against the same Payment can never
 * both see the same stale "remaining balance" (the second one blocks on the
 * `FOR UPDATE` lock, then re-reads the first's now-committed PaymentRefund
 * before deciding).
 *
 * Seller-level cap: only checked when `sellerOrderId` is provided (a
 * seller-scoped refund) — the existing `SellerOrder.total` checkout snapshot
 * is the basis, read-only, never modified. A refund with `sellerOrderId:
 * null` (legacy, mixed-seller, or whole-order) skips this check entirely and
 * is bound only by the Payment-level cap, exactly as before this phase.
 *
 * Exported (DB-only, no provider call) so it's independently testable and
 * reusable — `initiateProviderRefund` is the only current caller.
 */
export async function createAttributedPaymentRefund(
  params: {
    paymentId: string;
    returnRequestId: string | null;
    sellerOrderId: string | null;
    amount: number;
    reason: string;
  },
  db: Db = prisma,
): Promise<CreateAttributedRefundResult> {
  const run = async (tx: Prisma.TransactionClient): Promise<CreateAttributedRefundResult> => {
    const locked = await tx.$queryRaw<{ id: string; amount: number }[]>`
      SELECT "id", "amount" FROM "Payment" WHERE "id" = ${params.paymentId} FOR UPDATE`;
    const payment = locked[0];
    if (!payment) return { ok: false, code: "PAYMENT_NOT_FOUND", error: "Payment not found." };

    const paymentAgg = await tx.paymentRefund.aggregate({
      where: { paymentId: payment.id, status: { in: [...REFUND_LIVE_STATUSES] } },
      _sum: { amount: true },
    });
    const paymentRemaining = payment.amount - (paymentAgg._sum.amount ?? 0);
    if (params.amount > paymentRemaining) {
      return {
        ok: false,
        code: "PAYMENT_CAP_EXCEEDED",
        error: `That's more than the remaining refundable amount on this payment (${paymentRemaining} centavos remaining).`,
      };
    }

    if (params.sellerOrderId) {
      const so = await tx.sellerOrder.findUnique({
        where: { id: params.sellerOrderId },
        select: { total: true },
      });
      if (so) {
        const sellerAgg = await tx.paymentRefund.aggregate({
          where: { sellerOrderId: params.sellerOrderId, status: { in: [...REFUND_LIVE_STATUSES] } },
          _sum: { amount: true },
        });
        const sellerRemaining = so.total - (sellerAgg._sum.amount ?? 0);
        if (params.amount > sellerRemaining) {
          return {
            ok: false,
            code: "SELLER_CAP_EXCEEDED",
            error: `That's more than this seller's remaining refundable amount (${sellerRemaining} centavos remaining).`,
          };
        }
      }
    }

    const created = await tx.paymentRefund.create({
      data: {
        paymentId: payment.id,
        returnRequestId: params.returnRequestId,
        sellerOrderId: params.sellerOrderId,
        amount: params.amount,
        reason: params.reason,
        status: "PENDING",
      },
      select: { id: true },
    });
    return { ok: true, paymentRefundId: created.id };
  };

  if (db === prisma) return prisma.$transaction(run);
  return run(db as Prisma.TransactionClient);
}

/**
 * DORMANT in Phase 4-A. Creates a PaymentRefund row (via the atomic,
 * lock-protected core above) and calls PayMongo. The webhook
 * (`refund.updated`) completes it. Callers must have verified the
 * `issue_refunds` permission first.
 */
export async function initiateProviderRefund(params: {
  returnRequestId: string;
  paymentId: string;
  providerPaymentId: string;
  amount: number;
  reason: string;
  /** Populated by the caller via `deriveReturnSellerOrderId` when the return
   *  is seller-homogeneous; `null`/omitted for a legacy or mixed-seller
   *  return, which then draws only against the Payment-level cap. */
  sellerOrderId?: string | null;
}): Promise<InitiateProviderRefundResult> {
  // Guard: never create a PaymentRefund without a live config.
  const config = await getPaymentsConfig();
  if (!config.onlinePaymentEnabled || config.mode !== "live") {
    return { ok: false, error: "Online payment is not live — use the bookkeeping refund." };
  }

  const created = await createAttributedPaymentRefund({
    paymentId: params.paymentId,
    returnRequestId: params.returnRequestId,
    sellerOrderId: params.sellerOrderId ?? null,
    amount: params.amount,
    reason: params.reason,
  });
  if (!created.ok) return { ok: false, error: created.error };
  const refund = { id: created.paymentRefundId };

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
