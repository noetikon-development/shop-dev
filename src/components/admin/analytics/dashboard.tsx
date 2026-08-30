import Link from "next/link";
import {
  ShoppingBag,
  Wallet,
  Calculator,
  Package,
  Users,
  UserPlus,
  TicketPercent,
  Boxes,
} from "lucide-react";
import { Card, CardHeader, DataTable, StatCard, type Column } from "@/components/admin/ui";
import { MetricCard } from "@/components/admin/analytics/metric-card";
import { TrendChart } from "@/components/admin/analytics/trend-chart";
import { BreakdownBars } from "@/components/admin/analytics/breakdown-bars";
import { MetricDefinitions } from "@/components/admin/analytics/definitions";
import { ORDER_STATUS_META } from "@/lib/constants";
import { formatCount, formatMoney, type MoneyFormat } from "@/lib/analytics/format";
import type { ResolvedRange } from "@/lib/analytics/range";
import type { DashboardData, ProductPerfRow, ProductPerfSort } from "@/lib/analytics/queries";

const PAYMENT_LABEL: Record<string, string> = {
  PAID: "Paid",
  PENDING: "Payment pending",
  UNPAID: "Unpaid",
  REFUNDED: "Refunded",
};

function statusLabel(status: string): string {
  return ORDER_STATUS_META[status]?.label ?? status.replace(/_/g, " ").toLowerCase();
}

