import {
  FREE_SHIPPING_THRESHOLD,
  SHIPPING_METHODS,
} from "@/lib/constants";

/**
 * Cart-page display maths. NOT authoritative — the server recalculates every
 * monetary value at checkout (`src/lib/checkout.ts`). The coupon discount passed
 * in here has already been computed server-side by `evaluateCoupon`
 * (`src/lib/coupons.ts`); this function never derives a discount itself.
 */

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
}): OrderTotals {
  const { lines } = opts;
  const method =
    SHIPPING_METHODS.find((m) => m.id === opts.shippingMethodId) ?? SHIPPING_METHODS[0];
  const subtotal = calcSubtotal(lines);
  const itemCount = lines.reduce((n, l) => n + l.quantity, 0);

  // Clamp defensively even though the server already did.
  const discount = Math.max(0, Math.min(opts.discount ?? 0, subtotal));

  const freeShippingApplied = itemCount > 0 && subtotal >= FREE_SHIPPING_THRESHOLD;
  const shippingFee = itemCount === 0 ? 0 : freeShippingApplied ? 0 : method.fee;

  const grandTotal = Math.max(0, subtotal - discount + shippingFee);

  return {
    subtotal,
    itemCount,
    shippingFee,
    shippingLabel: method.label,
    freeShippingApplied,
    amountToFreeShipping: Math.max(0, FREE_SHIPPING_THRESHOLD - subtotal),
    discountTotal: discount,
    grandTotal,
    couponApplied: discount > 0 ? (opts.couponCode ?? null) : null,
  };
}
