/**
 * Phase 9F-44B — marketplace Order / SellerOrder / settlement / commission
 * state-drift reconciliation. READ-ONLY.
 *
 * The rule set now lives in `src/lib/marketplace/reconcile-marketplace-core.ts`
 * (shared with the scheduled `/api/cron/reconciliation` job) — this script is
 * a thin CLI wrapper: same console output, same exit-code behavior as before
 * this extraction. The per-(Order, SellerOrder) and cross-seller aggregation
 * rules themselves still live in `src/lib/marketplace/state-reconcile.ts`,
 * unchanged.
 *
 * Complements `reconcile-9e3d.ts` (the inventory authority). This script never
 * recomputes inventory — for OfferInventory / OfferAdjustment integrity it defers
 * to `npm run reconcile:9e3d` and only extends that chain check to the
 * THIRD_PARTY offers 9e3d does not cover.
 *
 * Rules (see `reconcile-marketplace-core.ts` / `state-reconcile.ts` for detail):
 *   A  parent Order.status = CANCELLED  ⟹  every SellerOrder.status = CANCELLED
 *   B  a SellerOrder is neither ahead of nor behind its parent's fulfilment rank
 *   C  settlementStatus / settlementId / settlementClawbackAmount form a valid combo
 *   D  commissionAmount = roundHalfUp(merchandiseSubtotal × commissionRate / 10000)
 *   E  SellerOrder.total = merchandiseSubtotal − discountAllocated + shippingFee
 *   F  Σ applicable ReturnItem.refundAmount ≤ SellerOrder.total
 *   G  3P OfferInventory opening + Σ OfferAdjustment.delta == quantity
 *   H  shipping-integration foundation (9F-47B)
 *   I–N cross-seller aggregation (Phase C) — see the core module's header.
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
import { runMarketplaceReconciliation } from "../src/lib/marketplace/reconcile-marketplace-core";
import {
  startReconciliationRun,
  completeReconciliationRun,
  failReconciliationRun,
} from "../src/lib/marketplace/reconciliation-run";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

// Execution-record tracking only — reconciliation logic/output/exit-code
// below is otherwise byte-identical to before this was added. This is a
// single-check CLI run, so its ReconciliationRun status reflects only THIS
// check's own pass/warn/fail (not the combined payments+marketplace status
// the scheduled job records).
async function main() {
  const runId = await startReconciliationRun("MANUAL", prisma);
  try {
    const result = await runMarketplaceReconciliation(prisma);
    await completeReconciliationRun(runId, result.fail > 0 ? "FAIL" : result.warn > 0 ? "WARN" : "PASS", prisma);
    if (result.fail > 0) process.exitCode = 1;
  } catch (e) {
    await failReconciliationRun(runId, e, prisma);
    console.error(e);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();
