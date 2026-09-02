"use server";

import { z } from "zod";
import {
  getCheckoutData,
  createOrderFromCart,
  type CheckoutData,
  type PlaceOrderResult,
} from "@/lib/checkout";
import { getCurrentUser } from "@/lib/auth";
import { beginOnlinePayment, type BeginPaymentResult } from "@/lib/payments/checkout-session";

/**
 * The only checkout surface exposed to the browser. `loadCheckout` returns the
 * server-calculated state for display; `placeOrder` creates the order entirely
 * server-side from the customer's ACTIVE cart. Neither trusts a client-supplied
 * price, total, item list or userId.
 */

export async function loadCheckout(): Promise<CheckoutData> {
  return getCheckoutData();
}

const placeSchema = z.object({
  shippingAddressId: z.string().min(1).max(64),
  billingAddressId: z.string().min(1).max(64),
  shippingMethodId: z.string().min(1).max(64),
  note: z.string().max(500).optional(),
});

export async function placeOrder(raw: unknown): Promise<PlaceOrderResult> {
  const parsed = placeSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, code: "VALIDATION", error: "Please review your checkout details." };
  }
  return createOrderFromCart(parsed.data);
}

const orderNumberSchema = z
  .string()
  .trim()
  .regex(/^AX-\d{6}-\d{5}$/, "invalid order reference");

/**
 * Phase 6B — start a PayMongo hosted-checkout payment for an order the customer
 * has already placed. Server-side only: it re-loads the order, checks it
 * belongs to the caller and is `PENDING_PAYMENT`, and returns a `checkout_url`
 * to redirect to. It never trusts a client total and never marks anything paid.
 * Inert unless `getPaymentsConfig().sessionsEnabled`.
 */
export async function startCheckoutPayment(rawOrderNumber: unknown): Promise<BeginPaymentResult> {
  const user = await getCurrentUser();
  if (!user) {
    return { ok: false, code: "NOT_FOUND", error: "Please sign in and try again." };
  }
  const parsed = orderNumberSchema.safeParse(rawOrderNumber);
  if (!parsed.success) {
    return { ok: false, code: "NOT_FOUND", error: "We couldn’t find that order." };
  }
  return beginOnlinePayment({ orderNumber: parsed.data, userId: user.id });
}
