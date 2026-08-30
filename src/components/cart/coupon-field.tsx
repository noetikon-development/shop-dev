"use client";

import { useState } from "react";
import { Tag, X, Loader2, AlertCircle } from "lucide-react";
import { useCart } from "@/lib/cart-store";
import { formatPrice } from "@/lib/utils";

export function CouponField() {
  const coupon = useCart((s) => s.coupon);
  const applyCoupon = useCart((s) => s.applyCoupon);
  const removeCoupon = useCart((s) => s.removeCoupon);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  async function apply() {
    if (!code.trim() || busy) return;
    setBusy(true);
    const res = await applyCoupon(code);
    setBusy(false);
    if (res.ok) setCode("");
  }

  if (coupon && coupon.valid) {
    return (
      <div className="flex items-center justify-between rounded-sm border border-sage/40 bg-sage-50 px-3 py-2.5 text-sm">
        <span className="inline-flex items-center gap-2 font-medium text-sage">
          <Tag size={14} /> {coupon.code} · −{formatPrice(coupon.discount)}
        </span>
        <button
          onClick={() => removeCoupon()}
          className="text-ink-faint hover:text-ink"
          aria-label="Remove coupon"
        >
          <X size={15} />
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              apply();
            }
          }}
          placeholder="Promo code"
          className="field !py-2.5 text-sm uppercase"
          aria-label="Promo code"
        />
        <button
          type="button"
          onClick={apply}
          disabled={busy}
          className="btn btn-outline shrink-0 !py-2.5"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : "Apply"}
        </button>
      </div>
      {coupon && !coupon.valid && coupon.error && (
        <p className="flex items-start gap-1.5 text-xs text-clay">
          <AlertCircle size={13} className="mt-px shrink-0" />
          <span>
            {coupon.code}: {coupon.error}{" "}
            <button onClick={() => removeCoupon()} className="underline">
              Remove
            </button>
          </span>
        </p>
      )}
    </div>
  );
}
