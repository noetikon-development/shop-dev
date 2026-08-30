/**
 * Analytics date ranges (Step 18) — timezone-aware, server-authoritative.
 *
 * Pure module: no DB, no `server-only`, safe to import from client code (the
 * range picker renders the same preset list and labels).
 *
 * ── Interval convention ──────────────────────────────────────────────────────
 * Every range is a HALF-OPEN interval **[startUtc, endUtc)** — start inclusive,
 * end exclusive. "Last 7 days" ending today means the 7 calendar days up to and
 * including today, i.e. `start = 00:00 of (today − 6 days)` and
 * `end = 00:00 of tomorrow`, both boundaries being midnight in the store's
 * configured business timezone, then converted to the UTC instant that Prisma
 * compares against `Order.placedAt` (a naive-UTC `timestamp(3)` column).
 *
 * ── Timezone ────────────────────────────────────────────────────────────────
 * "Today" / "yesterday" / month boundaries are computed in the store timezone
 * (`regional.timezone` store setting, default `Asia/Manila`). The browser clock
 * is never used for a business-day boundary — the server resolves the range and
 * passes the timezone id explicitly to every query.
 */

export const DEFAULT_TZ = "Asia/Manila";

/** Hard cap on a custom range to keep queries bounded (§32). */
export const MAX_RANGE_DAYS = 366;

export type PresetKey =
  | "today"
  | "yesterday"
  | "last_7_days"
  | "last_30_days"
  | "this_month"
  | "last_month"
  | "custom";

export const RANGE_PRESETS: { key: PresetKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "last_7_days", label: "Last 7 days" },
  { key: "last_30_days", label: "Last 30 days" },
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "custom", label: "Custom range" },
];

export const PRESET_KEYS = RANGE_PRESETS.map((p) => p.key);

export type ResolvedRange = {
  preset: PresetKey;
  /** Human label, e.g. "Last 30 days" or "1 Aug – 14 Aug 2026". */
  label: string;
  /** Inclusive start — the UTC instant of local midnight on the first day. */
  startUtc: Date;
  /** Exclusive end — the UTC instant of local midnight after the last day. */
  endUtc: Date;
  /** First local calendar day, `YYYY-MM-DD` (store tz). */
  startDay: string;
  /** Last local calendar day (inclusive), `YYYY-MM-DD` (store tz). */
  endDay: string;
  /** Whole days covered (endUtc − startUtc, rounded). */
  days: number;
  /** IANA timezone the range was computed in. */
  tz: string;
};

// ---------------------------------------------------------------------------
// Timezone helpers (no external library)
// ---------------------------------------------------------------------------

