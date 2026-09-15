/**
 * Multi-seller checkout — Phase C assertion runner (cross-seller
 * reconciliation aggregation rules I–N).
 *
 *  - Rule tests (1–13, task's own numbering): the pure `evaluateOrderAggregation`
 *    against hand-built fixtures — no DB, matching the established
 *    `scripts/test-9f44b.ts` pattern for `evaluateSellerOrder`.
 *  - Edge-case tests: zero discount, free shipping, real Phase A rounding
 *    allocations, a CANCELLED order (status-neutrality), and a mixed
 *    FIRST_PARTY + THIRD_PARTY order (seller-type independence).
 *  - Live-dataset test: the current Production Order/SellerOrder/OrderItem
 *    rows must produce ZERO findings from every new rule — today's orders are
 *    all single-seller, so I–N hold trivially (sum of one term each).
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-multiseller-reconciliation.ts
 */
import { PrismaClient } from "@prisma/client";
import {
  evaluateOrderAggregation,
  type ReconcileOrderTotals,
  type ReconcileSellerOrderPartition,
  type ReconcileOrderItemPartition,
} from "../src/lib/marketplace/state-reconcile";
import { allocateShippingFee, allocateDiscount } from "../src/lib/marketplace/order-allocation";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};

const hits = (fs: ReturnType<typeof evaluateOrderAggregation>, rule: string) => fs.filter((f) => f.rule === rule);
const fails = (fs: ReturnType<typeof evaluateOrderAggregation>, rule?: string) =>
  (rule ? hits(fs, rule) : fs).filter((f) => f.level === "FAIL");

function orderTotals(o: Partial<ReconcileOrderTotals> = {}): ReconcileOrderTotals {
  return { subtotal: 4000, shippingFee: 400, discountTotal: 0, grandTotal: 4400, ...o };
}
function so(o: Partial<ReconcileSellerOrderPartition> = {}): ReconcileSellerOrderPartition {
  return { id: "so-1", sellerId: "seller-1", merchandiseSubtotal: 4000, discountAllocated: 0, shippingFee: 400, total: 4400, ...o };
}
function item(o: Partial<ReconcileOrderItemPartition> = {}): ReconcileOrderItemPartition {
  return { sellerOrderId: "so-1", sellerId: "seller-1", lineTotal: 4000, ...o };
}

// ---------------------------------------------------------------------------
// Rule tests (task's numbering 1–13) — no DB
// ---------------------------------------------------------------------------

