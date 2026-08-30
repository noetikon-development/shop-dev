/**
 * Analytics display formatting (Step 18). Pure — safe on client and server.
 *
 * Money is stored everywhere as integer **centavos**. Aggregation happens in the
 * database with integer arithmetic (SUM/COUNT); JavaScript only divides by 100
 * for display, never for an authoritative total. The currency and locale come
 * from the store's `regional.*` settings — nothing here hardcodes `₱`.
 *
 * Multi-currency is NOT implemented: every Order/OrderItem/Coupon amount is in
 * the single store currency, so an aggregate never mixes currencies. If
 * multi-currency is added later, amounts must be normalised before summing.
 */

export type MoneyFormat = { currency: string; locale: string };

export const DEFAULT_MONEY_FORMAT: MoneyFormat = { currency: "PHP", locale: "en-PH" };

export function safeMoneyFormat(currency?: string | null, locale?: string | null): MoneyFormat {
  const c = typeof currency === "string" && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : DEFAULT_MONEY_FORMAT.currency;
  const l = typeof locale === "string" && locale.length > 0 && locale.length < 35 ? locale : DEFAULT_MONEY_FORMAT.locale;
  return { currency: c, locale: l };
}

/** Format integer centavos as a currency string in the store's currency. */
export function formatMoney(centavos: number, fmt: MoneyFormat = DEFAULT_MONEY_FORMAT): string {
  const value = (Number.isFinite(centavos) ? centavos : 0) / 100;
  try {
    return new Intl.NumberFormat(fmt.locale, {
      style: "currency",
      currency: fmt.currency,
      minimumFractionDigits: value % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    // Unknown currency/locale → plain number with the code.
    return `${fmt.currency} ${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  }
}

/** Compact money for dense chart axes, e.g. "₱1.2M". */
export function formatMoneyCompact(centavos: number, fmt: MoneyFormat = DEFAULT_MONEY_FORMAT): string {
  const value = (Number.isFinite(centavos) ? centavos : 0) / 100;
  try {
    return new Intl.NumberFormat(fmt.locale, {
      style: "currency",
      currency: fmt.currency,
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value);
  } catch {
    return `${fmt.currency} ${value.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 })}`;
  }
}

export function formatCount(n: number, locale = "en-PH"): string {
  try {
    return new Intl.NumberFormat(locale).format(Number.isFinite(n) ? n : 0);
  } catch {
    return String(n);
  }
}

/**
 * A period-over-period delta. Returns `null` when it cannot be expressed
 * meaningfully (no previous data) — the UI shows "N/A", never "∞%".
 */
export function pctDelta(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

export function formatPctDelta(delta: number | null): string {
  if (delta === null) return "N/A";
  const rounded = Math.round(delta * 10) / 10;
  const sign = rounded > 0 ? "+" : "";
  return `${sign}${rounded}%`;
}

/** Average of a centavo total over a count, as integer centavos (0 when n = 0). */
export function averageCentavos(totalCentavos: number, count: number): number {
  if (!count || count <= 0) return 0;
  return Math.round(totalCentavos / count);
}

/** `YYYY-MM-DD` → short label for a chart axis / tooltip, rendered in UTC. */
export function formatDayLabel(day: string, opts?: Intl.DateTimeFormatOptions): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return new Intl.DateTimeFormat("en-PH", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    ...opts,
  }).format(d);
}