/** True when `tz` is a timezone id this runtime understands. */
export function isValidTimeZone(tz: string): boolean {
  if (!tz || typeof tz !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Coerce to a usable timezone, falling back to the store default. */
export function safeTimeZone(tz: string | undefined | null): string {
  return tz && isValidTimeZone(tz) ? tz : DEFAULT_TZ;
}

/** The offset (ms) to add to a UTC instant to get wall-clock time in `tz`. */
function tzOffsetMs(instant: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  let hour = get("hour");
  if (hour === 24) hour = 0; // some engines emit "24" for midnight
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return asUtc - instant.getTime();
}

/** The UTC instant of `YYYY-MM-DD 00:00:00` wall-clock time in `tz`. */
export function zonedDayStartUtc(year: number, month1: number, day: number, tz: string): Date {
  // First guess: treat the wall time as if it were UTC, then correct by the
  // zone offset at (approximately) that instant. One correction pass is exact
  // for fixed-offset zones (Asia/Manila) and correct for DST zones except at
  // the ~1h/year transition instants, which is acceptable for daily reporting.
  const guess = Date.UTC(year, month1 - 1, day, 0, 0, 0);
  const offset = tzOffsetMs(new Date(guess), tz);
  return new Date(guess - offset);
}

/** The `{ year, month1, day }` calendar date of `instant` in `tz`. */
export function zonedDateParts(instant: Date, tz: string): { year: number; month1: number; day: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = dtf.formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get("year"), month1: get("month"), day: get("day") };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function isoDay(year: number, month1: number, day: number): string {
  return `${year}-${pad(month1)}-${pad(day)}`;
}

/** Parse a strict `YYYY-MM-DD` string → parts, or null. */
export function parseIsoDay(value: string): { year: number; month1: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!m) return null;
  const year = Number(m[1]);
  const month1 = Number(m[2]);
  const day = Number(m[3]);
  if (month1 < 1 || month1 > 12 || day < 1 || day > 31) return null;
  // Round-trip check catches things like 2026-02-30.
  const d = new Date(Date.UTC(year, month1 - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month1 - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return { year, month1, day };
}

/** Add `n` whole days to a `YYYY-MM-DD` (calendar arithmetic, tz-independent). */
export function addDays(day: string, n: number): string {
  const p = parseIsoDay(day)!;
  const d = new Date(Date.UTC(p.year, p.month1 - 1, p.day + n));
  return isoDay(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

function daysBetween(startUtc: Date, endUtc: Date): number {
  return Math.round((endUtc.getTime() - startUtc.getTime()) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export type RangeInput = {
  preset?: string;
  /** `YYYY-MM-DD`, store-tz calendar day — only for `preset === "custom"`. */
  from?: string;
  to?: string;
};

export type RangeResult =
  | { ok: true; range: ResolvedRange }
  | { ok: false; error: string };

function labelForDays(startDay: string, endDay: string): string {
  const fmt = (d: string) => {
    const p = parseIsoDay(d)!;
    return new Intl.DateTimeFormat("en-PH", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(p.year, p.month1 - 1, p.day)));
  };
  return startDay === endDay ? fmt(startDay) : `${fmt(startDay)} – ${fmt(endDay)}`;
}

function build(preset: PresetKey, startDay: string, endDay: string, tz: string, label?: string): ResolvedRange {
  const s = parseIsoDay(startDay)!;
  const startUtc = zonedDayStartUtc(s.year, s.month1, s.day, tz);
  // endUtc is exclusive → local midnight of the day AFTER endDay.
  const afterEnd = addDays(endDay, 1);
  const ae = parseIsoDay(afterEnd)!;
  const endUtc = zonedDayStartUtc(ae.year, ae.month1, ae.day, tz);
  return {
    preset,
    label: label ?? labelForDays(startDay, endDay),
    startUtc,
    endUtc,
    startDay,
    endDay,
    days: daysBetween(startUtc, endUtc),
    tz,
  };
}

/**
 * Resolve a range from validated input. `now` is injectable for testing;
 * defaults to the real clock (used only to derive "today" in `tz`).
 */
export function resolveRange(input: RangeInput, tzRaw: string | undefined, now: Date = new Date()): RangeResult {
  const tz = safeTimeZone(tzRaw);
  const preset = (PRESET_KEYS as string[]).includes(input.preset ?? "")
    ? (input.preset as PresetKey)
    : "last_30_days";

  const today = zonedDateParts(now, tz);
  const todayStr = isoDay(today.year, today.month1, today.day);

  switch (preset) {
    case "today":
      return { ok: true, range: build("today", todayStr, todayStr, tz, "Today") };

    case "yesterday": {
      const y = addDays(todayStr, -1);
      return { ok: true, range: build("yesterday", y, y, tz, "Yesterday") };
    }

    case "last_7_days":
      return { ok: true, range: build("last_7_days", addDays(todayStr, -6), todayStr, tz, "Last 7 days") };

    case "last_30_days":
      return { ok: true, range: build("last_30_days", addDays(todayStr, -29), todayStr, tz, "Last 30 days") };

    case "this_month": {
      const first = isoDay(today.year, today.month1, 1);
      return { ok: true, range: build("this_month", first, todayStr, tz, "This month") };
    }

    case "last_month": {
      // Day 0 of "this month" is the last day of the previous month.
      const lastMonthEnd = new Date(Date.UTC(today.year, today.month1 - 1, 0));
      const lm = {
        year: lastMonthEnd.getUTCFullYear(),
        month1: lastMonthEnd.getUTCMonth() + 1,
        lastDay: lastMonthEnd.getUTCDate(),
      };
      return {
        ok: true,
        range: build(
          "last_month",
          isoDay(lm.year, lm.month1, 1),
          isoDay(lm.year, lm.month1, lm.lastDay),
          tz,
          "Last month",
        ),
      };
    }

    case "custom": {
      const from = parseIsoDay(input.from ?? "");
      const to = parseIsoDay(input.to ?? "");
      if (!from || !to) return { ok: false, error: "Enter a valid start and end date (YYYY-MM-DD)." };
      const fromStr = isoDay(from.year, from.month1, from.day);
      const toStr = isoDay(to.year, to.month1, to.day);
      if (fromStr > toStr) return { ok: false, error: "The start date must be on or before the end date." };
      const span = daysBetween(
        zonedDayStartUtc(from.year, from.month1, from.day, tz),
        zonedDayStartUtc(to.year, to.month1, to.day + 1, tz),
      );
      if (span > MAX_RANGE_DAYS) {
        return { ok: false, error: `The range is too large. Choose ${MAX_RANGE_DAYS} days or fewer.` };
      }
      return { ok: true, range: build("custom", fromStr, toStr, tz) };
    }
  }
}

/**
 * The equivalent period immediately before `range` (same number of days,
 * ending the day before `range` starts). Used for period-over-period deltas.
 */
export function previousPeriod(range: ResolvedRange): ResolvedRange {
  const prevEndDay = addDays(range.startDay, -1);
  const prevStartDay = addDays(prevEndDay, -(range.days - 1));
  return build("custom", prevStartDay, prevEndDay, range.tz, `Previous period (${labelForDays(prevStartDay, prevEndDay)})`);
}

/**
 * A naive-UTC timestamp literal (`YYYY-MM-DD HH:MM:SS.mmm`) for a UTC instant —
 * used to bind range boundaries into raw SQL as `::timestamp` so the comparison
 * against the naive-UTC `Order.placedAt` column is exact and index-friendly.
 */
export function toNaiveUtcLiteral(instant: Date): string {
  return instant.toISOString().replace("T", " ").replace("Z", "");
}