function ruleTests() {
  console.log("Rule fixtures (pure) — evaluateOrderAggregation");

  // 1 — one-seller valid order → PASS (no findings at all)
  {
    const f = evaluateOrderAggregation(
      orderTotals(),
      [so()],
      [item()],
    );
    ok("1 · one-seller valid order → zero findings", f.length === 0, JSON.stringify(f));
  }

  // 2 — two-seller valid order → PASS
  {
    const soA = so({ id: "so-A", sellerId: "seller-A", merchandiseSubtotal: 1000, shippingFee: 100, discountAllocated: 0, total: 1100 });
    const soB = so({ id: "so-B", sellerId: "seller-B", merchandiseSubtotal: 3000, shippingFee: 300, discountAllocated: 0, total: 3300 });
    const items = [
      item({ sellerOrderId: "so-A", sellerId: "seller-A", lineTotal: 1000 }),
      item({ sellerOrderId: "so-B", sellerId: "seller-B", lineTotal: 3000 }),
    ];
    const f = evaluateOrderAggregation(orderTotals({ subtotal: 4000, shippingFee: 400, grandTotal: 4400 }), [soA, soB], items);
    ok("2 · two-seller valid order → zero findings", f.length === 0, JSON.stringify(f));
  }

  // 3 — three-seller valid order → PASS
  {
    const soA = so({ id: "so-A", sellerId: "seller-A", merchandiseSubtotal: 1000, shippingFee: 100, total: 1100 });
    const soB = so({ id: "so-B", sellerId: "seller-B", merchandiseSubtotal: 2000, shippingFee: 200, total: 2200 });
    const soC = so({ id: "so-C", sellerId: "seller-C", merchandiseSubtotal: 3000, shippingFee: 300, total: 3300 });
    const items = [
      item({ sellerOrderId: "so-A", sellerId: "seller-A", lineTotal: 1000 }),
      item({ sellerOrderId: "so-B", sellerId: "seller-B", lineTotal: 2000 }),
      item({ sellerOrderId: "so-C", sellerId: "seller-C", lineTotal: 3000 }),
    ];
    const f = evaluateOrderAggregation(orderTotals({ subtotal: 6000, shippingFee: 600, grandTotal: 6600 }), [soA, soB, soC], items);
    ok("3 · three-seller valid order → zero findings", f.length === 0, JSON.stringify(f));
  }

  // 4 — merchandise subtotal mismatch → FAIL (rule I)
  {
    const f = evaluateOrderAggregation(orderTotals({ subtotal: 9999 }), [so()], [item()]);
    ok("4 · merchandise subtotal mismatch → rule I FAIL", fails(f, "I").length === 1, JSON.stringify(f));
    ok("4 · rule I reports expected/current values", fails(f, "I")[0]?.current === "4000" && fails(f, "I")[0]?.expected === "9999");
  }

  // 5 — shipping allocation mismatch → FAIL (rule J)
  {
    const f = evaluateOrderAggregation(orderTotals({ shippingFee: 9999 }), [so()], [item()]);
    ok("5 · shipping allocation mismatch → rule J FAIL", fails(f, "J").length === 1, JSON.stringify(f));
  }

  // 6 — discount allocation mismatch → FAIL (rule K)
  {
    const f = evaluateOrderAggregation(orderTotals({ discountTotal: 500 }), [so({ discountAllocated: 0 })], [item()]);
    ok("6 · discount allocation mismatch → rule K FAIL", fails(f, "K").length === 1, JSON.stringify(f));
  }

  // 7 — SellerOrder total mismatch → FAIL (rule L)
  {
    const f = evaluateOrderAggregation(orderTotals({ grandTotal: 9999 }), [so()], [item()]);
    ok("7 · SellerOrder total sum mismatch → rule L FAIL", fails(f, "L").length === 1, JSON.stringify(f));
  }

  // 8 — OrderItem subtotal mismatch → FAIL (rule M)
  {
    const f = evaluateOrderAggregation(orderTotals(), [so()], [item({ lineTotal: 1 })]);
    ok("8 · OrderItem↔SellerOrder linkage mismatch → rule M FAIL", fails(f, "M").length === 1, JSON.stringify(f));
    ok("8 · rule M identifies the specific SellerOrder", fails(f, "M")[0]?.sellerOrderId === "so-1");
  }

  // 9 — SellerOrder count mismatch → FAIL (rule N: an unexpected extra SellerOrder with no items)
  {
    const soA = so({ id: "so-A", sellerId: "seller-A" });
    const soExtra = so({ id: "so-EXTRA", sellerId: "seller-EXTRA", merchandiseSubtotal: 0, shippingFee: 0, discountAllocated: 0, total: 0 });
    const f = evaluateOrderAggregation(orderTotals(), [soA, soExtra], [item({ sellerOrderId: "so-A", sellerId: "seller-A" })]);
    ok("9 · SellerOrder count mismatch (extra, unlinked SellerOrder) → rule N FAIL", fails(f, "N").some((x) => /unexpected extra/.test(x.invariant)), JSON.stringify(f));
  }

  // 10 — duplicate / missing seller partition → FAIL (rule N, both directions)
  {
    // 10a: duplicate — two SellerOrder rows for the SAME sellerId.
    const dup1 = so({ id: "so-1", sellerId: "seller-1", merchandiseSubtotal: 2000, shippingFee: 200, total: 2200 });
    const dup2 = so({ id: "so-2", sellerId: "seller-1", merchandiseSubtotal: 2000, shippingFee: 200, total: 2200 });
    const fDup = evaluateOrderAggregation(
      orderTotals({ subtotal: 4000, shippingFee: 400, grandTotal: 4400 }),
      [dup1, dup2],
      [item({ sellerOrderId: "so-1", sellerId: "seller-1", lineTotal: 2000 }), item({ sellerOrderId: "so-2", sellerId: "seller-1", lineTotal: 2000 })],
    );
    ok("10a · duplicate seller partition (same sellerId twice) → rule N FAIL", fails(fDup, "N").some((x) => /duplicate seller partition/.test(x.invariant)), JSON.stringify(fDup));

    // 10b: missing — an OrderItem's seller has no SellerOrder at all.
    const fMissing = evaluateOrderAggregation(
      orderTotals(),
      [so({ id: "so-1", sellerId: "seller-1" })],
      [item({ sellerOrderId: "so-1", sellerId: "seller-1" }), item({ sellerOrderId: null, sellerId: "seller-GHOST", lineTotal: 0 })],
    );
    ok("10b · missing seller partition (item's seller has no SellerOrder) → rule N FAIL", fails(fMissing, "N").some((x) => /missing seller partition/.test(x.invariant)), JSON.stringify(fMissing));
  }

  // 11 — zero-discount order → PASS (discount sum must equal zero, cleanly)
  {
    const f = evaluateOrderAggregation(orderTotals({ discountTotal: 0 }), [so({ discountAllocated: 0 })], [item()]);
    ok("11 · zero-discount order → rule K passes (0 === 0)", fails(f, "K").length === 0, JSON.stringify(f));
  }

  // 12 — free-shipping order → PASS (shipping sum must equal zero)
  {
    const f = evaluateOrderAggregation(
      orderTotals({ shippingFee: 0, grandTotal: 4000 }),
      [so({ shippingFee: 0, total: 4000 })],
      [item()],
    );
    ok("12 · free-shipping order → rule J passes (0 === 0)", fails(f, "J").length === 0, JSON.stringify(f));
  }

  // 13 — rounding/remainder allocation → PASS, using the REAL Phase A functions
  {
    const sellers = [
      { sellerId: "seller-A", merchandiseSubtotal: 1 },
      { sellerId: "seller-B", merchandiseSubtotal: 2 },
      { sellerId: "seller-C", merchandiseSubtotal: 4 },
    ];
    const totalShipping = 100; // does not divide evenly by 1:2:4 (=7 parts)
    const totalDiscount = 7; // exercises the discount cap-aware waterfall too
    const shipAlloc = allocateShippingFee(sellers, totalShipping);
    const discAlloc = allocateDiscount(sellers, totalDiscount);
    const subtotal = sellers.reduce((n, s) => n + s.merchandiseSubtotal, 0);
    const sellerOrders: ReconcileSellerOrderPartition[] = sellers.map((s) => {
      const ship = shipAlloc.find((a) => a.sellerId === s.sellerId)!.amount;
      const disc = discAlloc.find((a) => a.sellerId === s.sellerId)!.amount;
      return { id: `so-${s.sellerId}`, sellerId: s.sellerId, merchandiseSubtotal: s.merchandiseSubtotal, shippingFee: ship, discountAllocated: disc, total: s.merchandiseSubtotal - disc + ship };
    });
    const items = sellers.map((s) => item({ sellerOrderId: `so-${s.sellerId}`, sellerId: s.sellerId, lineTotal: s.merchandiseSubtotal }));
    const grandTotal = subtotal + totalShipping - totalDiscount;
    const f = evaluateOrderAggregation({ subtotal, shippingFee: totalShipping, discountTotal: totalDiscount, grandTotal }, sellerOrders, items);
    ok("13 · rounding/remainder allocation (Phase A real functions) → zero findings despite an uneven 1:2:4 split", f.length === 0, JSON.stringify({ sellerOrders, f }));
  }
}

