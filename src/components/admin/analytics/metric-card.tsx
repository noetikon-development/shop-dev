import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/admin/ui";
import { formatPctDelta, pctDelta } from "@/lib/analytics/format";

/**
 * A single dashboard metric (§26). Shows a real value or an em-dash — it never
 * fabricates. The optional period-over-period delta reads "N/A" when the
 * previous period has no data (never "∞%"), and is only rendered when a
 * comparison was explicitly requested.
 */
export function MetricCard({
  label,
  value,
  sub,
  current,
  previous,
  compare,
  higherIsBetter = true,
  icon,
}: {
  label: string;
  /** Preformatted display value, or null/undefined for the "no data" dash. */
  value: ReactNode;
  sub?: string;
  /** Raw numeric current value, for the delta calc. */
  current?: number;
  /** Raw numeric previous-period value, for the delta calc. */
  previous?: number;
  compare?: boolean;
  higherIsBetter?: boolean;
  icon?: ReactNode;
}) {
  const hasValue = value !== null && value !== undefined && value !== "";
  const delta =
    compare && typeof current === "number" && typeof previous === "number"
      ? pctDelta(current, previous)
      : undefined;

  const tone =
    delta === undefined || delta === null || delta === 0
      ? "neutral"
      : (delta > 0) === higherIsBetter
        ? "up"
        : "down";

  return (
    <Card className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-ink-faint">{label}</span>
        {icon && <span className="text-ink-faint">{icon}</span>}
      </div>
      <span
        className={cn(
          "font-display text-2xl leading-tight",
          hasValue ? "text-ink" : "text-ink-faint",
        )}
      >
        {hasValue ? value : "—"}
      </span>
      <div className="flex items-center gap-2 text-xs text-ink-faint">
        {sub && <span>{sub}</span>}
        {compare && delta !== undefined && (
          <span
            className={cn(
              "font-medium",
              tone === "up" && "text-sage",
              tone === "down" && "text-clay",
              tone === "neutral" && "text-ink-faint",
            )}
            title="Change vs the previous equivalent period"
          >
            {formatPctDelta(delta)}
          </span>
        )}
      </div>
    </Card>
  );
}
