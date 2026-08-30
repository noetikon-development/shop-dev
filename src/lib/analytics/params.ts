/**
 * Query-parameter validation for the analytics dashboard + export (Step 18, §29/§32).
 *
 * The browser may only ask for: a date range (preset OR custom from/to), a
 * report tab, a page number, a sort key, and whether to compare to the previous
 * period. It may NOT send totals, counts or any computed metric — the server
 * derives all of those. Everything here is parsed with Zod and clamped; invalid
 * input yields safe defaults (dashboard) or a 400 (export).
 */
import { z } from "zod";
import { PRESET_KEYS } from "@/lib/analytics/range";

const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .optional();

export const dashboardParamsSchema = z.object({
  preset: z
    .enum(PRESET_KEYS as [string, ...string[]])
    .optional()
    .default("last_30_days"),
  from: isoDay,
  to: isoDay,
  compare: z
    .union([z.literal("1"), z.literal("0"), z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => v === "1" || v === "true"),
  // Best-sellers / product-performance table paging + sort.
  page: z.coerce.number().int().min(1).max(1000).optional().default(1),
  sort: z.enum(["units", "value", "orders"]).optional().default("units"),
});

export type DashboardParams = z.infer<typeof dashboardParamsSchema>;

export const EXPORT_TYPES = ["product-sales", "coupon-usage", "orders-by-day", "customer-summary"] as const;
export type ExportType = (typeof EXPORT_TYPES)[number];

export const exportParamsSchema = z.object({
  type: z.enum(EXPORT_TYPES),
  preset: z.enum(PRESET_KEYS as [string, ...string[]]).optional().default("last_30_days"),
  from: isoDay,
  to: isoDay,
});

export type ExportParams = z.infer<typeof exportParamsSchema>;

/** Normalise Next's `searchParams` (`string | string[] | undefined`) to strings. */
export function flattenSearchParams(
  sp: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === "string") out[k] = v;
    else if (Array.isArray(v) && typeof v[0] === "string") out[k] = v[0];
  }
  return out;
}
