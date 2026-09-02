import "server-only";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { getSiteUrl } from "@/lib/site-url";
import { writeAudit } from "@/lib/admin/audit";
import { getPaymentsConfig } from "@/lib/payments/config";
import {
  createCheckoutSession,
  PaymongoApiError,
  PaymongoNotConfiguredError,
  PaymongoTimeoutError,
  type CheckoutSessionInput,
} from "@/lib/payments/paymongo";

/**
 * Phase 6B — start an online payment for an already-created order.
 *
 * The order is created FIRST by the existing `createOrderFromCart`
 * (`PENDING_PAYMENT`, server-authoritative totals). This module then:
 *   1. gates on `getPaymentsConfig().sessionsEnabled` (setting + sk_test_ key +
 *      no mode mismatch — does NOT need the webhook secret; that is Phase 6C);
 *   2. resumes an in-flight `Payment` or opens a fresh attempt (the partial
 *      unique index `payment_one_active_per_order` is the concurrency guard);
 *   3. builds the PayMongo Checkout Session payload from the ORDER snapshot —
 *      never from client state — so the session total always equals
 *      `Order.grandTotal`;
 *   4. calls PayMongo (`POST /checkout_sessions`) with a deterministic
 *      `Idempotency-Key` so an accidental retry reuses the same session;
 *   5. records the session id on `Payment.providerId` and moves it to
 *      `AWAITING_PAYMENT`, then returns the hosted `checkout_url`.
 *
 * It NEVER marks anything paid. A verified webhook (Phase 6C) is the only thing
 * that transitions `Payment`/`Order` to PAID.
 */

const ACTIVE_STATUSES = ["PENDING", "AWAITING_PAYMENT", "PAID", "PARTIALLY_REFUNDED"] as const;

export type BeginPaymentCode =
  | "DISABLED"
  | "NOT_FOUND"
  | "INVALID_STATE"
  | "ALREADY_PAID"
  | "NO_METHODS"
  | "AMOUNT_MISMATCH"
  | "PROVIDER_4XX"
  | "PROVIDER_5XX"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_UNREACHABLE"
  | "UNEXPECTED";

export type BeginPaymentResult =
  | { ok: true; checkoutUrl: string; resumed: boolean }
  | { ok: false; code: BeginPaymentCode; error: string };

/** Customer-safe message per failure code — never a raw PayMongo string. */
const MESSAGE: Record<BeginPaymentCode, string> = {
  DISABLED: "Online payment isn’t available right now. Please try again shortly.",
  NOT_FOUND: "We couldn’t find that order.",
  INVALID_STATE: "This order can’t be paid online right now.",
  ALREADY_PAID: "This order has already been paid.",
  NO_METHODS: "No online payment methods are configured. Please contact us.",
  AMOUNT_MISMATCH: "Something looked wrong with the order total, so we stopped. Please contact us.",
  PROVIDER_4XX: "Our payment provider rejected the request. Please try again or contact us.",
  PROVIDER_5XX: "Our payment provider is having trouble. Please try again in a few minutes.",
  PROVIDER_TIMEOUT: "The payment provider took too long to respond. Please try again.",
  PROVIDER_UNREACHABLE: "We couldn’t reach the payment provider. Please try again shortly.",
  UNEXPECTED: "Something went wrong starting your payment. Please try again.",
};

function fail(code: BeginPaymentCode): BeginPaymentResult {
  return { ok: false, code, error: MESSAGE[code] };
}

type OrderForPayment = Prisma.OrderGetPayload<{
  include: { items: true; payments: true };
}>;

/**
 * Build the Checkout Session payload from the order snapshot.
 *
 * When the order carries no discount we send itemised `line_items` (products +
 * one shipping line) whose sum equals `grandTotal`. When there IS a discount —
 * PayMongo has no discount line — we send a single summary line for the exact
 * `grandTotal`. Either way the session total is the authoritative order total.
 */
function buildSessionInput(
  order: OrderForPayment,
  paymentId: string,
  methodTypes: string[],
): CheckoutSessionInput | { error: BeginPaymentCode } {
  if (methodTypes.length === 0) return { error: "NO_METHODS" };

  const site = getSiteUrl();
  const itemCount = order.items.reduce((n, it) => n + it.quantity, 0);

  let lineItems: CheckoutSessionInput["lineItems"];
  if (order.discountTotal === 0) {
    lineItems = order.items.map((it) => ({
      name: it.variantLabel ? `${it.name} — ${it.variantLabel}` : it.name,
      quantity: it.quantity,
      amount: it.unitPrice,
      currency: "PHP",
    }));
    if (order.shippingFee > 0) {
      lineItems.push({
        name: `Shipping — ${order.shippingMethodName ?? "Delivery"}`,
        quantity: 1,
        amount: order.shippingFee,
        currency: "PHP",
      });
    }
  } else {
    lineItems = [
      {
        name: `Axiaro order ${order.orderNumber}`,
        quantity: 1,
        amount: order.grandTotal,
        currency: "PHP",
        description: `${itemCount} item${itemCount === 1 ? "" : "s"} (includes a ₱${(order.discountTotal / 100).toFixed(2)} discount)`,
      },
    ];
  }

  // Guard: the sum of what we are about to send MUST equal the order total.
  const lineSum = lineItems.reduce((n, li) => n + li.amount * li.quantity, 0);
  if (lineSum !== order.grandTotal) return { error: "AMOUNT_MISMATCH" };

  return {
    amount: order.grandTotal,
    currency: "PHP",
    description: `Axiaro order ${order.orderNumber}`,
    referenceNumber: order.orderNumber,
    lineItems,
    paymentMethodTypes: methodTypes,
    successUrl: `${site}/order/${encodeURIComponent(order.orderNumber)}?pay=return`,
    cancelUrl: `${site}/order/${encodeURIComponent(order.orderNumber)}?pay=cancelled`,
    metadata: {
      order_number: order.orderNumber,
      order_id: order.id,
      payment_id: paymentId,
    },
    billingEmail: order.email,
    sendEmailReceipt: false,
  };
}

