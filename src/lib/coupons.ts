import { formatPrice } from "@/lib/utils";

/**
 * Coupon rules — pure data + pure functions, safe to import from server, client
 * and edge code. The server is the AUTHORITY: it re-runs `evaluateCoupon` at
 * cart-apply and again at checkout, so a client that sees these rules still
 * cannot fake a discount, the validity, the subtotal or the total.
 *
 * The browser is NEVER trusted for coupon validity, the discount amount, the
 * subtotal or the total. It may only submit a coupon CODE. Everything below runs
 * on the server, against the canonical Coupon record and the server clock.
 *
 * Usage-limit enforcement (global + per-customer) is NOT here — it needs a
 * `SELECT ... FOR UPDATE` on the Coupon row plus a COUNT of `CouponRedemption`
 * rows, done inside the checkout transaction (`src/lib/checkout.ts`).
 */

/** Canonical stored form: trimmed, whitespace-stripped, uppercased. */
export function normalizeCouponCode(raw: string): string {
  return raw.trim().replace(/\s+/g, "").toUpperCase();
}

/** A canonical code is 3–24 uppercase letters/digits. */
export const COUPON_CODE_RE = /^[A-Z0-9]{3,24}$/;

export function isValidCouponCode(code: string): boolean {
  return COUPON_CODE_RE.test(code);
}

// ---------------------------------------------------------------------------
// Derived lifecycle state (no second status column — all derived)
// ---------------------------------------------------------------------------

export type CouponState =
  | "DRAFT"
  | "SCHEDULED"
  | "ACTIVE"
  | "EXPIRED"
  | "DISABLED"
  | "ARCHIVED";

type StateInput = {
  active: boolean;
  archivedAt: Date | null;
  startsAt: Date | null;
  expiresAt: Date | null;
  usedCount: number;
};

export function couponState(c: StateInput, now: Date = new Date()): CouponState {
  if (c.archivedAt) return "ARCHIVED";
  if (!c.active) return c.usedCount > 0 ? "DISABLED" : "DRAFT";
  if (c.expiresAt && c.expiresAt <= now) return "EXPIRED";
  if (c.startsAt && c.startsAt > now) return "SCHEDULED";
  return "ACTIVE";
}

export const COUPON_STATE_LABEL: Record<CouponState, string> = {
  DRAFT: "Draft",
  SCHEDULED: "Scheduled",
  ACTIVE: "Active",
  EXPIRED: "Expired",
  DISABLED: "Disabled",
  ARCHIVED: "Archived",
};

type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";
export function couponStateTone(state: CouponState): BadgeTone {
  switch (state) {
    case "ACTIVE":
      return "success";
    case "SCHEDULED":
      return "info";
    case "EXPIRED":
    case "DISABLED":
      return "danger";
    case "ARCHIVED":
      return "neutral";
    default:
      return "warning";
  }
}

// ---------------------------------------------------------------------------
// Discount evaluation (does NOT check usage limits)
// ---------------------------------------------------------------------------

export type EvaluableCoupon = {
  code: string;
  type: string; // PERCENT | FIXED  (anything else is not applicable in Step 14)
  value: number;
  minSubtotal: number;
  maxDiscount: number | null;
  startsAt: Date | null;
  expiresAt: Date | null;
  active: boolean;
  archivedAt: Date | null;
};

export type CouponEvaluation =
  | { ok: true; discount: number }
  | { ok: false; error: string };

/**
 * Given a coupon and a merchandise subtotal (centavos), return the discount to
 * apply — or a clear customer-facing reason it can't be applied.
 *
 * Discount is always clamped: never negative, never more than the subtotal.
 * Coupons apply to the merchandise subtotal only — shipping is untouched
 * (Step 14 §16).
 */
export function evaluateCoupon(
  coupon: EvaluableCoupon,
  subtotal: number,
  now: Date = new Date(),
): CouponEvaluation {
  if (coupon.archivedAt || !coupon.active) {
    return { ok: false, error: "This coupon is no longer available." };
  }
  if (coupon.startsAt && coupon.startsAt > now) {
    return { ok: false, error: "This coupon is not active yet." };
  }
  if (coupon.expiresAt && coupon.expiresAt <= now) {
    return { ok: false, error: "This coupon has expired." };
  }
  if (coupon.type !== "PERCENT" && coupon.type !== "FIXED") {
    // FREESHIP / any future type is not applicable in this step.
    return { ok: false, error: "This coupon is no longer available." };
  }
  if (subtotal <= 0) {
    return { ok: false, error: "Add items to your bag to use a coupon." };
  }
  if (subtotal < coupon.minSubtotal) {
    return {
      ok: false,
      error: `This coupon requires a minimum order of ${formatPrice(coupon.minSubtotal)}.`,
    };
  }

  let discount =
    coupon.type === "PERCENT"
      ? Math.round((subtotal * coupon.value) / 100)
      : coupon.value;

  if (coupon.type === "PERCENT" && coupon.maxDiscount != null) {
    discount = Math.min(discount, coupon.maxDiscount);
  }

  discount = Math.max(0, Math.min(discount, subtotal));
  return { ok: true, discount };
}
