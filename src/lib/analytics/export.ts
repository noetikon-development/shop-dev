import "server-only";
import { prisma } from "@/lib/prisma";
import type { ResolvedRange } from "@/lib/analytics/range";
import type { ExportType } from "@/lib/analytics/params";
import {
  getProductPerformance,
  getOrderTrend,
  getCustomerMetrics,
} from "@/lib/analytics/queries";

/**
 * Server-generated CSV exports (§31). Every figure is aggregated in the
 * database from authoritative tables — the browser supplies only the report
 * type and date range. Money is written as a plain decimal string in the store
 * currency (whole and fractional parts split with integer arithmetic — no
 * floating point) alongside a `currency` column.
 */

/** Integer centavos → decimal major-unit string, e.g. 3299000 → "32990.00". */
export function centavosToDecimalString(centavos: number): string {
  const c = Math.trunc(Number.isFinite(centavos) ? centavos : 0);
  const sign = c < 0 ? "-" : "";
  const abs = Math.abs(c);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function csvCell(value: string | number): string {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers: string[], rows: (string | number)[][]): string {
  const lines = [headers, ...rows].map((r) => r.map(csvCell).join(","));
  // Leading BOM so Excel opens UTF-8 correctly; CRLF line endings (RFC 4180).
  return "﻿" + lines.join("\r\n") + "\r\n";
}

export type CsvResult = { filename: string; body: string };

export async function buildCsv(
  type: ExportType,
  range: ResolvedRange,
  currency: string,
): Promise<CsvResult> {
  const stamp = `${range.startDay}_${range.endDay}`;

  if (type === "product-sales") {
    const { rows } = await getProductPerformance(range, { page: 1, pageSize: 200, sort: "units" });
    return {
      filename: `product-sales_${stamp}.csv`,
      body: toCsv(
        ["Product", "Status", "Units sold", "Orders", "Order value", "Avg selling price", "Current stock", "Available", "Currency"],
        rows.map((r) => [
          r.name,
          r.status,
          r.units,
          r.orders,
          centavosToDecimalString(r.valueCentavos),
          centavosToDecimalString(r.avgSellCentavos),
          r.currentStock,
          r.available,
          currency,
        ]),
      ),
    };
  }

  if (type === "coupon-usage") {
    // Immutable redemption snapshots, not current coupon config.
    const grouped = await prisma.couponRedemption.groupBy({
      by: ["code"],
      where: { createdAt: { gte: range.startUtc, lt: range.endUtc }, order: { status: { not: "CANCELLED" } } },
      _count: { _all: true },
      _sum: { amount: true },
      orderBy: { _sum: { amount: "desc" } },
    });
    return {
      filename: `coupon-usage_${stamp}.csv`,
      body: toCsv(
        ["Coupon code", "Redemptions", "Total discount", "Currency"],
        grouped.map((g) => [g.code, g._count._all, centavosToDecimalString(g._sum.amount ?? 0), currency]),
      ),
    };
  }

  if (type === "orders-by-day") {
    const points = await getOrderTrend(range);
    return {
      filename: `orders-by-day_${stamp}.csv`,
      body: toCsv(
        ["Day", "Orders", "Order value", "Currency"],
        points.map((p) => [p.day, p.orders, centavosToDecimalString(p.valueCentavos), currency]),
      ),
    };
  }

  // customer-summary — aggregated only, no personal data (§30).
  const m = await getCustomerMetrics(range);
  return {
    filename: `customer-summary_${stamp}.csv`,
    body: toCsv(
      ["Metric", "Value"],
      [
        ["Period", `${range.startDay} to ${range.endDay}`],
        ["Total registered customers (all-time)", m.totalCustomers],
        ["New customers in period", m.newCustomers],
        ["Customers with orders in period", m.customersWithOrders],
        ["Repeat customers in period", m.repeatCustomers],
        ["Guest orders in period", m.guestOrders],
        ["Avg orders per customer in period", m.avgOrdersPerCustomer],
      ],
    ),
  };
}
