/**
 * Phase 9F-44B — pure Order / SellerOrder / settlement / commission consistency
 * rules. No I/O — `scripts/reconcile-marketplace.ts` feeds it production rows,
 * `scripts/test-9f44b.ts` feeds it fixtures.
 *
 * These rules DETECT drift; they never repair it. They do not redesign the
 * state machines (`@/lib/orders/status`, `@/lib/marketplace/seller-order-status`)
 * — they assert the invariants those machines are supposed to preserve.
 */

export type ConsistencyLevel = "PASS" | "WARN" | "FAIL";

export type ConsistencyFinding = {
  rule: "A" | "B" | "C" | "D" | "E" | "F" | "I" | "J" | "K" | "L" | "M" | "N";
  level: ConsistencyLevel;
  invariant: string;
  current: string;
  expected: string;
};

/** A `ConsistencyFinding` from `evaluateOrderAggregation` — `sellerOrderId` is
 *  set only for the per-SellerOrder rule M; the order-wide rules (I/J/K/L/N)
 *  carry `null` (there is no single SellerOrder to attribute them to). */
export type OrderAggregationFinding = ConsistencyFinding & { sellerOrderId: string | null };

export type ReconcileOrder = { orderNumber: string; status: string };

export type ReconcileSellerOrder = {
  id: string;
  sellerType: string;
  status: string;
  settlementStatus: string;
  settlementId: string | null;
  settlementClawbackAmount: number;
  merchandiseSubtotal: number;
  discountAllocated: number;
  shippingFee: number;
  commissionRate: number;
  commissionAmount: number;
  total: number;
};

/** Both machines projected onto one fulfilment scale (see reconcile-marketplace.ts). */
export const PARENT_FULFILMENT_RANK: Record<string, number> = {
  PENDING_PAYMENT: 0,
  PENDING: 0,
  PAID: 1,
  PROCESSING: 1,
  SHIPPED: 3,
  OUT_FOR_DELIVERY: 3,
  DELIVERED: 4,
};
export const SELLER_ORDER_FULFILMENT_RANK: Record<string, number> = {
  PENDING_PAYMENT: 0,
  PROCESSING: 1,
  READY_TO_SHIP: 1,
  SHIPPED: 3,
  DELIVERED: 4,
};

export const VALID_SETTLEMENT_STATUSES = new Set([
  "PENDING_CAPTURE",
  "SETTLED",
  "CLAWED_BACK",
  "CAPTURED",
  "REFUNDED",
]);

/** Return statuses whose ReturnItem value counts against a SellerOrder's receivable. */
export const RETURN_VALUE_STATUSES_44B = new Set(["RECEIVED", "REFUND_INITIATED", "REFUND_COMPLETED"]);

