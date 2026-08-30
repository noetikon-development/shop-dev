import { Card } from "@/components/admin/ui";

/**
 * Metric definitions (§23) — kept visible to admins and future developers, not
 * buried in code. Mirrors the doc comment in src/lib/analytics/queries.ts.
 */
export function MetricDefinitions({ tzLabel }: { tzLabel: string }) {
  const rows: { term: string; def: string }[] = [
    {
      term: "Included order",
      def: `An order whose placed-at time falls in the selected period and whose status is not CANCELLED. Date boundaries are midnight-to-midnight in ${tzLabel}; the range is inclusive of the start day and exclusive of the day after the end day. This is the set behind every sales metric below.`,
    },
    {
      term: "Orders",
      def: "Count of included orders. Cancelled orders are shown separately and in the status breakdown, not in this figure.",
    },
    {
      term: "Order value (net)",
      def: "Sum of each included order's authoritative grand-total snapshot. Never recomputed from current product prices, coupons or shipping rates.",
    },
    {
      term: "Gross / Discounts / Shipping",
      def: "Sums of the order subtotal, discount total and shipping fee snapshots for included orders. Gross − Discounts + Shipping = Net.",
    },
    {
      term: "Paid revenue",
      def: "Sum of grand totals for orders explicitly marked paymentStatus = PAID. This reads an authoritative field and is never inferred from order creation. No automated payment flow exists yet (PayMongo is deferred), so this reflects only orders reconciled as paid by an admin or the demo seed.",
    },
    {
      term: "Average order value",
      def: "Order value ÷ number of included orders, to the nearest centavo. Not payment-based — it is not an 'average paid order value'.",
    },
    {
      term: "Units sold",
      def: "Sum of order-item quantities across included orders.",
    },
    {
      term: "Best-selling products",
      def: "Aggregated from OrderItem history for included orders — units, distinct orders and order value per product. Product.soldCount (a lifetime merchandising counter) is not used for date-ranged figures.",
    },
    {
      term: "Category performance",
      def: "Order-item sales grouped by each product's CURRENT category. OrderItem has no historical category snapshot, so re-categorising a product moves its past sales with it.",
    },
    {
      term: "New customers",
      def: "Customer accounts created within the period. Customers with orders / repeat customers are counted from included orders in the period (repeat = 2 or more).",
    },
    {
      term: "Coupon usage",
      def: "From immutable CouponRedemption snapshots whose order is not cancelled: redemption count and the discount amount recorded at order time — not the coupon's current configuration.",
    },
    {
      term: "Inventory insights",
      def: "Current stock state (not period-scoped, read-only). Out-of-stock and low-stock are derived from available = on-hand − reserved vs the reorder point, for ACTIVE variants.",
    },
  ];

  return (
    <Card>
      <details>
        <summary className="cursor-pointer text-sm font-semibold text-ink">Metric definitions</summary>
        <dl className="mt-3 space-y-3 text-sm">
          {rows.map((r) => (
            <div key={r.term}>
              <dt className="font-medium text-ink">{r.term}</dt>
              <dd className="text-ink-soft">{r.def}</dd>
            </div>
          ))}
        </dl>
      </details>
    </Card>
  );
}