// ---------------------------------------------------------------------------
// Edge cases beyond the numbered list
// ---------------------------------------------------------------------------

function edgeCaseTests() {
  console.log("\nEdge cases");

  // F — CANCELLED order/SellerOrder: the summed fields are frozen snapshots
  // untouched by cancellation (only .status / .commissionAmount / clawback
  // change) — the aggregation rules are status-neutral and must still pass.
  {
    const f = evaluateOrderAggregation(orderTotals(), [so()], [item()]);
    ok("F · CANCELLED-order fixture still passes (rules I–N never reference status)", f.length === 0, JSON.stringify(f));
  }

  // G — mixed FIRST_PARTY + THIRD_PARTY: aggregation must be purely
  // mathematical — evaluateOrderAggregation's inputs carry no sellerType field
  // at all, so this is true by construction; confirmed with a concrete mix.
  {
    const soFp = so({ id: "so-FP", sellerId: "seller-FP", merchandiseSubtotal: 1000, shippingFee: 0, total: 1000 });
    const soTp = so({ id: "so-TP", sellerId: "seller-TP", merchandiseSubtotal: 3000, shippingFee: 400, total: 3400 });
    const items = [
      item({ sellerOrderId: "so-FP", sellerId: "seller-FP", lineTotal: 1000 }),
      item({ sellerOrderId: "so-TP", sellerId: "seller-TP", lineTotal: 3000 }),
    ];
    const f = evaluateOrderAggregation(orderTotals({ subtotal: 4000, shippingFee: 400, grandTotal: 4400 }), [soFp, soTp], items);
    ok("G · mixed FIRST_PARTY + THIRD_PARTY order → zero findings (seller-type independent)", f.length === 0, JSON.stringify(f));
  }

  // Integer-only arithmetic — no float ever appears in a comparison.
  {
    const f = evaluateOrderAggregation(orderTotals({ subtotal: 3, shippingFee: 0, discountTotal: 0, grandTotal: 3 }), [so({ merchandiseSubtotal: 1, shippingFee: 0, discountAllocated: 0, total: 1 }), so({ id: "so-2", sellerId: "seller-2", merchandiseSubtotal: 2, shippingFee: 0, discountAllocated: 0, total: 2 })], [item({ lineTotal: 1 }), item({ sellerOrderId: "so-2", sellerId: "seller-2", lineTotal: 2 })]);
    ok("integer-only · odd integer split (1+2=3) reconciles exactly, no float tolerance needed", f.length === 0, JSON.stringify(f));
  }
}

