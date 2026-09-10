/**
 * Phase 9F-44B — marketplace state-drift reconciliation + guardrail.
 *
 *  - Rule tests (A–L): the pure `evaluateSellerOrder` against hand-built
 *    fixtures — no DB.
 *  - Live-dataset test (M): the current production Order/SellerOrder rows must
 *    reconcile except the two explicitly grandfathered historical anomalies.
 *  - Guardrail: every server action that drives `Order.status` FORWARD also
 *    invokes `cascadeSellerOrderFromParent` (or is a documented exemption), so a
 *    future path cannot silently recreate `Order CANCELLED + SellerOrder
 *    PENDING_PAYMENT` / forward-drift.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f44b.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  evaluateSellerOrder,
  type ReconcileOrder,
  type ReconcileSellerOrder,
} from "../src/lib/marketplace/state-reconcile";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const GRANDFATHERED = new Set(["AX-260904-100255", "AX-260902-100023"]);

const baseSo = (o: Partial<ReconcileSellerOrder> = {}): ReconcileSellerOrder => ({
  id: "so-fixture",
  sellerType: "THIRD_PARTY",
  status: "DELIVERED",
  settlementStatus: "PENDING_CAPTURE",
  settlementId: null,
  settlementClawbackAmount: 0,
  merchandiseSubtotal: 100000,
  discountAllocated: 0,
  shippingFee: 15000,
  commissionRate: 1500,
  commissionAmount: 15000,
  total: 115000,
  ...o,
});
const ord = (status: string): ReconcileOrder => ({ orderNumber: "AX-FIXTURE", status });
const hits = (fs: ReturnType<typeof evaluateSellerOrder>, rule: string) => fs.filter((f) => f.rule === rule);

// ---------------------------------------------------------------------------
// Rule tests (no DB)
// ---------------------------------------------------------------------------

function ruleTests() {
  console.log("Rule fixtures (pure)");

  // A — CANCELLED parent + non-cancelled SellerOrder => detected
  ok("A · CANCELLED parent + PENDING_PAYMENT SellerOrder → FAIL",
    hits(evaluateSellerOrder(ord("CANCELLED"), baseSo({ status: "PENDING_PAYMENT" }), 0, true), "A").some((f) => f.level === "FAIL"));

  // B — CANCELLED parent + CANCELLED SellerOrder => pass
  ok("B · CANCELLED parent + CANCELLED SellerOrder → no finding",
    evaluateSellerOrder(ord("CANCELLED"), baseSo({ status: "CANCELLED" }), 0, true).length === 0);

  // C — legit: Order PROCESSING + SellerOrder PENDING_PAYMENT for 3P => pass
  ok("C · 3P PROCESSING parent + PENDING_PAYMENT SellerOrder (awaiting acceptance) → no B finding",
    hits(evaluateSellerOrder(ord("PROCESSING"), baseSo({ sellerType: "THIRD_PARTY", status: "PENDING_PAYMENT", commissionAmount: 15000 }), 0, true), "B").length === 0);
  ok("C · but a 1P PROCESSING parent + PENDING_PAYMENT shadow → B FAIL",
    hits(evaluateSellerOrder(ord("PROCESSING"), baseSo({ sellerType: "FIRST_PARTY", status: "PENDING_PAYMENT", commissionRate: 0, commissionAmount: 0 }), 0, true), "B").some((f) => f.level === "FAIL"));

  // D — legit: Order OUT_FOR_DELIVERY + SellerOrder SHIPPED => pass
  ok("D · OUT_FOR_DELIVERY parent + SHIPPED SellerOrder → no B finding",
    hits(evaluateSellerOrder(ord("OUT_FOR_DELIVERY"), baseSo({ status: "SHIPPED" }), 0, true), "B").length === 0);
  ok("D · SHIPPED parent + DELIVERED SellerOrder (seller confirmed first) → no B finding",
    hits(evaluateSellerOrder(ord("SHIPPED"), baseSo({ status: "DELIVERED" }), 0, true), "B").length === 0);

  // E — impossible forward-drift combination => detected
  ok("E · PROCESSING parent + SHIPPED SellerOrder (ahead) → B FAIL",
    hits(evaluateSellerOrder(ord("PROCESSING"), baseSo({ status: "SHIPPED" }), 0, true), "B").some((f) => f.level === "FAIL" && /ahead/.test(f.invariant)));
  ok("E · DELIVERED parent + SHIPPED SellerOrder (behind, cascade missed) → B FAIL",
    hits(evaluateSellerOrder(ord("DELIVERED"), baseSo({ status: "SHIPPED" }), 0, true), "B").some((f) => f.level === "FAIL" && /behind/.test(f.invariant)));

  // F — PENDING_CAPTURE + settlementId => detected
  ok("F · PENDING_CAPTURE + a settlementId → C FAIL",
    hits(evaluateSellerOrder(ord("DELIVERED"), baseSo({ settlementStatus: "PENDING_CAPTURE", settlementId: "st-1" }), 0, true), "C").some((f) => f.level === "FAIL"));

  // G — SETTLED + null settlementId => detected
  ok("G · SETTLED + null settlementId → C FAIL",
    hits(evaluateSellerOrder(ord("DELIVERED"), baseSo({ settlementStatus: "SETTLED", settlementId: null }), 0, true), "C").some((f) => f.level === "FAIL"));

  // H — valid CLAWED_BACK combinations => pass
  ok("H · CLAWED_BACK + settlementId + amount 0 (reconciled) → no C finding",
    hits(evaluateSellerOrder(ord("DELIVERED"), baseSo({ status: "CANCELLED", settlementStatus: "CLAWED_BACK", settlementId: "st-1", settlementClawbackAmount: 0 }), 0, true), "C").length === 0);
  ok("H · CLAWED_BACK + settlementId + amount > 0 (accrued) → no C finding",
    hits(evaluateSellerOrder(ord("DELIVERED"), baseSo({ status: "CANCELLED", settlementStatus: "CLAWED_BACK", settlementId: "st-1", settlementClawbackAmount: 4250 }), 0, true), "C").length === 0);
  ok("H · CLAWED_BACK + NO settlementId → C FAIL",
    hits(evaluateSellerOrder(ord("DELIVERED"), baseSo({ status: "CANCELLED", settlementStatus: "CLAWED_BACK", settlementId: null, settlementClawbackAmount: 4250 }), 0, true), "C").some((f) => f.level === "FAIL"));

  // I — invalid negative clawback => detected
  ok("I · negative settlementClawbackAmount → C FAIL",
    hits(evaluateSellerOrder(ord("DELIVERED"), baseSo({ settlementClawbackAmount: -1 }), 0, true), "C").some((f) => f.level === "FAIL"));

  // J — commission mismatch => detected
  ok("J · commissionAmount ≠ roundHalfUp(merch×rate/1e4) → D FAIL",
    hits(evaluateSellerOrder(ord("DELIVERED"), baseSo({ merchandiseSubtotal: 119900, commissionRate: 1500, commissionAmount: 999 }), 0, true), "D").some((f) => f.level === "FAIL"));
  ok("J · exact commission (17985 for 119900@1500) → no D finding",
    hits(evaluateSellerOrder(ord("DELIVERED"), baseSo({ merchandiseSubtotal: 119900, commissionRate: 1500, commissionAmount: 17985, total: 134900, shippingFee: 15000 }), 0, true), "D").length === 0);
  ok("J · commission BELOW formula with a value-bearing return → D WARN not FAIL",
    hits(evaluateSellerOrder(ord("DELIVERED"), baseSo({ merchandiseSubtotal: 119900, commissionRate: 1500, commissionAmount: 17235, total: 134900, shippingFee: 15000 }), 5000, true), "D").every((f) => f.level === "WARN"));

  // K — SellerOrder total mismatch => detected
  ok("K · total ≠ merch − disc + ship → E FAIL",
    hits(evaluateSellerOrder(ord("DELIVERED"), baseSo({ merchandiseSubtotal: 100000, discountAllocated: 0, shippingFee: 15000, total: 999 }), 0, true), "E").some((f) => f.level === "FAIL"));
  ok("K · total == merch − disc + ship → no E finding",
    hits(evaluateSellerOrder(ord("DELIVERED"), baseSo({ merchandiseSubtotal: 100000, discountAllocated: 5000, shippingFee: 15000, total: 110000 }), 0, true), "E").length === 0);

  // L — Return refund amount > SellerOrder.total => detected
  ok("L · Σ returned value > SellerOrder.total → F FAIL",
    hits(evaluateSellerOrder(ord("DELIVERED"), baseSo({ total: 115000 }), 200000, true), "F").some((f) => f.level === "FAIL"));
  ok("L · Σ returned value ≤ SellerOrder.total → no F finding",
    hits(evaluateSellerOrder(ord("DELIVERED"), baseSo({ total: 115000 }), 40000, true), "F").length === 0);

  // extra — a fully clean 3P delivered order produces zero findings
  ok("clean · 3P DELIVERED/DELIVERED, exact commission, reconciling total → zero findings",
    evaluateSellerOrder(ord("DELIVERED"), baseSo({ merchandiseSubtotal: 119900, commissionRate: 1500, commissionAmount: 17985, shippingFee: 15000, total: 134900 }), 0, true).length === 0);
}

// ---------------------------------------------------------------------------
// Guardrail — every forward Order.status mutation cascades
// ---------------------------------------------------------------------------

function guardrailTests() {
  console.log("\nGuardrail — Order.status forward mutations invoke cascadeSellerOrderFromParent");

  const orderActions = read("src/lib/admin/order-actions.ts");
  const fulfilment = read("src/lib/admin/fulfillment-actions.ts");
  const checkout = read("src/lib/checkout.ts");
  const webhook = read("src/lib/payments/webhook.ts");
  const codPayments = read("src/lib/admin/payments.ts");
  const cancellation = read("src/lib/orders/cancellation.ts");
  const sellerRepo = read("src/lib/marketplace/seller-order-repository.ts");

  // Forward transition actions that MUST cascade.
  ok("updateOrderStatusAction (→ PROCESSING) cascades",
    /updateOrderStatusAction[\s\S]{0,3000}to === "PROCESSING"[\s\S]{0,300}cascadeSellerOrderFromParent\(\{[\s\S]{0,160}parentStatus: "PROCESSING"/.test(orderActions));
  ok("confirmOrderAction (PENDING_PAYMENT → PROCESSING) cascades",
    /confirmOrderAction[\s\S]{0,4000}cascadeSellerOrderFromParent\(\{[\s\S]{0,160}parentStatus: "PROCESSING"/.test(orderActions));
  ok("markShippedAction (→ SHIPPED) cascades",
    /markShippedAction[\s\S]{0,3000}cascadeSellerOrderFromParent\(\{[\s\S]{0,160}parentStatus: "SHIPPED"/.test(fulfilment));
  ok("markOutForDeliveryAction (→ OUT_FOR_DELIVERY) cascades",
    /markOutForDeliveryAction[\s\S]{0,3000}cascadeSellerOrderFromParent\(\{[\s\S]{0,180}parentStatus: "OUT_FOR_DELIVERY"/.test(fulfilment));
  ok("markDeliveredAction (→ DELIVERED) cascades",
    /markDeliveredAction[\s\S]{0,3000}cascadeSellerOrderFromParent\(\{[\s\S]{0,160}parentStatus: "DELIVERED"/.test(fulfilment));

  // Cancellation paths run the DEDICATED cancellation→SellerOrder cascade.
  ok("cancelOrderAction cancels every non-CANCELLED SellerOrder (dedicated cascade)",
    /sellerOrder\.findMany\(\{\s*where: \{ orderId, status: \{ not: "CANCELLED" \}/.test(orderActions) &&
      /data: \{ status: "CANCELLED", updatedAt: new Date\(\), commissionAmount: 0 \}/.test(orderActions));
  ok("orders/cancellation.ts reverseCancelledOrder cascades SellerOrders → CANCELLED",
    /where: \{ orderId, status: \{ not: "CANCELLED" \} \}/.test(cancellation) &&
      /data: \{ status: "CANCELLED", updatedAt: new Date\(\), commissionAmount: 0 \}/.test(cancellation));
  ok("account/order-actions.ts customer self-cancel routes through reverseCancelledOrder",
    /reverseCancelledOrder\(/.test(read("src/lib/account/order-actions.ts")));
  ok("seller-order-repository sellerCancelSellerOrder cascades parent + SellerOrder",
    /status: "CANCELLED", commissionAmount: 0, updatedAt: new Date\(\)/.test(sellerRepo) && /UPDATE "Order" SET "status" = 'CANCELLED'/.test(sellerRepo));

  // Documented exemptions — a forward Order.status write that legitimately does
  // NOT cascade. Each is asserted so a future reviewer sees the list is closed.
  ok("EXEMPT · checkout.ts creates a 3P order at PROCESSING with SellerOrder PENDING_PAYMENT by design (seller must Accept)",
    /status: autoConfirmParent \? "PROCESSING" : "PENDING_PAYMENT"/.test(checkout) && /9F-33A invariant/.test(checkout));
  ok("EXEMPT · seller-order-repository rollupParentOrderFromSeller drives parent FROM the seller plane (SellerOrders already ahead)",
    /UPDATE .*Order.*SET .*status.* = .*SHIPPED|status: "SHIPPED"/.test(sellerRepo) && /rollup/i.test(sellerRepo));
  ok("EXEMPT · 9F-43B COD confirm changes paymentStatus only, never Order.status",
    /data: \{ paymentStatus: "PAID", updatedAt: new Date\(\) \}/.test(codPayments) && !/data: \{[^}]*\bstatus: "(PROCESSING|SHIPPED|DELIVERED)"/.test(codPayments));

  // FUTURE-RISK — flagged, not fixed here (dormant path).
  ok("FUTURE-RISK noted · payments/webhook.ts PAID→PROCESSING does NOT cascade (dormant; review when PayMongo activates)",
    /status: "PROCESSING", updatedAt: new Date\(\)/.test(webhook) && !/webhook[\s\S]*cascadeSellerOrderFromParent/.test(webhook));
}

// ---------------------------------------------------------------------------
// M — the live production dataset reconciles (bar the grandfathered anomalies)
// ---------------------------------------------------------------------------

async function liveDatasetTest() {
  console.log("\nLive dataset (read-only)");
  const orders = await prisma.order.findMany({
    select: {
      orderNumber: true, status: true,
      sellerOrders: { select: { id: true, sellerType: true, status: true, settlementStatus: true, settlementId: true, settlementClawbackAmount: true, merchandiseSubtotal: true, discountAllocated: true, shippingFee: true, commissionRate: true, commissionAmount: true, total: true } },
      returnRequests: { select: { status: true, items: { select: { refundAmount: true, orderItem: { select: { sellerOrderId: true } } } } } },
    },
  });

  const RET = new Set(["RECEIVED", "REFUND_INITIATED", "REFUND_COMPLETED"]);
  const realFails: string[] = [];
  const grandfatheredHits: string[] = [];

  for (const o of orders) {
    const returnedBySo = new Map<string, number>();
    for (const r of o.returnRequests) {
      if (!RET.has(r.status)) continue;
      for (const it of r.items) { const s = it.orderItem?.sellerOrderId; if (s) returnedBySo.set(s, (returnedBySo.get(s) ?? 0) + it.refundAmount); }
    }
    for (const so of o.sellerOrders) {
      const findings = evaluateSellerOrder({ orderNumber: o.orderNumber, status: o.status }, so, returnedBySo.get(so.id) ?? 0, o.sellerOrders.length === 1);
      for (const f of findings.filter((x) => x.level === "FAIL")) {
        if (GRANDFATHERED.has(o.orderNumber)) grandfatheredHits.push(`${o.orderNumber} ${f.rule}`);
        else realFails.push(`${o.orderNumber} ${f.rule}: ${f.invariant} — ${f.current}`);
      }
    }
  }

  ok("M · zero NON-grandfathered FAIL findings across all production orders", realFails.length === 0, realFails.join(" | "));
  ok("M · the two grandfathered anomalies are still detected (AX-260904-100255 A, AX-260902-100023 B)",
    grandfatheredHits.some((h) => h.startsWith("AX-260904-100255")) && grandfatheredHits.some((h) => h.startsWith("AX-260902-100023")),
    grandfatheredHits.join(" | "));

  // untouched-real-orders sanity
  const ax348 = await prisma.order.findFirst({ where: { orderNumber: "AX-260907-100348" }, select: { status: true, paymentStatus: true, paymentMethod: true } });
  ok("M · AX-260907-100348 unchanged (DELIVERED / PENDING / NONE)",
    ax348?.status === "DELIVERED" && ax348?.paymentStatus === "PENDING" && ax348?.paymentMethod === "NONE", JSON.stringify(ax348));
  const ax389 = await prisma.sellerOrder.findFirst({ where: { order: { orderNumber: "AX-260907-100389" } }, select: { status: true } });
  ok("M · AX-260907-100389 SellerOrder unchanged (PENDING_PAYMENT)", ax389?.status === "PENDING_PAYMENT", JSON.stringify(ax389));
}

// ---------------------------------------------------------------------------
// N — rolled-back fixture: reconcile detects a fresh CANCELLED-parent drift
// ---------------------------------------------------------------------------

async function rolledBackTest() {
  console.log("\nRolled-back DB fixture");
  class RB extends Error {}
  const orderBefore = await prisma.order.count();
  try {
    await prisma.$transaction(async (tx) => {
      const t = Date.now().toString(36);
      const fp = await tx.seller.findFirstOrThrow({ where: { type: "FIRST_PARTY" }, select: { id: true, displayName: true, supportEmail: true } });
      const order = await tx.order.create({
        data: { orderNumber: `AX-T44B-${t}`, email: "b@e.test", status: "CANCELLED", paymentMethod: "NONE", paymentStatus: "PENDING", subtotal: 100000, grandTotal: 100000, shippingAddress: "{}" },
        select: { id: true, orderNumber: true },
      });
      const so = await tx.sellerOrder.create({
        data: { orderId: order.id, sellerId: fp.id, sellerName: fp.displayName, sellerType: "FIRST_PARTY", supportEmail: fp.supportEmail, commissionRate: 0, merchandiseSubtotal: 100000, discountAllocated: 0, shippingFee: 0, total: 100000, commissionAmount: 0, status: "PENDING_PAYMENT", settlementStatus: "PENDING_CAPTURE" },
        select: { id: true, sellerType: true, status: true, settlementStatus: true, settlementId: true, settlementClawbackAmount: true, merchandiseSubtotal: true, discountAllocated: true, shippingFee: true, commissionRate: true, commissionAmount: true, total: true },
      });
      const findings = evaluateSellerOrder({ orderNumber: order.orderNumber, status: "CANCELLED" }, so as ReconcileSellerOrder, 0, true);
      ok("N · a fresh CANCELLED parent + PENDING_PAYMENT SellerOrder is FLAGGED by the evaluator", findings.some((f) => f.rule === "A" && f.level === "FAIL"));
      // fix it in the tx → clean
      const soFixed = { ...(so as ReconcileSellerOrder), status: "CANCELLED" };
      ok("N · once the SellerOrder is CANCELLED the finding clears", evaluateSellerOrder({ orderNumber: order.orderNumber, status: "CANCELLED" }, soFixed, 0, true).length === 0);
      throw new RB();
    }, { timeout: 60_000, maxWait: 15_000 });
  } catch (e) { if (!(e instanceof RB)) throw e; }
  ok("N · Order count unchanged after rollback", (await prisma.order.count()) === orderBefore);
}

async function main() {
  console.log("\nPHASE 9F-44B — marketplace state-drift reconciliation + guardrail\n");
  ruleTests();
  guardrailTests();
  await liveDatasetTest();
  await rolledBackTest();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
