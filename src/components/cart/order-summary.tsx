"use client";

import { useCart } from "@/lib/cart-store";
import { computeTotals } from "@/lib/pricing";
import { formatPrice, pluralize } from "@/lib/utils";
import { useStorefrontConfig } from "@/components/storefront-config-provider";

export function useOrderTotals(shippingMethodId?: string) {
  const lines = useCart((s) => s.lines);
  const coupon = useCart((s) => s.coupon);
  const config = useStorefrontConfig();
  return computeTotals({
    lines: lines
      .filter((l) => !l.unavailable)
      .map((l) => ({ unitPrice: l.unitPrice, quantity: Math.min(l.quantity, l.available) })),
    shippingMethodId,
    discount: coupon?.valid ? coupon.discount : 0,
    couponCode: coupon?.code ?? null,
    shipping: { freeThreshold: config.freeShippingThreshold, methods: config.shippingMethods },
  });
}

export function OrderSummaryLines({
  shippingMethodId,
  showShipping = true,
}: {
  shippingMethodId?: string;
  showShipping?: boolean;
}) {
  const totals = useOrderTotals(shippingMethodId);

  return (
    <dl className="space-y-2.5 text-sm">
      <Row
        label={`Subtotal (${totals.itemCount} ${pluralize(totals.itemCount, "item")})`}
        value={formatPrice(totals.subtotal)}
      />
      {totals.discountTotal > 0 && (
        <Row
          label={`Discount · ${totals.couponApplied}`}
          value={`−${formatPrice(totals.discountTotal)}`}
          tone="success"
        />
      )}
      {showShipping && (
        <Row
          label="Shipping"
          value={
            totals.itemCount === 0
              ? "—"
              : totals.freeShippingApplied
                ? "Free"
                : formatPrice(totals.shippingFee)
          }
        />
      )}
      <div className="!mt-4 flex items-baseline justify-between border-t border-line pt-4">
        <dt className="font-medium">Total</dt>
        <dd className="font-display text-subtitle">{formatPrice(totals.grandTotal)}</dd>
      </div>
    </dl>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "success";
}) {
  return (
    <div className="flex items-baseline justify-between">
      <dt className="text-ink-soft">{label}</dt>
      <dd className={tone === "success" ? "text-success" : "text-ink"}>{value}</dd>
    </div>
  );
}
