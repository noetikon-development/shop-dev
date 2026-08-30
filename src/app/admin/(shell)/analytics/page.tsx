import type { Metadata } from "next";
import { requirePermission } from "@/lib/admin/rbac";
import { getSiteSettings } from "@/lib/site-settings";
import { PageHeader } from "@/components/admin/ui";
import { RangePicker } from "@/components/admin/analytics/range-picker";
import { AnalyticsDashboard } from "@/components/admin/analytics/dashboard";
import {
  dashboardParamsSchema,
  flattenSearchParams,
} from "@/lib/analytics/params";
import { resolveRange, previousPeriod, type ResolvedRange } from "@/lib/analytics/range";
import { loadDashboard, type ProductPerfSort } from "@/lib/analytics/queries";
import { safeMoneyFormat } from "@/lib/analytics/format";

export const metadata: Metadata = { title: "Analytics" };
export const dynamic = "force-dynamic";

export default async function AdminAnalyticsPage({
  searchParams,
}: PageProps<"/admin/analytics">) {
  await requirePermission("view_analytics");

  const settings = await getSiteSettings();
  const tz = settings.regional.timezone;
  const money = safeMoneyFormat(settings.regional.currency, settings.regional.locale);

  const raw = flattenSearchParams(await searchParams);
  const parsed = dashboardParamsSchema.safeParse(raw);
  const params = parsed.success
    ? parsed.data
    : dashboardParamsSchema.parse({}); // safe defaults on malformed input

  const resolved = resolveRange({ preset: params.preset, from: params.from, to: params.to }, tz);

  // Preserve the current range in every internal link.
  const rangeQuery = (): Record<string, string> => {
    const q: Record<string, string> = { preset: params.preset };
    if (params.preset === "custom") {
      if (params.from) q.from = params.from;
      if (params.to) q.to = params.to;
    }
    if (params.compare) q.compare = "1";
    return q;
  };
  const buildHref = (patch: Record<string, string>) => {
    const q = new URLSearchParams({ ...rangeQuery(), sort: params.sort, ...patch });
    return `/admin/analytics?${q.toString()}`;
  };
  const exportHref = (type: string) => {
    const q = new URLSearchParams({ type, preset: params.preset });
    if (params.preset === "custom") {
      if (params.from) q.set("from", params.from);
      if (params.to) q.set("to", params.to);
    }
    return `/admin/analytics/export?${q.toString()}`;
  };

  return (
    <div>
      <PageHeader
        title="Analytics"
        description="Store performance from the live database — orders, products, customers, coupons and inventory. All figures are computed server-side from authoritative records."
      />

      <div className="mb-6">
        <RangePicker
          preset={params.preset}
          from={params.from}
          to={params.to}
          compare={params.compare}
          rangeLabel={resolved.ok ? resolved.range.label : "—"}
          tzLabel={tz}
          error={
            !parsed.success
              ? "Some filters were invalid and were reset."
              : resolved.ok
                ? undefined
                : resolved.error
          }
        />
      </div>

      {resolved.ok ? (
        <AnalyticsContent
          range={resolved.range}
          compare={params.compare}
          sort={params.sort as ProductPerfSort}
          money={money}
          buildHref={buildHref}
          exportHref={exportHref}
        />
      ) : (
        <p className="rounded-md border border-dashed border-line-strong px-6 py-12 text-center text-sm text-ink-soft">
          Choose a valid date range to see analytics.
        </p>
      )}
    </div>
  );
}

async function AnalyticsContent({
  range,
  compare,
  sort,
  money,
  buildHref,
  exportHref,
}: {
  range: ResolvedRange;
  compare: boolean;
  sort: ProductPerfSort;
  money: ReturnType<typeof safeMoneyFormat>;
  buildHref: (patch: Record<string, string>) => string;
  exportHref: (type: string) => string;
}) {
  const previous = compare ? previousPeriod(range) : null;
  const data = await loadDashboard(range, { previous, productSort: sort });

  return (
    <AnalyticsDashboard
      data={data}
      money={money}
      range={range}
      compare={compare}
      productSort={sort}
      buildHref={buildHref}
      exportHref={exportHref}
    />
  );
}
