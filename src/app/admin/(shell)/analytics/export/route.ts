import type { NextRequest } from "next/server";
import { getCurrentAdmin, hasPermission } from "@/lib/admin/rbac";
import { getSiteSettings } from "@/lib/site-settings";
import { exportParamsSchema } from "@/lib/analytics/params";
import { resolveRange } from "@/lib/analytics/range";
import { buildCsv } from "@/lib/analytics/export";
import { safeMoneyFormat } from "@/lib/analytics/format";

/**
 * CSV export for the analytics dashboard (§28, §29, §31, §32).
 *
 * This route handler lives outside the admin layout's guard, so it enforces
 * `view_analytics` itself — an unauthorised request gets a real 403, never a
 * file. All query parameters are validated; the server computes every figure.
 */
export async function GET(req: NextRequest) {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return new Response("Forbidden", { status: 403 });
  }
  if (!hasPermission(admin, "view_analytics")) {
    return new Response("Forbidden", { status: 403 });
  }

  const url = new URL(req.url);
  const parsed = exportParamsSchema.safeParse({
    type: url.searchParams.get("type") ?? undefined,
    preset: url.searchParams.get("preset") ?? undefined,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
  });
  if (!parsed.success) {
    return new Response("Invalid export parameters", { status: 400 });
  }

  const settings = await getSiteSettings();
  const range = resolveRange(
    { preset: parsed.data.preset, from: parsed.data.from, to: parsed.data.to },
    settings.regional.timezone,
  );
  if (!range.ok) {
    return new Response(range.error, { status: 400 });
  }

  const money = safeMoneyFormat(settings.regional.currency, settings.regional.locale);
  const { filename, body } = await buildCsv(parsed.data.type, range.range, money.currency);

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
