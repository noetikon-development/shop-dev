"use server";

import { z } from "zod";
import {
  loadCart,
  addToCartCore,
  updateCartItemCore,
  removeCartItemCore,
  clearCartCore,
  mergeGuestCartCore,
  applyCartCouponCore,
  removeCartCouponCore,
  MAX_QTY_PER_LINE,
  type CartDTO,
  type MergeNotice,
} from "@/lib/cart";

/**
 * The only cart surface exposed to the browser. Every action resolves the cart
 * owner server-side (Supabase session or the httpOnly guest cookie) — the
 * client cannot pass a cart id, an item id or a price. Each returns the fresh,
 * authoritative cart so the UI can replace its state wholesale.
 */

export type CartActionResult = {
  ok: boolean;
  error?: string;
  notice?: string;
  cart: CartDTO;
};

export async function getCart(): Promise<CartDTO> {
  return loadCart();
}

const addSchema = z.object({
  productId: z.string().min(1).max(64),
  variantId: z.string().min(1).max(64).optional(),
  quantity: z.coerce.number().int().min(1).max(MAX_QTY_PER_LINE).default(1),
});

export async function addToCart(input: unknown): Promise<CartActionResult> {
  const parsed = addSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "That request wasn’t valid.", cart: await loadCart() };
  }
  const res = await addToCartCore(parsed.data);
  const cart = await loadCart();
  if (!res.ok) return { ok: false, error: res.error, cart };
  return {
    ok: true,
    notice: res.capped
      ? `Only ${res.finalQty} in stock — we set the quantity to ${res.finalQty}.`
      : undefined,
    cart,
  };
}

const updateSchema = z.object({
  variantId: z.string().min(1).max(64),
  quantity: z.coerce.number().int().min(0).max(MAX_QTY_PER_LINE),
});

export async function updateCartItem(input: unknown): Promise<CartActionResult> {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "That request wasn’t valid.", cart: await loadCart() };
  }
  // Quantity 0 means "remove".
  if (parsed.data.quantity === 0) {
    await removeCartItemCore(parsed.data.variantId);
    return { ok: true, cart: await loadCart() };
  }
  const res = await updateCartItemCore(parsed.data);
  const cart = await loadCart();
  if (!res.ok) return { ok: false, error: res.error, cart };
  return {
    ok: true,
    notice: res.capped
      ? `Only ${res.finalQty} in stock — we set the quantity to ${res.finalQty}.`
      : undefined,
    cart,
  };
}

const removeSchema = z.object({ variantId: z.string().min(1).max(64) });

export async function removeCartItem(input: unknown): Promise<CartActionResult> {
  const parsed = removeSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "That request wasn’t valid.", cart: await loadCart() };
  }
  await removeCartItemCore(parsed.data.variantId);
  return { ok: true, cart: await loadCart() };
}

export async function clearCart(): Promise<CartActionResult> {
  await clearCartCore();
  return { ok: true, cart: await loadCart() };
}

// --- Coupon (Step 14) -----------------------------------------------------
// The browser submits only the code. The discount, validity and totals are all
// resolved server-side; the client just replaces its cart state with the result.

const couponSchema = z.object({ code: z.string().min(1).max(32) });

export async function applyCoupon(input: unknown): Promise<CartActionResult> {
  const parsed = couponSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Invalid coupon code.", cart: await loadCart() };
  }
  const res = await applyCartCouponCore(parsed.data.code);
  if (!res.ok) return { ok: false, error: res.error, cart: await loadCart() };
  return { ok: true, notice: res.message, cart: res.cart };
}

export async function removeCoupon(): Promise<CartActionResult> {
  return { ok: true, cart: await removeCartCouponCore() };
}

export type CartSyncResult = {
  merged: boolean;
  notices: string[];
  cart: CartDTO;
};

function formatNotice(n: MergeNotice): string {
  if (n.kind === "capped") {
    return `${n.name}: only ${n.finalQty} in stock — quantity set to ${n.finalQty}.`;
  }
  return `${n.name} ${n.reason === "out of stock" ? "is out of stock" : "is no longer available"} and wasn’t added to your bag.`;
}

/**
 * Bootstraps the cart for the current visitor. If a signed-in customer still
 * carries a guest cookie, their guest cart is merged first (once — the cookie
 * is then cleared). Called by <CartProvider> on mount and on every auth-state
 * transition, so it must be safe to call repeatedly.
 */
export async function syncCart(): Promise<CartSyncResult> {
  const merge = await mergeGuestCartCore();
  return {
    merged: merge.merged,
    notices: merge.notices.map(formatNotice),
    cart: await loadCart(),
  };
}

/** Explicit merge entry point (kept separate for clarity / future callers). */
export async function mergeGuestCart(): Promise<CartSyncResult> {
  return syncCart();
}