export function AnalyticsDashboard({
  data,
  money,
  range,
  compare,
  productSort,
  buildHref,
  exportHref,
}: {
  data: DashboardData;
  money: MoneyFormat;
  range: ResolvedRange;
  compare: boolean;
  productSort: ProductPerfSort;
  /** Build a dashboard URL preserving the range, patching the given params. */
  buildHref: (patch: Record<string, string>) => string;
  /** Build a CSV export URL for the current range. */
  exportHref: (type: string) => string;
}) {
  const s = data.summary;
  const prev = data.previousSummary;
  const m = (c: number) => formatMoney(c, money);

  const productColumns: Column<ProductPerfRow>[] = [
    {
      key: "name",
      header: "Product",
      cell: (r) => (
        <Link href={`/admin/products/${r.productId}`} className="font-medium text-ink hover:underline">
          {r.name}
        </Link>
      ),
    },
    { key: "units", header: sortHeader("Units", "units"), align: "right", cell: (r) => formatCount(r.units) },
    { key: "orders", header: sortHeader("Orders", "orders"), align: "right", cell: (r) => formatCount(r.orders) },
    {
      key: "value",
      header: sortHeader("Order value", "value"),
      align: "right",
      cell: (r) => m(r.valueCentavos),
    },
    { key: "avg", header: "Avg price", align: "right", cell: (r) => m(r.avgSellCentavos) },
    {
      key: "stock",
      header: "Available",
      align: "right",
      cell: (r) => <span className={r.available <= 0 ? "text-clay" : undefined}>{formatCount(r.available)}</span>,
    },
  ];

  function sortHeader(label: string, key: ProductPerfSort) {
    const active = productSort === key;
    return (
      <Link
        href={buildHref({ sort: key })}
        className={active ? "text-ink underline" : "hover:text-ink"}
        aria-sort={active ? "descending" : "none"}
      >
        {label}
        {active ? " ↓" : ""}
      </Link>
    );
  }

  return (
    <div className="space-y-6">
      {!data.hasAnyData && (
        <div className="rounded-md border border-line bg-surface-sunken/50 px-4 py-3 text-sm text-ink-soft">
          No orders, new customers or coupon redemptions in this period. Inventory figures below reflect
          current stock.
        </div>
      )}

      {/* Summary cards */}
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <MetricCard
          label="Orders"
          value={formatCount(s.orders)}
          sub={s.cancelledOrders > 0 ? `${formatCount(s.cancelledOrders)} cancelled (excluded)` : "excludes cancelled"}
          current={s.orders}
          previous={prev?.orders}
          compare={compare}
          icon={<ShoppingBag size={16} />}
        />
        <MetricCard
          label="Order value"
          value={m(s.netCentavos)}
          sub="net of discounts, incl. shipping"
          current={s.netCentavos}
          previous={prev?.netCentavos}
          compare={compare}
          icon={<Wallet size={16} />}
        />
        <MetricCard
          label="Average order value"
          value={s.orders > 0 ? m(s.aovCentavos) : null}
          sub="order value ÷ orders"
          current={s.aovCentavos}
          previous={prev?.aovCentavos}
          compare={compare}
          icon={<Calculator size={16} />}
        />
        <MetricCard
          label="Units sold"
          value={formatCount(s.unitsSold)}
          sub="order-item quantities"
          current={s.unitsSold}
          previous={prev?.unitsSold}
          compare={compare}
          icon={<Package size={16} />}
        />
        <MetricCard
          label="Customers with orders"
          value={formatCount(data.customers.customersWithOrders)}
          sub={data.customers.guestOrders > 0 ? `${formatCount(data.customers.guestOrders)} guest orders` : "in this period"}
          icon={<Users size={16} />}
        />
        <MetricCard
          label="New customers"
          value={formatCount(data.customers.newCustomers)}
          sub={`${formatCount(data.customers.totalCustomers)} registered all-time`}
          icon={<UserPlus size={16} />}
        />
      </section>

      {/* Value breakdown + paid revenue */}
      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Order value breakdown" />
          <dl className="space-y-2 text-sm">
            <Row label="Gross (subtotal)" value={m(s.grossCentavos)} />
            <Row label="Discounts" value={s.discountCentavos > 0 ? `− ${m(s.discountCentavos)}` : m(0)} />
            <Row label="Shipping" value={m(s.shippingCentavos)} />
            <Row label="Net order value" value={m(s.netCentavos)} strong />
          </dl>
        </Card>

        <Card>
          <CardHeader title="Payment status" />
          <p className="mb-3 text-xs text-ink-faint">
            Paid revenue counts only orders explicitly marked paid. Payment capture (PayMongo) is not yet
            implemented, so most orders remain awaiting payment.
          </p>
          <div className="mb-4 rounded-md border border-line bg-surface-sunken/40 px-3 py-2">
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-ink-soft">Paid revenue (reconciled)</span>
              <span className="font-display text-lg text-ink">
                {data.payment.paidOrders > 0 ? m(data.payment.paidRevenueCentavos) : m(0)}
              </span>
            </div>
            <p className="text-xs text-ink-faint">
              {data.payment.paidOrders > 0
                ? `${formatCount(data.payment.paidOrders)} paid ${data.payment.paidOrders === 1 ? "order" : "orders"}`
                : "No confirmed paid payments in this period"}
            </p>
          </div>
          <BreakdownBars
            items={data.payment.byStatus.map((p) => ({
              key: p.paymentStatus,
              label: PAYMENT_LABEL[p.paymentStatus] ?? p.paymentStatus,
              value: p.count,
              valueLabel: `${formatCount(p.count)} · ${m(p.centavos)}`,
              tone: p.paymentStatus === "PAID" ? "sage" : "ink",
            }))}
          />
        </Card>
      </section>

      {/* Trend */}
      <Card>
        <TrendChart points={data.trend} money={money} title={range.label.toLowerCase()} />
      </Card>

      {/* Status breakdown + category performance */}
      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Orders by status" />
          <BreakdownBars
            items={data.status.map((row) => ({
              key: row.status,
              label: statusLabel(row.status),
              value: row.count,
              valueLabel: `${formatCount(row.count)} · ${m(row.netCentavos)}`,
              tone: row.status === "CANCELLED" ? "clay" : row.status === "DELIVERED" ? "sage" : "brand",
            }))}
          />
        </Card>
        <Card>
          <CardHeader title="Category performance" />
          <BreakdownBars
            items={data.categories.map((c) => ({
              key: c.categoryId,
              label: c.name,
              value: c.valueCentavos,
              valueLabel: `${m(c.valueCentavos)} · ${formatCount(c.units)} ${c.units === 1 ? "unit" : "units"}`,
            }))}
          />
          {data.categories.length > 0 && (
            <p className="mt-3 text-xs text-ink-faint">
              Attributed to each product&rsquo;s current category — OrderItem has no historical category
              snapshot.
            </p>
          )}
        </Card>
      </section>

      {/* Best-selling products */}
      <Card>
        <CardHeader
          title="Best-selling products"
          action={
            data.productTotal > data.topProducts.length ? (
              <span className="text-xs text-ink-faint">
                Top {data.topProducts.length} of {formatCount(data.productTotal)}
              </span>
            ) : undefined
          }
        />
        <DataTable
          columns={productColumns}
          rows={data.topProducts}
          getRowKey={(r) => r.productId}
          empty={{ title: "No product sales in this period." }}
        />
        <div className="mt-3 flex flex-wrap gap-3 text-xs">
          <ExportLink href={exportHref("product-sales")} label="Export product sales (CSV)" />
        </div>
      </Card>

      {/* Customers + coupons */}
      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Customer metrics" />
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <Stat label="With orders" value={formatCount(data.customers.customersWithOrders)} />
            <Stat label="Repeat (2+ orders)" value={formatCount(data.customers.repeatCustomers)} />
            <Stat label="New in period" value={formatCount(data.customers.newCustomers)} />
            <Stat label="Avg orders / customer" value={String(data.customers.avgOrdersPerCustomer)} />
            <Stat label="Guest orders" value={formatCount(data.customers.guestOrders)} />
            <Stat
              label="Customers ever ordered"
              value={formatCount(data.customers.allTimeCustomersWithOrders)}
            />
          </dl>
        </Card>

        <Card>
          <CardHeader
            title="Coupon usage"
            action={<TicketPercent size={16} className="text-ink-faint" />}
          />
          <div className="mb-3 flex gap-6 text-sm">
            <div>
              <div className="font-display text-xl text-ink">{formatCount(data.coupons.redemptions)}</div>
              <div className="text-xs text-ink-faint">redemptions</div>
            </div>
            <div>
              <div className="font-display text-xl text-ink">{m(data.coupons.discountCentavos)}</div>
              <div className="text-xs text-ink-faint">total discount</div>
            </div>
            <div>
              <div className="font-display text-xl text-ink">{formatCount(data.distinctCoupons)}</div>
              <div className="text-xs text-ink-faint">coupons used</div>
            </div>
          </div>
          <BreakdownBars
            items={data.coupons.top.map((c) => ({
              key: c.code,
              label: <span className="font-mono text-xs">{c.code}</span>,
              value: c.redemptions,
              valueLabel: `${formatCount(c.redemptions)} · ${m(c.discountCentavos)}`,
            }))}
            emptyLabel="No coupons redeemed in this period."
          />
          <div className="mt-3 text-xs">
            <ExportLink href={exportHref("coupon-usage")} label="Export coupon usage (CSV)" />
          </div>
        </Card>
      </section>

      {/* Inventory */}
      <Card>
        <CardHeader
          title="Inventory insights"
          action={
            <Link href="/admin/inventory" className="text-xs text-ink-faint hover:text-ink">
              Manage inventory
            </Link>
          }
        />
        <p className="mb-4 text-xs text-ink-faint">
          Current stock — not affected by the selected date range. Read-only.
        </p>
        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Active variants"
            value={formatCount(data.inventory.activeVariants)}
            hint={`${formatCount(data.inventory.totalVariants)} total`}
            icon={<Boxes size={16} />}
          />
          <StatCard
            label="Out of stock"
            value={formatCount(data.inventory.outOfStock)}
            hint="available ≤ 0"
          />
          <StatCard
            label="Low stock"
            value={formatCount(data.inventory.lowStock)}
            hint="at or below reorder point"
          />
          <StatCard
            label="Needs reorder"
            value={formatCount(data.inventory.productsNeedingReorder)}
            hint="products with a flagged variant"
          />
          <StatCard
            label="Stock value (retail)"
            value={m(data.inventory.retailValueCentavos)}
            hint="on-hand × variant price"
          />
          <StatCard
            label="Stock value (cost)"
            value={data.inventory.costValueCentavos == null ? null : m(data.inventory.costValueCentavos)}
            hint={
              data.inventory.costValueCentavos == null
                ? "no cost prices recorded"
                : `cost price on ${data.inventory.costCoverage.withCost}/${data.inventory.costCoverage.total} variants`
            }
            placeholder="No cost prices recorded"
          />
        </section>

        <h3 className="mb-2 mt-6 text-sm font-semibold text-ink">
          Low stock {data.lowStock.total > 0 && `(${formatCount(data.lowStock.total)})`}
        </h3>
        <DataTable
          columns={[
            {
              key: "product",
              header: "Product",
              cell: (r: DashboardData["lowStock"]["rows"][number]) => (
                <div>
                  <Link href={`/admin/products/${r.productId}`} className="font-medium text-ink hover:underline">
                    {r.productName}
                  </Link>
                  <div className="text-xs text-ink-faint">{r.optionLabel}</div>
                </div>
              ),
            },
            { key: "sku", header: "SKU", cell: (r) => <span className="font-mono text-xs">{r.sku}</span> },
            { key: "onHand", header: "On hand", align: "right", cell: (r) => formatCount(r.onHand) },
            { key: "reserved", header: "Reserved", align: "right", cell: (r) => formatCount(r.reserved) },
            {
              key: "available",
              header: "Available",
              align: "right",
              cell: (r) => (
                <span className={r.available <= 0 ? "text-clay" : "text-[#8a5a1f]"}>
                  {formatCount(r.available)}
                </span>
              ),
            },
            { key: "reorder", header: "Reorder at", align: "right", cell: (r) => formatCount(r.reorderPoint) },
          ]}
          rows={data.lowStock.rows}
          getRowKey={(r) => r.sku}
          empty={{ title: "No low or out-of-stock variants." }}
        />
      </Card>

      {/* Exports */}
      <Card>
        <CardHeader title="Export" />
        <p className="mb-3 text-xs text-ink-faint">
          Server-generated CSV for the selected period. Amounts are in {money.currency}.
        </p>
        <div className="flex flex-wrap gap-3 text-xs">
          <ExportLink href={exportHref("product-sales")} label="Product sales" />
          <ExportLink href={exportHref("coupon-usage")} label="Coupon usage" />
          <ExportLink href={exportHref("orders-by-day")} label="Orders by day" />
          <ExportLink href={exportHref("customer-summary")} label="Customer summary" />
        </div>
      </Card>

      <MetricDefinitions tzLabel={range.tz} />
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between ${strong ? "border-t border-line pt-2 font-semibold text-ink" : "text-ink-soft"}`}>
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line px-3 py-2">
      <div className="font-display text-lg text-ink">{value}</div>
      <div className="text-xs text-ink-faint">{label}</div>
    </div>
  );
}

function ExportLink({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} className="btn btn-outline py-1.5 text-xs" rel="nofollow">
      {label}
    </a>
  );
}
