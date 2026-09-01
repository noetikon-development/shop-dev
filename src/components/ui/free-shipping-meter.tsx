import { cn } from "@/lib/utils";
import { formatPrice } from "@/lib/utils";

/**
 * Free-shipping progress indicator (Phase 5D Stage 2). One implementation for
 * the cart page and the cart drawer (previously duplicated). Renders nothing
 * when no threshold is configured. The caller supplies the already-computed
 * values from `computeTotals()` — this component does no pricing.
 */
export function FreeShippingMeter({
  subtotal,
  threshold,
  applied,
  remaining,
  size = "md",
  className,
}: {
  subtotal: number;
  threshold: number;
  applied: boolean;
  remaining: number;
  size?: "sm" | "md";
  className?: string;
}) {
  if (threshold <= 0) return null;

  const text = size === "sm" ? "text-meta" : "text-body";

  if (applied) {
    return (
      <div
        className={cn("rounded-md bg-sage-50 px-4 py-3 font-medium text-sage", text, className)}
      >
        Your order qualifies for free standard shipping.
      </div>
    );
  }

  const pct = Math.min(100, Math.round((subtotal / threshold) * 100));

  return (
    <div
      className={cn(
        "rounded-md border border-line bg-surface",
        size === "sm" ? "p-3" : "p-4",
        className,
      )}
    >
      <p className={cn("text-ink-soft", text)}>
        Add <span className="font-semibold text-ink">{formatPrice(remaining)}</span> more for free
        standard shipping
      </p>
      <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
        <div
          className="h-full rounded-full bg-clay transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
