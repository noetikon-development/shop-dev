import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A compact horizontal bar list — server-rendered, no JS. Used for the order
 * status breakdown, payment breakdown and category performance. Bar widths are
 * proportional to `value`; every row also shows its exact figure as text.
 */
export function BreakdownBars({
  items,
  emptyLabel = "No data for this period.",
}: {
  items: { key: string; label: ReactNode; value: number; valueLabel: string; hint?: string; tone?: "brand" | "sage" | "clay" | "ink" }[];
  emptyLabel?: string;
}) {
  if (items.length === 0) {
    return <p className="py-6 text-center text-sm text-ink-soft">{emptyLabel}</p>;
  }
  const max = Math.max(1, ...items.map((i) => i.value));
  const toneClass: Record<string, string> = {
    brand: "bg-brand",
    sage: "bg-sage",
    clay: "bg-clay",
    ink: "bg-ink",
  };

  return (
    <ul className="space-y-2.5">
      {items.map((item) => (
        <li key={item.key}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate text-ink-soft">{item.label}</span>
            <span className="shrink-0 tabular-nums text-ink">{item.valueLabel}</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
            <div
              className={cn("h-full rounded-full", toneClass[item.tone ?? "brand"])}
              style={{ width: `${Math.max(2, (item.value / max) * 100)}%` }}
            />
          </div>
          {item.hint && <p className="mt-0.5 text-xs text-ink-faint">{item.hint}</p>}
        </li>
      ))}
    </ul>
  );
}
