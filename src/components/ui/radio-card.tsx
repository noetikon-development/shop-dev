"use client";

import { cn } from "@/lib/utils";

/**
 * Selectable bordered card wrapping a native radio input (Phase 5D Stage 2).
 * Replaces the two hand-rolled versions in the checkout flow (shipping /
 * billing address list, delivery-method list). The caller owns the inner
 * layout via `children`; this component owns the label wrapper, the input and
 * the selected / disabled border states.
 */
export function RadioCard({
  name,
  value,
  checked,
  onSelect,
  disabled = false,
  align = "center",
  className,
  children,
}: {
  name: string;
  value: string;
  checked: boolean;
  onSelect: (value: string) => void;
  disabled?: boolean;
  /** Vertical alignment of the radio dot against multi-line content. */
  align?: "center" | "start";
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label
      className={cn(
        "flex gap-3 rounded-md border p-3.5 text-sm transition-colors",
        checked ? "border-ink bg-surface" : "border-field-border hover:border-ink/50",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
        className,
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={() => onSelect(value)}
        className={cn("accent-ink", align === "start" ? "mt-0.5 self-start" : "self-center")}
      />
      {children}
    </label>
  );
}
