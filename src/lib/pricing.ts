import {
  FREE_SHIPPING_THRESHOLD,
  SHIPPING_METHODS,
} from "@/lib/constants";

export type PricedLine = {
  unitPrice: number;
  quantity: number;
};

export type CouponInput = {
  code: string;
  type: string; // PERCENT | FIXED | FREESHIP
  value: number;
  minSubtotal: number;
  maxDiscount: number | null;
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
  couponError: string | null;
};

export function calcSubtotal(lines: PricedLine[]) {
  return lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
}

export function couponDiscount(
  coupon: CouponInput | null,
  subtotal: number,
): { discount: number; freeShip: boolean; error: string | null } {
  if (!coupon) return { discount: 0, freeShip: false, error: null };
  if (subtotal < coupon.minSubtotal) {
    return {
      discount: 0,
      freeShip: false,
      error: `Add ${((coupon.minSubtotal - subtotal) / 100).toLocaleString("en-PH", {
        style: "currency",
        currency: "PHP",
        maximumFractionDigits: 0,
      })} more to use ${coupon.code}`,
    };
  }
  if (coupon.type === "FREESHIP") return { discount: 0, freeShip: true, error: null };
  let discount =
    coupon.type === "PERCENT" ? Math.round((subtotal * coupon.value) / 100) : coupon.value;
  if (coupon.maxDiscount != null) discount = Math.min(discount, coupon.maxDiscount);
  discount = Math.min(discount, subtotal);
  return { discount, freeShip: false, error: null };
}

export function computeTotals(opts: {
  lines: PricedLine[];
  shippingMethodId?: string;
  coupon?: CouponInput | null;
}): OrderTotals {
  const { lines } = opts;
  const method =
    SHIPPING_METHODS.find((m) => m.id === opts.shippingMethodId) ?? SHIPPING_METHODS[0];
  const subtotal = calcSubtotal(lines);
  const itemCount = lines.reduce((n, l) => n + l.quantity, 0);

  const { discount, freeShip, error } = couponDiscount(opts.coupon ?? null, subtotal);

  const qualifiesFreeByThreshold = subtotal >= FREE_SHIPPING_THRESHOLD;
  const freeShippingApplied =
    itemCount > 0 && (qualifiesFreeByThreshold || freeShip);

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
    couponApplied: opts.coupon && !error ? opts.coupon.code : null,
    couponError: error,
  };
}