export async function beginOnlinePayment(args: {
  orderNumber: string;
  userId: string;
}): Promise<BeginPaymentResult> {
  const config = await getPaymentsConfig();
  if (!config.sessionsEnabled) return fail("DISABLED");

  const order = await prisma.order.findUnique({
    where: { orderNumber: args.orderNumber },
    include: { items: true, payments: true },
  });
  if (!order || order.userId !== args.userId) return fail("NOT_FOUND");

  const active = order.payments.filter((p) =>
    (ACTIVE_STATUSES as readonly string[]).includes(p.status),
  );
  if (active.some((p) => p.status === "PAID" || p.status === "PARTIALLY_REFUNDED")) {
    return fail("ALREADY_PAID");
  }
  if (order.status !== "PENDING_PAYMENT") {
    return order.paymentStatus === "PAID" ? fail("ALREADY_PAID") : fail("INVALID_STATE");
  }

  // Resume an in-flight hosted session without a second API call.
  const awaiting = active.find((p) => p.status === "AWAITING_PAYMENT" && p.checkoutUrl);
  if (awaiting?.checkoutUrl) {
    return { ok: true, checkoutUrl: awaiting.checkoutUrl, resumed: true };
  }

  const methodTypes = config.enabledMethods
    .filter((m) => m.toUpperCase() !== "COD")
    .map((m) => m.toLowerCase());

  // Reuse a PENDING row from a prior failed attempt (same Idempotency-Key), or
  // open a new attempt. The partial unique index is the concurrency guard.
  let payment = active.find((p) => p.status === "PENDING") ?? null;
  if (!payment) {
    try {
      payment = await prisma.payment.create({
        data: {
          orderId: order.id,
          provider: "paymongo",
          providerObject: "checkout_session",
          // Placeholder until the API returns the real ps_… id (providerId is
          // unique + required). Overwritten on success below.
          providerId: `pending_${order.id}`,
          status: "PENDING",
          amount: order.grandTotal,
          currency: "PHP",
          metadata: JSON.stringify({ order_number: order.orderNumber }),
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        // A concurrent attempt won the race — re-read and resume if possible.
        const again = await prisma.payment.findFirst({
          where: { orderId: order.id, status: { in: ["PENDING", "AWAITING_PAYMENT"] } },
        });
        if (again?.status === "AWAITING_PAYMENT" && again.checkoutUrl) {
          return { ok: true, checkoutUrl: again.checkoutUrl, resumed: true };
        }
        if (again?.status === "PENDING") payment = again;
      }
      if (!payment) return fail("UNEXPECTED");
    }
  }

  const built = buildSessionInput(order, payment.id, methodTypes);
  if ("error" in built) return fail(built.error);

  const idempotencyKey = `checkout_${order.id}_${payment.id}`;

  let session: { id: string; checkoutUrl: string };
  try {
    session = await createCheckoutSession(built, idempotencyKey);
  } catch (err) {
    // Sanitised server log only — no headers, no key, no full payload.
    const detail =
      err instanceof PaymongoApiError
        ? `${err.status} ${err.detail.slice(0, 120)}`
        : err instanceof Error
          ? err.name
          : "unknown";
    console.error("[paymongo-checkout] session create failed", {
      orderNumber: order.orderNumber,
      paymentId: payment.id,
      detail,
    });
    if (err instanceof PaymongoNotConfiguredError) return fail("DISABLED");
    if (err instanceof PaymongoTimeoutError) return fail("PROVIDER_TIMEOUT");
    if (err instanceof PaymongoApiError) {
      if (err.status === 0) return fail("PROVIDER_UNREACHABLE");
      if (err.status >= 500) return fail("PROVIDER_5XX");
      return fail("PROVIDER_4XX");
    }
    return fail("UNEXPECTED");
  }

  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      providerId: session.id,
      status: "AWAITING_PAYMENT",
      checkoutUrl: session.checkoutUrl,
      metadata: JSON.stringify({
        order_number: order.orderNumber,
        order_id: order.id,
        payment_id: payment.id,
        idempotency_key: idempotencyKey,
        method_types: methodTypes,
      }),
    },
  });

  await writeAudit({
    actorUserId: args.userId,
    action: "payment.session_created",
    targetType: "order",
    targetId: order.id,
    summary: `PayMongo checkout session created for order ${order.orderNumber} (${config.mode} mode)`,
    meta: {
      paymentId: payment.id,
      providerId: session.id,
      amount: order.grandTotal,
      methodTypes,
      mode: config.mode,
    },
  });

  return { ok: true, checkoutUrl: session.checkoutUrl, resumed: false };
}
