"use client";

import { useState } from "react";
import { Tag, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useCart } from "@/lib/cart-store";
import { validateCoupon } from "@/lib/actions";
import { computeTotals } from "@/lib/pricing";

export function CouponField() {
  const lines = useCart((s) => s.lines);
  const coupon = useCart((s) => s.coupon);
  const setCoupon = useCart((s) => s.setCoupon);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const subtotal = computeTotals({
    lines: lines
      .filter((l) => !l.unavailable)
      .map((l) => ({ unitPrice: l.unitPrice, quantity: Math.min(l.quantity, l.available) })),
  }).subtotal;

  async function apply() {
    if (!code.trim() || busy) return;
    setBusy(true);
    const res = await validateCoupon(code, subtotal);
    setBusy(false);
    if (res.ok) {
      setCoupon(res.coupon);
      setCode("");
      toast.success(res.message);
    } else {
      toast.error(res.error);
    }
  }

  if (coupon) {
    return (
      <div className="flex items-center justify-between rounded-sm border border-sage/40 bg-sage-50 px-3 py-2.5 text-sm">
        <span className="inline-flex items-center gap-2 font-medium text-sage">
          <Tag size={14} /> {coupon.code} applied
        </span>
        <button
          onClick={() => setCoupon(null)}
          className="text-ink-faint hover:text-ink"
          aria-label="Remove coupon"
        >
          <X size={15} />
        </button>
      </div>
    );
  }

  return (
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
  );
}