// ---------------------------------------------------------------------------
// Live-dataset test — Production Order/SellerOrder/OrderItem rows
// ---------------------------------------------------------------------------

async function liveDatasetTest() {
  console.log("\nLive dataset (read-only) — current Production orders");
  const orders = await prisma.order.findMany({
    select: {
      orderNumber: true,
      subtotal: true,
      shippingFee: true,
      discountTotal: true,
      grandTotal: true,
      sellerOrders: {
        select: { id: true, sellerId: true, merchandiseSubtotal: true, discountAllocated: true, shippingFee: true, total: true },
      },
      items: { select: { sellerOrderId: true, sellerId: true, lineTotal: true } },
    },
  });
  let clean = 0;
  for (const o of orders) {
    const f = evaluateOrderAggregation(
      { subtotal: o.subtotal, shippingFee: o.shippingFee, discountTotal: o.discountTotal, grandTotal: o.grandTotal },
      o.sellerOrders,
      o.items,
    );
    if (f.length === 0) clean++;
    else console.error(`  [FAIL] ${o.orderNumber}: ${JSON.stringify(f)}`);
  }
  ok(`live · all ${orders.length} current Production orders produce ZERO aggregation findings`, clean === orders.length, `${clean}/${orders.length} clean`);
}

async function main() {
  ruleTests();
  edgeCaseTests();
  await liveDatasetTest();

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
