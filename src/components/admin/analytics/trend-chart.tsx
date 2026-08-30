"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import {
  formatDayLabel,
  formatMoney,
  formatMoneyCompact,
  formatCount,
  type MoneyFormat,
} from "@/lib/analytics/format";

type Point = { day: string; orders: number; valueCentavos: number };
type Metric = "value" | "orders";

/**
 * Daily order trend (§8, §27). Clearly labelled "Order value" / "Order count" —
 * never "Revenue", because it includes orders that are not yet paid. Pure SVG,
 * no charting dependency. Responsive (viewBox), hover/focus tooltip, and a
 * visually-hidden data table as the text alternative. Zero datasets render an
 * explicit empty state.
 */
export function TrendChart({
  points,
  money,
  title = "selected period",
}: {
  points: Point[];
  money: MoneyFormat;
  title?: string;
}) {
  const [metric, setMetric] = useState<Metric>("value");
  const [hover, setHover] = useState<number | null>(null);

  const values = points.map((p) => (metric === "value" ? p.valueCentavos : p.orders));
  const max = Math.max(1, ...values);
  const total = values.reduce((a, b) => a + b, 0);

  const W = 720;
  const H = 200;
  const padX = 6;
  const padTop = 10;
  const padBottom = 20;
  const plotH = H - padTop - padBottom;
  const n = points.length;
  const slot = n > 0 ? (W - padX * 2) / n : W;
  const barW = Math.max(1, Math.min(40, slot * 0.68));

  const axisTicks = useMemo(() => {
    if (n === 0) return [];
    const step = Math.max(1, Math.ceil(n / 6));
    const out: number[] = [];
    for (let i = 0; i < n; i += step) out.push(i);
    if (out.length && out[out.length - 1] !== n - 1) out.push(n - 1);
    return out;
  }, [n]);

  const empty = total === 0;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">
          {metric === "value" ? "Order value" : "Order count"} — {title}
        </h2>
        <div className="flex overflow-hidden rounded-md border border-line text-xs" role="group" aria-label="Chart metric">
          <button
            type="button"
            onClick={() => setMetric("value")}
            className={cn("px-2.5 py-1", metric === "value" ? "bg-surface-sunken text-ink" : "text-ink-faint")}
            aria-pressed={metric === "value"}
          >
            Value
          </button>
          <button
            type="button"
            onClick={() => setMetric("orders")}
            className={cn(
              "border-l border-line px-2.5 py-1",
              metric === "orders" ? "bg-surface-sunken text-ink" : "text-ink-faint",
            )}
            aria-pressed={metric === "orders"}
          >
            Orders
          </button>
        </div>
      </div>

      {empty ? (
        <div className="flex h-[160px] items-center justify-center rounded-md border border-dashed border-line-strong text-sm text-ink-soft">
          No data for this period.
        </div>
      ) : (
        <div className="relative">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="w-full text-brand"
            role="img"
            aria-label={
              metric === "value"
                ? `Order value per day for the ${title}. Total ${formatMoney(total, money)}.`
                : `Order count per day for the ${title}. Total ${formatCount(total)} orders.`
            }
            onMouseLeave={() => setHover(null)}
          >
            <line
              x1={padX}
              y1={padTop + plotH}
              x2={W - padX}
              y2={padTop + plotH}
              stroke="currentColor"
              strokeOpacity="0.15"
            />
            {points.map((p, i) => {
              const v = metric === "value" ? p.valueCentavos : p.orders;
              const h = v <= 0 ? 0 : Math.max(2, (v / max) * plotH);
              const x = padX + i * slot + (slot - barW) / 2;
              const y = padTop + plotH - h;
              const active = hover === i;
              return (
                <g key={p.day}>
                  <rect
                    x={padX + i * slot}
                    y={padTop}
                    width={slot}
                    height={plotH}
                    fill="transparent"
                    tabIndex={0}
                    onMouseEnter={() => setHover(i)}
                    onFocus={() => setHover(i)}
                    onBlur={() => setHover(null)}
                  >
                    <title>{`${formatDayLabel(p.day, { year: "numeric" })}: ${
                      metric === "value" ? formatMoney(p.valueCentavos, money) : `${formatCount(p.orders)} orders`
                    }`}</title>
                  </rect>
                  {h > 0 && (
                    <rect
                      x={x}
                      y={y}
                      width={barW}
                      height={h}
                      rx="1.5"
                      fill="currentColor"
                      fillOpacity={active ? 1 : 0.8}
                    />
                  )}
                </g>
              );
            })}
            {axisTicks.map((i) => (
              <text
                key={i}
                x={padX + i * slot + slot / 2}
                y={H - 5}
                textAnchor="middle"
                className="fill-ink-faint text-[10px]"
              >
                {formatDayLabel(points[i].day)}
              </text>
            ))}
          </svg>

          {hover !== null && (
            <div className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 rounded-md border border-line bg-surface px-3 py-1.5 text-xs shadow-sm">
              <span className="font-medium text-ink">
                {formatDayLabel(points[hover].day, { year: "numeric", weekday: "short" })}
              </span>
              <span className="mx-2 text-line-strong">·</span>
              <span className="text-ink-soft">
                {formatMoney(points[hover].valueCentavos, money)} · {formatCount(points[hover].orders)}{" "}
                {points[hover].orders === 1 ? "order" : "orders"}
              </span>
            </div>
          )}

          <p className="mt-1 text-right text-xs text-ink-faint">
            {metric === "value"
              ? `Total ${formatMoneyCompact(total, money)} order value`
              : `Total ${formatCount(total)} orders`}
          </p>
        </div>
      )}

      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-ink-faint hover:text-ink">View as table</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[24rem] text-xs">
            <caption className="sr-only">Order value and order count per day</caption>
            <thead>
              <tr className="border-b border-line text-left text-ink-faint">
                <th className="py-1.5 pr-4 font-medium">Day</th>
                <th className="py-1.5 pr-4 text-right font-medium">Orders</th>
                <th className="py-1.5 text-right font-medium">Order value</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.day} className="border-b border-line/50 last:border-0">
                  <td className="py-1.5 pr-4 text-ink-soft">{formatDayLabel(p.day, { year: "numeric" })}</td>
                  <td className="py-1.5 pr-4 text-right text-ink-soft">{formatCount(p.orders)}</td>
                  <td className="py-1.5 text-right text-ink-soft">{formatMoney(p.valueCentavos, money)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
