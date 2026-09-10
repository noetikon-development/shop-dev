/**
 * Phase 9F-44B — marketplace Order / SellerOrder / settlement / commission
 * state-drift reconciliation. READ-ONLY.
 *
 * Complements `reconcile-9e3d.ts` (the inventory authority). This script never
 * recomputes inventory — for OfferInventory / OfferAdjustment integrity it defers
 * to `npm run reconcile:9e3d` and only extends that chain check to the
 * THIRD_PARTY offers 9e3d does not cover.
 *
 * The per-(Order, SellerOrder) rules live in `src/lib/marketplace/state-reconcile.ts`
 * (pure, shared with `scripts/test-9f44b.ts`):
 *   A  parent Order.status = CANCELLED  ⟹  every SellerOrder.status = CANCELLED
 *   B  a SellerOrder is neither ahead of nor behind its parent's fulfilment rank
 *      (sanctioned: 3P PROCESSING parent + SellerOrder PENDING_PAYMENT = awaiting
 *      seller acceptance; SHIPPED/OFD parent + SellerOrder DELIVERED = seller
 *      confirmed delivery first)
 *   C  settlementStatus / settlementId / settlementClawbackAmount form a valid combo
 *   D  commissionAmount = roundHalfUp(merchandiseSubtotal × commissionRate / 10000)
 *   E  SellerOrder.total = merchandiseSubtotal − discountAllocated + shippingFee
 *   F  Σ applicable ReturnItem.refundAmount ≤ SellerOrder.total
 *   G  3P OfferInventory opening + Σ OfferAdjustment.delta == quantity
 *   H  shipping-integration foundation (9F-47B): a non-MANUAL Shipment has an
 *      externalShipmentId; every ShipmentEvent norm/lifecycle status is known;
 *      no Shipment lags a PROCESSED DELIVERED event. Manual shipments (provider
 *      NULL / "MANUAL") are exempt — this rule passes cleanly today (0 events).
 *
 * Output: [PASS] / [WARN] / [FAIL] with order number, seller-order id, the
 * invariant, current value(s) and expected value(s). Exit code is non-zero ONLY
 * for a true FAIL. There are NO grandfathered exceptions — the two historical
 * anomalies (`AX-260904-100255`, `AX-260902-100023`) were repaired by 9F-44D
 * (docs/marketplace-drift-fix-9f44b.md); a recurrence of either now FAILs like
 * any other drift.
 *
 *   node --env-file=.env --import tsx scripts/reconcile-marketplace.ts
 */
import { PrismaClient } from "@prisma/client";
import {
  evaluateSellerOrder,
  RETURN_VALUE_STATUSES_44B,
  type ConsistencyFinding,
} from "../src/lib/marketplace/state-reconcile";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

/**
 * 9F-44D applied the one-time repair (docs/marketplace-drift-fix-9f44b.md) —
 * AX-260904-100255 and AX-260902-100023 are now consistent. There are NO
 * grandfathered exceptions: every finding a rule raises is a TRUE FAIL, and a
 * recurrence of either historical drift FAILs like any other. Do not add back a
 * demote-to-WARN list.
 */

let pass = 0;
let warn = 0;
let fail = 0;

function emit(orderNumber: string, soId: string | null, f: ConsistencyFinding) {
  const where = soId ? `${orderNumber} · SO ${soId}` : orderNumber;
  const line = `  [${f.level}] ${where} · ${f.rule} ${f.invariant}\n         current: ${f.current}  |  expected: ${f.expected}`;
  if (f.level === "FAIL") { fail++; console.error(line); }
  else { warn++; console.warn(line); }
}

