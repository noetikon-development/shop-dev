"use server";

import { prisma } from "@/lib/prisma";
import { type CouponInput } from "@/lib/pricing";

// ---------------------------------------------------------------------------
// Coupons
//
// Coupon *application* is not implemented yet (deferred). This validator backs
// the promo-code field on the cart page; Step 9 checkout does not apply coupons.
// ---------------------------------------------------------------------------

export type CouponResult =
  | { ok: true; coupon: CouponInput; message: string }
  | { ok: false; error: string };

export async function validateCoupon(code: string, subtotal: number): Promise<CouponResult> {
  const clean = code.trim().toUpperCase();
  if (!clean) return { ok: false, error: "Enter a code" };

  const coupon = await prisma.coupon.findUnique({ where: { code: clean } });
  if (!coupon || !coupon.active) return { ok: false, error: "That code isn’t valid" };

  const now = new Date();
  if (coupon.startsAt && coupon.startsAt > now) return { ok: false, error: "This code isn’t active yet" };
  if (coupon.expiresAt && coupon.expiresAt < now) return { ok: false, error: "This code has expired" };
  if (coupon.usageLimit != null && coupon.usedCount >= coupon.usageLimit) {
    return { ok: false, error: "This code has reached its limit" };
  }
  if (subtotal < coupon.minSubtotal) {
    return {
      ok: false,
      error: `Spend at least ₱${(coupon.minSubtotal / 100).toLocaleString()} to use ${clean}`,
    };
  }

  return {
    ok: true,
    message: coupon.description ?? "Discount applied",
    coupon: {
      code: coupon.code,
      type: coupon.type,
      value: coupon.value,
      minSubtotal: coupon.minSubtotal,
      maxDiscount: coupon.maxDiscount,
    },
  };
}

// Checkout + order creation live in src/lib/checkout.ts +
// src/lib/checkout-actions.ts (Step 9). Address management is in
// src/lib/addresses.ts + src/lib/address-actions.ts (Step 8).
