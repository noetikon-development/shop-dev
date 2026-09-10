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
  rule: "A" | "B" | "C" | "D" | "E" | "F";
  level: ConsistencyLevel;
  invariant: string;
  current: string;
  expected: string;
};

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
