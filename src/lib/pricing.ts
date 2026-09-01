import {
  FREE_SHIPPING_THRESHOLD,
  SHIPPING_METHODS,
} from "@/lib/constants";

/**
 * Cart-page display maths. NOT authoritative — the server recalculates every
 * monetary value at checkout (`src/lib/checkout.ts`). The coupon discount passed
 * in here has already been computed server-side by `evaluateCoupon`
 * (`src/lib/coupons.ts`); this function never derives a discount itself.
 *
 * Phase 5A: the free-shipping threshold and per-method rates come from the
 * caller (resolved from `shipping.freeThreshold` + the `ShippingMethod` table
 * via the storefront config context). The `constants.ts` values are only the
 * fallback when that config is unavailable.
 */

type PricingShippingConfig = {
  freeThreshold?: number;
  methods?: { id: string; fee: number; label?: string }[];
};

export type PricedLine = {
  unitPrice: number;
  quantity: number;
};

export type OrderTotals = {
  subtotal: number;
  itemCount: number;
  shippingFee: number;
  shippingLabel: string;
  freeShippingApplied: boolean;
  amountToFreeShipping: number;
  discountTotal: number;
  grandTotal: number;
  couponApplied: string | null;
};

export function calcSubtotal(lines: PricedLine[]) {
  return lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
}

export function computeTotals(opts: {
  lines: PricedLine[];
  shippingMethodId?: string;
  /** Server-computed discount amount (centavos). Never derived on the client. */
  discount?: number;
  couponCode?: string | null;
  /** Authoritative shipping config; falls back to constants when absent. */
  shipping?: PricingShippingConfig;
}): OrderTotals {
  const { lines } = opts;

  const methods =
    opts.shipping?.methods && opts.shipping.methods.length
      ? opts.shipping.methods
      : SHIPPING_METHODS;
  const method = methods.find((m) => m.id === opts.shippingMethodId) ?? methods[0];

  const freeThreshold =
    opts.shipping?.freeThreshold && opts.shipping.freeThreshold > 0
      ? opts.shipping.freeThreshold
      : FREE_SHIPPING_THRESHOLD;

  const subtotal = calcSubtotal(lines);
  const itemCount = lines.reduce((n, l) => n + l.quantity, 0);

  // Clamp defensively even though the server already did.
  const discount = Math.max(0, Math.min(opts.discount ?? 0, subtotal));

  const freeShippingApplied = itemCount > 0 && subtotal >= freeThreshold;
  const methodFee = method?.fee ?? 0;
  const shippingFee = itemCount === 0 ? 0 : freeShippingApplied ? 0 : methodFee;

  const grandTotal = Math.max(0, subtotal - discount + shippingFee);

  return {
    subtotal,
    itemCount,
    shippingFee,
    shippingLabel: method?.label ?? "",
    freeShippingApplied,
    amountToFreeShipping: Math.max(0, freeThreshold - subtotal),
    discountTotal: discount,
    grandTotal,
    couponApplied: discount > 0 ? (opts.couponCode ?? null) : null,
  };
}
