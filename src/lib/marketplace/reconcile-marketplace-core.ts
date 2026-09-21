/**
 * Phase 9F-44B — marketplace Order / SellerOrder / settlement / commission
 * state-drift reconciliation. READ-ONLY.
 *
 * This is the exact rule set from `scripts/reconcile-marketplace.ts`,
 * extracted so it can be imported both by that CLI script (unchanged
 * behavior) and by `src/lib/marketplace/reconciliation-job.ts` (the
 * scheduled cron path). Nothing about what is checked, how a check is
 * scored, or its severity changed in this extraction — only where the code
 * lives and how its caller obtains a Prisma client. The per-(Order,
 * SellerOrder) and cross-seller aggregation rules themselves still live in
 * `src/lib/marketplace/state-reconcile.ts`, unchanged.
 *
 * See the CLI script's own header comment for the full rule list (A–N, plus
 * G and H below).
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  evaluateSellerOrder,
  evaluateOrderAggregation,
  RETURN_VALUE_STATUSES_44B,
  type ConsistencyFinding,
} from "./state-reconcile";
import type { ReconciliationCheckResult, ReconciliationLine } from "./reconciliation-types";

type Client = Prisma.TransactionClient | PrismaClient;

export async function runMarketplaceReconciliation(prisma: Client): Promise<ReconciliationCheckResult> {
  let pass = 0;
  let warn = 0;
  let fail = 0;
  const lines: ReconciliationLine[] = [];

  function emit(orderNumber: string, soId: string | null, f: ConsistencyFinding) {
    const where = soId ? `${orderNumber} · SO ${soId}` : orderNumber;
    // Exact original console format — two lines, unchanged from the CLI script.
    const consoleLine = `  [${f.level}] ${where} · ${f.rule} ${f.invariant}\n         current: ${f.current}  |  expected: ${f.expected}`;
    // A separate, single-line message for the structured result (email/audit
    // consumers) — this shape is new, so it has no prior console format to match.
    const structuredMessage = `${where} · ${f.rule} ${f.invariant} — current: ${f.current} | expected: ${f.expected}`;
    if (f.level === "FAIL") {
      fail++;
      lines.push({ level: "FAIL", message: structuredMessage });
      console.error(consoleLine);
    } else {
      warn++;
      lines.push({ level: "WARN", message: structuredMessage });
      console.warn(consoleLine);
    }
  }

  console.log("PHASE 9F-44B — marketplace state-drift reconciliation (READ-ONLY)\n");

  const orders = await prisma.order.findMany({
    orderBy: { placedAt: "asc" },
    select: {
      orderNumber: true,
      status: true,
      subtotal: true,
      shippingFee: true,
      discountTotal: true,
      grandTotal: true,
      sellerOrders: {
        select: {
          id: true,
          sellerId: true,
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
      items: {
        select: { sellerOrderId: true, sellerId: true, lineTotal: true },
      },
      returnRequests: {
        select: {
          status: true,
          items: { select: { refundAmount: true, orderItem: { select: { sellerOrderId: true } } } },
        },
      },
    },
  });

  const perRule: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0, I: 0, J: 0, K: 0, L: 0, M: 0, N: 0 };
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

    // ── I–N · cross-seller aggregation (Phase C) — once per Order, across
    //     ALL its SellerOrders/OrderItems, not per-(Order, SellerOrder) pair.
    const aggFindings = evaluateOrderAggregation(
      { subtotal: o.subtotal, shippingFee: o.shippingFee, discountTotal: o.discountTotal, grandTotal: o.grandTotal },
      o.sellerOrders,
      o.items,
    );
    const aggRulesHit = new Set(aggFindings.map((f) => f.rule));
    for (const rule of ["I", "J", "K", "L", "M", "N"]) if (!aggRulesHit.has(rule as ConsistencyFinding["rule"])) perRule[rule]++;
    for (const f of aggFindings) emit(o.orderNumber, f.sellerOrderId, f);
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

  console.log("\n  I–N · cross-seller aggregation (Phase C, per Order):");
  console.log(`  I  Σ merchandiseSubtotal == Order.subtotal — ${perRule.I} clean`);
  console.log(`  J  Σ shippingFee == Order.shippingFee     — ${perRule.J} clean`);
  console.log(`  K  Σ discountAllocated == Order.discountTotal — ${perRule.K} clean`);
  console.log(`  L  Σ total == Order.grandTotal            — ${perRule.L} clean`);
  console.log(`  M  Σ OrderItem.lineTotal == SellerOrder.merchandiseSubtotal — ${perRule.M} clean`);
  console.log(`  N  SellerOrder-count / seller-partition integrity — ${perRule.N} clean`);
  pass += perRule.I + perRule.J + perRule.K + perRule.L + perRule.M + perRule.N;

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
      lines.push({ level: "PASS", message: `G · offer ${label}: opening ${opening} + Σδ ${sumDelta} == quantity ${oi.quantity}` });
      console.log(`    [PASS] offer ${label}: opening ${opening} + Σδ ${sumDelta} == quantity ${oi.quantity}`);
    } else {
      fail++;
      const msg = `G · offer ${label} OfferAdjustment chain: opening ${opening} + Σδ ${sumDelta} = ${reconstructed}, quantity ${oi.quantity}, reserved ${oi.reserved}`;
      lines.push({ level: "FAIL", message: msg });
      console.error(`    [FAIL] ${msg}`);
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
      const msg = `H · shipment ${s.id}: provider ${s.provider} but no externalShipmentId`;
      lines.push({ level: "FAIL", message: msg });
      console.error(`    [FAIL] ${msg}`);
    }
  }
  let evtCount = 0;
  for (const s of shipments) {
    for (const e of s.shipmentEvents) {
      evtCount++;
      if (!NORM_OK.has(e.normStatus) || !EVT_STATUS_OK.has(e.status)) {
        fail++; hClean = false;
        const msg = `H · shipment ${s.id}: ShipmentEvent normStatus=${e.normStatus} status=${e.status} (unknown value)`;
        lines.push({ level: "FAIL", message: msg });
        console.error(`    [FAIL] ${msg}`);
      }
    }
    const delivered = s.shipmentEvents.some((e) => e.status === "PROCESSED" && e.normStatus === "DELIVERED");
    if (delivered && s.status !== "DELIVERED") {
      fail++; hClean = false;
      const msg = `H · shipment ${s.id}: PROCESSED DELIVERED ShipmentEvent but Shipment.status=${s.status}`;
      lines.push({ level: "FAIL", message: msg });
      console.error(`    [FAIL] ${msg}`);
    }
  }
  // Rule H is a single foundational check — it does NOT add to the `pass` tally
  // (keeps the headline count stable); a violation still increments `fail`.
  if (hClean) {
    console.log(`    [PASS] ${shipments.length} shipment(s): ${manual} manual (exempt), ${integrated.length} integrated, ${evtCount} ShipmentEvent(s) — all consistent`);
  }

  console.log(`\n  ${pass} pass · ${warn} warn · ${fail} fail`);
  if (fail > 0) {
    console.error("\nMARKETPLACE RECONCILIATION FAILED — real state drift detected.");
  } else if (warn > 0) {
    console.warn("\nMARKETPLACE RECONCILIATION PASSED WITH WARNINGS — review the WARN lines above.");
  } else {
    console.log("\nMARKETPLACE RECONCILIATION PASSED — every Order / SellerOrder / settlement / commission invariant holds.");
  }

  return { name: "marketplace", pass, warn, fail, lines };
}
