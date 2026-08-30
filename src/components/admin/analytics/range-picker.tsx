"use client";

import { useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { RANGE_PRESETS } from "@/lib/analytics/range";

/**
 * Date-range control for the analytics dashboard (§2). Writes `preset` (or
 * `from`/`to` for a custom range) and `compare` to the URL; the server resolves
 * the actual window in the store timezone. The browser clock is never used for
 * a business-day boundary.
 */
export function RangePicker({
  preset,
  from,
  to,
  compare,
  rangeLabel,
  tzLabel,
  error,
}: {
  preset: string;
  from?: string;
  to?: string;
  compare: boolean;
  rangeLabel: string;
  tzLabel: string;
  error?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();

  const push = (updates: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    next.delete("page");
    start(() => router.replace(`${pathname}?${next.toString()}`, { scroll: false }));
  };

  const isCustom = preset === "custom";
  // Sensible defaults for the custom inputs before the user picks anything.
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="rounded-md border border-line bg-surface p-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink-faint">Period</span>
          <select
            value={preset}
            onChange={(e) => push({ preset: e.target.value, from: null, to: null })}
            className="field w-auto py-1.5 pr-8 text-sm"
          >
            {RANGE_PRESETS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        {isCustom && (
          <>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-ink-faint">From</span>
              <input
                type="date"
                defaultValue={from ?? ""}
                max={to || today}
                onChange={(e) => push({ from: e.target.value || null })}
                className="field w-auto py-1.5 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-ink-faint">To</span>
              <input
                type="date"
                defaultValue={to ?? ""}
                min={from || undefined}
                max={today}
                onChange={(e) => push({ to: e.target.value || null })}
                className="field w-auto py-1.5 text-sm"
              />
            </label>
          </>
        )}

        <label className="flex items-center gap-2 text-sm text-ink-soft">
          <input
            type="checkbox"
            checked={compare}
            onChange={(e) => push({ compare: e.target.checked ? "1" : null })}
            className="h-4 w-4 rounded border-line-strong"
          />
          Compare to previous period
        </label>

        {pending && <Loader2 size={15} className="mb-2 animate-spin text-ink-faint" />}
      </div>

      <p className="mt-2 text-xs text-ink-faint">
        {error ? (
          <span className="text-clay">{error}</span>
        ) : (
          <>
            Showing <span className="text-ink-soft">{rangeLabel}</span> · times in{" "}
            <span className="text-ink-soft">{tzLabel}</span>
          </>
        )}
      </p>
    </div>
  );
}