export function roundHalfUp(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

/**
 * Every consistency finding for ONE (parent Order, SellerOrder) pair.
 * `returnedValue` = Σ ReturnItem.refundAmount for value-bearing returns on the
 * parent order whose items belong to this SellerOrder (0 when none).
 * `soleSellerOnOrder` = the parent has exactly one SellerOrder.
 */
export function evaluateSellerOrder(
  order: ReconcileOrder,
  so: ReconcileSellerOrder,
  returnedValue: number,
  soleSellerOnOrder: boolean,
): ConsistencyFinding[] {
  const out: ConsistencyFinding[] = [];
  const pRank = PARENT_FULFILMENT_RANK[order.status];
  const sRank = SELLER_ORDER_FULFILMENT_RANK[so.status];

  // ── A · parent cancellation consistency ────────────────────────────────
  if (order.status === "CANCELLED") {
    if (so.status !== "CANCELLED") {
      out.push({
        rule: "A",
        level: "FAIL",
        invariant: "parent CANCELLED ⟹ SellerOrder CANCELLED",
        current: `SellerOrder ${so.status}`,
        expected: "CANCELLED",
      });
    }
  } else if (so.status === "CANCELLED") {
    if (soleSellerOnOrder && (pRank ?? 0) >= 1) {
      out.push({
        rule: "A",
        level: "FAIL",
        invariant: "lone SellerOrder CANCELLED under a fulfilling parent",
        current: `parent ${order.status}, SellerOrder CANCELLED`,
        expected: "parent should be CANCELLED too",
      });
    }
  } else {
    // ── B · forward-rank consistency (both non-CANCELLED) ────────────────
    if (pRank === undefined || sRank === undefined) {
      out.push({
        rule: "B",
        level: "WARN",
        invariant: "unknown status on one side",
        current: `parent ${order.status} / SellerOrder ${so.status}`,
        expected: "both statuses in the known machines",
      });
    } else {
      // AHEAD: the SellerOrder outranks the parent — a seller SHIPPED/DELIVERED
      // should have rolled the parent up (single-seller) or the admin cascade
      // should have caught up. Sanctioned: SHIPPED/OFD parent + DELIVERED
      // SellerOrder (the seller confirmed delivery before the admin marked it).
      const aheadDrift = sRank > pRank && !(pRank === 3 && sRank === 4);
      // BEHIND: the parent outranks the SellerOrder — the forward cascade should
      // have advanced it. Sanctioned ONLY for a 3P order whose parent is exactly
      // PROCESSING and whose SellerOrder is still PENDING_PAYMENT (the seller has
      // not clicked Accept yet).
      const sanctionedBehind = so.sellerType === "THIRD_PARTY" && pRank === 1 && sRank === 0;
      const behindDrift = sRank < pRank && !sanctionedBehind;
      if (aheadDrift) {
        out.push({
          rule: "B",
          level: "FAIL",
          invariant: "SellerOrder ahead of parent",
          current: `parent ${order.status} (rank ${pRank}) / SellerOrder ${so.status} (rank ${sRank})`,
          expected: "parent should be dispatched (SHIPPED+) too",
        });
      } else if (behindDrift) {
        out.push({
          rule: "B",
          level: "FAIL",
          invariant: "SellerOrder behind parent (shadow / cascade drift)",
          current: `parent ${order.status} (rank ${pRank}) / SellerOrder ${so.status} (rank ${sRank})`,
          expected: `SellerOrder should have cascaded to rank ≥ ${pRank}`,
        });
      }
    }
  }

  // ── C · settlement-combo integrity ────────────────────────────────────
  if (!VALID_SETTLEMENT_STATUSES.has(so.settlementStatus)) {
    out.push({ rule: "C", level: "FAIL", invariant: "settlement combo", current: `unknown settlementStatus "${so.settlementStatus}"`, expected: "a known settlementStatus" });
  }
  if (so.settlementStatus === "PENDING_CAPTURE" && so.settlementId !== null) {
    out.push({ rule: "C", level: "FAIL", invariant: "settlement combo", current: "PENDING_CAPTURE with a settlementId", expected: "PENDING_CAPTURE ⟹ settlementId null" });
  }
  if (so.settlementStatus === "SETTLED" && so.settlementId === null) {
    out.push({ rule: "C", level: "FAIL", invariant: "settlement combo", current: "SETTLED with no settlementId", expected: "SETTLED ⟹ settlementId set" });
  }
  if (so.settlementStatus === "CLAWED_BACK" && so.settlementId === null) {
    out.push({ rule: "C", level: "FAIL", invariant: "settlement combo", current: "CLAWED_BACK with no settlementId", expected: "a clawback only accrues on an already-settled order" });
  }
  if (so.settlementClawbackAmount < 0) {
    out.push({ rule: "C", level: "FAIL", invariant: "settlement combo", current: `negative settlementClawbackAmount ${so.settlementClawbackAmount}`, expected: "settlementClawbackAmount ≥ 0" });
  }
  if (so.sellerType !== "THIRD_PARTY" && so.settlementId !== null) {
    out.push({ rule: "C", level: "FAIL", invariant: "settlement combo", current: "non-THIRD_PARTY SellerOrder linked to a SellerSettlement", expected: "only THIRD_PARTY SellerOrders are settled" });
  }
  if (
    so.sellerType !== "THIRD_PARTY" &&
    so.settlementStatus !== "PENDING_CAPTURE" &&
    so.settlementStatus !== "CAPTURED"
  ) {
    out.push({ rule: "C", level: "WARN", invariant: "settlement combo", current: `non-THIRD_PARTY SellerOrder with settlementStatus "${so.settlementStatus}"`, expected: "PENDING_CAPTURE (or the legacy CAPTURED)" });
  }

  // ── D · commission integrity (non-cancelled) ─────────────────────────
  if (so.status !== "CANCELLED") {
    const expected = roundHalfUp((so.merchandiseSubtotal * so.commissionRate) / 10000);
    if (so.commissionAmount !== expected) {
      if (so.commissionAmount < expected && returnedValue > 0) {
        out.push({ rule: "D", level: "WARN", invariant: "commissionAmount below the formula", current: `${so.commissionAmount} < formula ${expected}; a value-bearing return of ${returnedValue} is present`, expected: `≈ ${expected} less the return correction` });
      } else {
        out.push({ rule: "D", level: "FAIL", invariant: "commissionAmount ≠ roundHalfUp(merch × rate / 10000)", current: `${so.commissionAmount} (merch ${so.merchandiseSubtotal}, rate ${so.commissionRate})`, expected: String(expected) });
      }
    }
  }

  // ── E · SellerOrder.total ────────────────────────────────────────────
  const expTotal = so.merchandiseSubtotal - so.discountAllocated + so.shippingFee;
  if (so.total !== expTotal) {
    out.push({ rule: "E", level: "FAIL", invariant: "total ≠ merchandiseSubtotal − discountAllocated + shippingFee", current: `total ${so.total} (merch ${so.merchandiseSubtotal}, disc ${so.discountAllocated}, ship ${so.shippingFee})`, expected: String(expTotal) });
  }

  // ── F · return refund vs SellerOrder.total ──────────────────────────
  if (returnedValue > so.total) {
    out.push({ rule: "F", level: "FAIL", invariant: "Σ applicable ReturnItem.refundAmount > SellerOrder.total", current: String(returnedValue), expected: `≤ ${so.total}` });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Multi-seller checkout — Phase C: cross-seller aggregation rules (I–N).
//
// Rules A–F above check ONE (Order, SellerOrder) pair in isolation. Once an
// Order can carry N SellerOrder rows (Phase B, `marketplace/order-allocation`),
// a second class of drift becomes possible that no per-pair rule can see: the
// pooled Order-level money fields (subtotal / shippingFee / discountTotal /
// grandTotal) silently drifting from the SUM of what was allocated across
// sellers, or an OrderItem/SellerOrder partition getting duplicated, dropped,
// or misassigned. These rules detect exactly that — they never repair it, and
// they never redefine what "correct" money looks like: they assert the exact
// same sum-preservation invariants `createOrderFromCart`'s own post-write
// checks (checkout.ts §"4c-iv") already enforce at creation time, as a
// standing, repeatable check independent of that one-time write-path guard.
// All amounts are integers in the store's minor currency unit throughout —
// every comparison below is exact integer equality, never a float tolerance.
// ---------------------------------------------------------------------------

export type ReconcileOrderTotals = {
  subtotal: number;
  shippingFee: number;
  discountTotal: number;
  grandTotal: number;
};

export type ReconcileSellerOrderPartition = {
  id: string;
  sellerId: string;
  merchandiseSubtotal: number;
  discountAllocated: number;
  shippingFee: number;
  total: number;
};

export type ReconcileOrderItemPartition = {
  sellerOrderId: string | null;
  /** Nullable — a small number of pre-marketplace historical OrderItem rows
   *  predate this column and are excluded from the N2 partition check below
   *  rather than treated as a "null" seller. */
  sellerId: string | null;
  lineTotal: number;
};

/**
 * Every cross-seller aggregation finding for ONE parent Order. `sellerOrders`
 * and `items` are ALL rows for that order (every SellerOrder, every
 * OrderItem) — this function does the summing itself; callers should not
 * pre-aggregate. Safe for any Order/SellerOrder status, including CANCELLED —
 * these fields are historical snapshots that `createOrderFromCart` writes
 * once and no later action (cancellation, return, settlement) ever mutates
 * (confirmed: cancellation only changes `.status` / `.commissionAmount` /
 * `.settlementClawbackAmount`, never these), so the sum invariants hold
 * unconditionally, exactly like the existing rule E above.
 */
export function evaluateOrderAggregation(
  order: ReconcileOrderTotals,
  sellerOrders: readonly ReconcileSellerOrderPartition[],
  items: readonly ReconcileOrderItemPartition[],
): OrderAggregationFinding[] {
  const out: OrderAggregationFinding[] = [];

  // ── I · Σ SellerOrder.merchandiseSubtotal === Order.subtotal ──────────
  const sumMerch = sellerOrders.reduce((n, s) => n + s.merchandiseSubtotal, 0);
  if (sumMerch !== order.subtotal) {
    out.push({
      rule: "I", level: "FAIL", sellerOrderId: null,
      invariant: "Σ SellerOrder.merchandiseSubtotal ≠ Order.subtotal",
      current: String(sumMerch), expected: String(order.subtotal),
    });
  }

  // ── J · Σ SellerOrder.shippingFee === Order.shippingFee ───────────────
  const sumShip = sellerOrders.reduce((n, s) => n + s.shippingFee, 0);
  if (sumShip !== order.shippingFee) {
    out.push({
      rule: "J", level: "FAIL", sellerOrderId: null,
      invariant: "Σ SellerOrder.shippingFee ≠ Order.shippingFee",
      current: String(sumShip), expected: String(order.shippingFee),
    });
  }

  // ── K · Σ SellerOrder.discountAllocated === Order.discountTotal ───────
  const sumDiscount = sellerOrders.reduce((n, s) => n + s.discountAllocated, 0);
  if (sumDiscount !== order.discountTotal) {
    out.push({
      rule: "K", level: "FAIL", sellerOrderId: null,
      invariant: "Σ SellerOrder.discountAllocated ≠ Order.discountTotal",
      current: String(sumDiscount), expected: String(order.discountTotal),
    });
  }

  // ── L · Σ SellerOrder.total === Order.grandTotal ──────────────────────
  const sumTotal = sellerOrders.reduce((n, s) => n + s.total, 0);
  if (sumTotal !== order.grandTotal) {
    out.push({
      rule: "L", level: "FAIL", sellerOrderId: null,
      invariant: "Σ SellerOrder.total ≠ Order.grandTotal",
      current: String(sumTotal), expected: String(order.grandTotal),
    });
  }

  // ── M · per-SellerOrder: Σ linked OrderItem.lineTotal === merchandiseSubtotal ──
  for (const so of sellerOrders) {
    const itemSum = items
      .filter((i) => i.sellerOrderId === so.id)
      .reduce((n, i) => n + i.lineTotal, 0);
    if (itemSum !== so.merchandiseSubtotal) {
      out.push({
        rule: "M", level: "FAIL", sellerOrderId: so.id,
        invariant: "Σ linked OrderItem.lineTotal ≠ SellerOrder.merchandiseSubtotal",
        current: String(itemSum), expected: String(so.merchandiseSubtotal),
      });
    }
  }

  // ── N · SellerOrder count / distinct-seller partition integrity ──────
  // N1: no duplicate seller partition — the schema's `@@unique([orderId,
  //     sellerId])` should make this unreachable in practice; checked anyway
  //     as an application-level backstop, not a substitute for the constraint.
  const sellerOrderSellerIds = sellerOrders.map((s) => s.sellerId);
  const distinctSellerOrderSellerIds = new Set(sellerOrderSellerIds);
  if (distinctSellerOrderSellerIds.size !== sellerOrders.length) {
    out.push({
      rule: "N", level: "FAIL", sellerOrderId: null,
      invariant: "duplicate seller partition — more than one SellerOrder for the same sellerId",
      current: `${sellerOrders.length} SellerOrder(s), ${distinctSellerOrderSellerIds.size} distinct sellerId(s)`,
      expected: "one SellerOrder per distinct sellerId",
    });
  }
  // N2: every seller with items has a partition, and every partition has items
  //     — a missing partition (an item's seller has no SellerOrder) or an
  //     unexpected extra one (a SellerOrder with no linked items) are both
  //     reported, distinguished by direction. A null `OrderItem.sellerId`
  //     (pre-marketplace legacy rows) is excluded, never treated as a
  //     distinct "seller."
  const itemSellerIds = new Set(
    items.map((i) => i.sellerId).filter((id): id is string => id !== null),
  );
  const missingPartitions = [...itemSellerIds].filter((id) => !distinctSellerOrderSellerIds.has(id));
  const extraPartitions = [...distinctSellerOrderSellerIds].filter((id) => !itemSellerIds.has(id));
  if (missingPartitions.length > 0) {
    out.push({
      rule: "N", level: "FAIL", sellerOrderId: null,
      invariant: "missing seller partition — an OrderItem's seller has no SellerOrder",
      current: `sellerId(s) ${missingPartitions.join(", ")} have items but no SellerOrder`,
      expected: "every distinct item sellerId has exactly one SellerOrder",
    });
  }
  if (extraPartitions.length > 0) {
    out.push({
      rule: "N", level: "FAIL", sellerOrderId: null,
      invariant: "unexpected extra SellerOrder — no OrderItem links to it",
      current: `sellerId(s) ${extraPartitions.join(", ")} have a SellerOrder but no items`,
      expected: "every SellerOrder has at least one linked OrderItem",
    });
  }

  return out;
}
