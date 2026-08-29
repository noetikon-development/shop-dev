"use server";

import { z } from "zod";
import {
  getCheckoutData,
  createOrderFromCart,
  type CheckoutData,
  type PlaceOrderResult,
} from "@/lib/checkout";

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
