"use client";

import { Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Canonical quantity control (Phase 5D Stage 2). Replaces the three
 * hand-rolled steppers in the PDP, the cart page and the cart drawer.
 *
 * Behaviour is unchanged from those: it emits the next clamped value via
 * `onChange` (the caller still owns the store update / local state), and the
 * −/+ buttons disable at `min` / `max`.
 */
export function QuantityStepper({
  value,
  onChange,
  min = 1,
  max = 99,
  size = "md",
  disabled = false,
  className,
  ariaLabel = "Quantity",
}: {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  size?: "sm" | "md";
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const btn = size === "sm" ? "h-9 w-9" : "h-12 w-11";
  const num = size === "sm" ? "w-9" : "w-10";
  const icon = size === "sm" ? 14 : 15;

  return (
    <div
      className={cn(
        "inline-flex items-center rounded-sm border border-field-border",
        disabled && "opacity-50",
        className,
      )}
      role="group"
      aria-label={ariaLabel}
    >
      <button
        type="button"
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={disabled || value <= min}
        aria-label="Decrease quantity"
        className={cn(
          "tap grid place-items-center text-ink-soft transition-colors hover:text-ink disabled:opacity-30",
          btn,
        )}
      >
        <Minus size={icon} />
      </button>
      <span className={cn("text-center text-sm font-medium tabular-nums", num)}>{value}</span>
      <button
        type="button"
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={disabled || value >= max}
        aria-label="Increase quantity"
        className={cn(
          "tap grid place-items-center text-ink-soft transition-colors hover:text-ink disabled:opacity-30",
          btn,
        )}
      >
        <Plus size={icon} />
      </button>
    </div>
  );
}
