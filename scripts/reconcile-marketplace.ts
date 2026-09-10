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