async function run() {
  console.log("PHASE 9F-44B — marketplace state-drift reconciliation (READ-ONLY)\n");

  const orders = await prisma.order.findMany({
    orderBy: { placedAt: "asc" },
    select: {
      orderNumber: true,
      status: true,
      sellerOrders: {
        select: {
          id: true,
          sellerType: true,
          status: true,
          settlementStatus: true,
          settlementId: true,
          settlementClawbackAmount: true,
          merchandiseSubtotal: true,
          discountAllocated: true,
          shippingFee: true,
          commissionRate: true,
          commissionAmount: true,
          total: true,
        },
      },
      returnRequests: {
        select: {
          status: true,
          items: { select: { refundAmount: true, orderItem: { select: { sellerOrderId: true } } } },
        },
      },
    },
  });

  const perRule: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 };
  let sellerOrderCount = 0;

  for (const o of orders) {
    const returnedBySo = new Map<string, number>();
    for (const r of o.returnRequests) {
      if (!RETURN_VALUE_STATUSES_44B.has(r.status)) continue;
      for (const it of r.items) {
        const soId = it.orderItem?.sellerOrderId;
        if (!soId) continue;
        returnedBySo.set(soId, (returnedBySo.get(soId) ?? 0) + it.refundAmount);
      }
    }
    const sole = o.sellerOrders.length === 1;

    for (const so of o.sellerOrders) {
      sellerOrderCount++;
      const findings = evaluateSellerOrder(
        { orderNumber: o.orderNumber, status: o.status },
        so,
        returnedBySo.get(so.id) ?? 0,
        sole,
      );
      const rulesHit = new Set(findings.map((f) => f.rule));
      for (const rule of ["A", "B", "C", "D", "E", "F"]) if (!rulesHit.has(rule as ConsistencyFinding["rule"])) perRule[rule]++;
      for (const f of findings) emit(o.orderNumber, so.id, f);
    }
  }

  console.log("");
  console.log(`  scanned ${sellerOrderCount} SellerOrder(s) across ${orders.length} order(s)`);
  console.log(`  A parent-cancellation consistency         — ${perRule.A} clean`);
  console.log(`  B forward-rank consistency                — ${perRule.B} clean`);
  console.log(`  C settlement-combo integrity              — ${perRule.C} clean`);
  console.log(`  D commission = roundHalfUp(merch×rate/1e4) — ${perRule.D} clean`);
  console.log(`  E total = merch − disc + ship             — ${perRule.E} clean`);
  console.log(`  F return refund ≤ SellerOrder.total       — ${perRule.F} clean`);
  pass += perRule.A + perRule.B + perRule.C + perRule.D + perRule.E + perRule.F;

  // ── G · 3P OfferInventory chain (extends reconcile:9e3d, not a competing calc) ─
  console.log("\n  G · THIRD_PARTY OfferInventory chain (inventory authority = reconcile:9e3d; this only extends it to 3P):");
  const tpInv = await prisma.offerInventory.findMany({
    where: { offer: { seller: { type: "THIRD_PARTY" } } },
    select: {
      quantity: true,
      reserved: true,
      offer: { select: { id: true, sellerSku: true } },
      adjustments: { select: { previousQuantity: true, delta: true, reason: true } },
    },
  });
  if (tpInv.length === 0) console.log("    (no THIRD_PARTY OfferInventory rows)");
  for (const oi of tpInv) {
    const opening = oi.adjustments.find((a) => a.reason === "MIGRATION_OPENING")?.previousQuantity ?? 0;
    const sumDelta = oi.adjustments.reduce((n, a) => n + a.delta, 0);
    const reconstructed = opening + sumDelta;
    const label = oi.offer.sellerSku ?? oi.offer.id;
    if (reconstructed === oi.quantity && oi.quantity >= 0 && oi.reserved >= 0) {
      pass++;
      console.log(`    [PASS] offer ${label}: opening ${opening} + Σδ ${sumDelta} == quantity ${oi.quantity}`);
    } else {
      fail++;
      console.error(`    [FAIL] offer ${label} OfferAdjustment chain: opening ${opening} + Σδ ${sumDelta} = ${reconstructed}, quantity ${oi.quantity}, reserved ${oi.reserved}`);
    }
  }

  // ── H · shipping-integration foundation (9F-47B) — READ-ONLY ──────────────
  //   H1  a Shipment with a non-MANUAL `provider` carries an `externalShipmentId`
  //       (manual shipments — provider NULL / "MANUAL" — are exempt, unchanged)
  //   H2  every ShipmentEvent's normStatus is one of the 5 known values and its
  //       status is one of the 4 lifecycle values
  //   H3  no Shipment sits behind a PROCESSED "DELIVERED" ShipmentEvent
  //       (would be a stale-webhook drift once the 9F-47E handler ships)
  console.log("\n  H · shipping-integration foundation (9F-47B — dormant until 9F-47E):");
  const NORM_OK = new Set(["PENDING", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "EXCEPTION"]);
  const EVT_STATUS_OK = new Set(["RECEIVED", "PROCESSED", "IGNORED", "FAILED"]);
  const shipments = await prisma.shipment.findMany({
    select: {
      id: true,
      status: true,
      provider: true,
      externalShipmentId: true,
      shipmentEvents: { select: { normStatus: true, status: true, occurredAt: true } },
    },
  });
  const integrated = shipments.filter((s) => s.provider && s.provider !== "MANUAL");
  const manual = shipments.length - integrated.length;
  let hClean = true;
  for (const s of integrated) {
    if (!s.externalShipmentId) {
      fail++; hClean = false;
      console.error(`    [FAIL] shipment ${s.id}: provider ${s.provider} but no externalShipmentId`);
    }
  }
  let evtCount = 0;
  for (const s of shipments) {
    for (const e of s.shipmentEvents) {
      evtCount++;
      if (!NORM_OK.has(e.normStatus) || !EVT_STATUS_OK.has(e.status)) {
        fail++; hClean = false;
        console.error(`    [FAIL] shipment ${s.id}: ShipmentEvent normStatus=${e.normStatus} status=${e.status} (unknown value)`);
      }
    }
    const delivered = s.shipmentEvents.some((e) => e.status === "PROCESSED" && e.normStatus === "DELIVERED");
    if (delivered && s.status !== "DELIVERED") {
      fail++; hClean = false;
      console.error(`    [FAIL] shipment ${s.id}: PROCESSED DELIVERED ShipmentEvent but Shipment.status=${s.status}`);
    }
  }
  // Rule H is a single foundational check — it does NOT add to the `pass` tally
  // (keeps the headline count stable); a violation still increments `fail` and
  // sets a non-zero exit, exactly like every other rule.
  if (hClean) {
    console.log(`    [PASS] ${shipments.length} shipment(s): ${manual} manual (exempt), ${integrated.length} integrated, ${evtCount} ShipmentEvent(s) — all consistent`);
  }

  console.log(`\n  ${pass} pass · ${warn} warn · ${fail} fail`);
  if (fail > 0) {
    console.error("\nMARKETPLACE RECONCILIATION FAILED — real state drift detected.");
    process.exitCode = 1;
  } else if (warn > 0) {
    console.warn("\nMARKETPLACE RECONCILIATION PASSED WITH WARNINGS — review the WARN lines above.");
  } else {
    console.log("\nMARKETPLACE RECONCILIATION PASSED — every Order / SellerOrder / settlement / commission invariant holds.");
  }
}

run().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
