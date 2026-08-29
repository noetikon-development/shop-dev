"use client";

import { useCart } from "@/lib/cart-store";
import { computeTotals } from "@/lib/pricing";
import { formatPrice } from "@/lib/utils";

export function useOrderTotals(shippingMethodId?: string) {
  const lines = useCart((s) => s.lines);
  const coupon = useCart((s) => s.coupon);
  return computeTotals({
    lines: lines.map((l) => ({ unitPrice: l.unitPrice, quantity: l.quantity })),
    shippingMethodId,
    coupon,
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
      <Row label={`Subtotal (${totals.itemCount} items)`} value={formatPrice(totals.subtotal)} />
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
        <dd className="font-display text-xl">{formatPrice(totals.grandTotal)}</dd>
      </div>
      {totals.couponError && <p className="text-xs text-clay">{totals.couponError}</p>}
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
