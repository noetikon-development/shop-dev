/**
 * Phase 9F-42B — minimum-safe 3P settlement fix.
 *
 *   P1-A  settlement eligibility now also requires Order.paymentStatus = "PAID"
 *   P1-B/C returned-before-settlement merchandise value is deducted from the
 *          settlement receivable (SellerOrder.total stays frozen)
 *   P2-B  clawbacks + a prior carried-forward balance that exceed the
 *          receivable floor netAmount at 0 and carry the residual forward
 *
 * DB tests build THIRD_PARTY sellers + DELIVERED SellerOrders (offer-bound) +
 * ReturnRequests inside ONE prisma.$transaction and roll back. Nothing is
 * written to production. The real production order AX-260907-100348 is inspected
 * read-only.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f42b.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  getSellerSettlementPreview,
  sellerReceivable,
  RETURN_VALUE_STATUSES,
  SETTLEMENT_BLOCKING_RETURN_STATUSES,
} from "../src/lib/marketplace/settlement";
import { recordSettlement } from "../src/lib/admin/settlements";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
function roundHalfUp(x: number): number { return Math.sign(x) * Math.round(Math.abs(x)); }
class Rollback extends Error {}
type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
const DAY = 24 * 60 * 60 * 1000;

async function seedSellerWithOffer(tx: Tx, slug: string, variantId: string, commissionRate: number) {
  const seller = await tx.seller.create({
    data: { type: "THIRD_PARTY", status: "APPROVED", displayName: slug, slug, supportEmail: `${slug}@t.test`, commissionRate },
    select: { id: true, displayName: true, supportEmail: true, commissionRate: true },
  });
  const offer = await tx.offer.create({
    data: { sellerId: seller.id, variantId, price: 5000, condition: "NEW", status: "DRAFT", sellerSku: `${slug}-sku` },
    select: { id: true },
  });
  await tx.offerInventory.create({ data: { offerId: offer.id, quantity: 10, reserved: 0, reorderPoint: 2 } });
  return { seller, offer };
}

async function seedDeliveredSO(
  tx: Tx,
  seller: { id: string; displayName: string; supportEmail: string; commissionRate: number },
  offer: { id: string },
  productId: string,
  variantId: string,
  suffix: string,
  opts: { paymentStatus?: string; total?: number; commissionAmount?: number; deliveredDaysAgo?: number; itemQty?: number } = {},
) {
  const total = opts.total ?? 100000;
  const commissionAmount = opts.commissionAmount ?? roundHalfUp((total * seller.commissionRate) / 10000);
  const deliveredAt = new Date(Date.now() - (opts.deliveredDaysAgo ?? 40) * DAY);
  const order = await tx.order.create({
    data: {
      orderNumber: `AX-T9F42B-${suffix}-${Math.random().toString(36).slice(2, 6)}`,
      email: "buyer@example.test",
      status: "DELIVERED",
      paymentStatus: opts.paymentStatus ?? "PAID",
      subtotal: total,
      grandTotal: total,
      deliveredAt,
      placedAt: new Date(deliveredAt.getTime() - 3 * DAY),
      shippingAddress: JSON.stringify({ firstName: "T", city: "M", country: "PH" }),
    },
    select: { id: true, orderNumber: true },
  });
  const so = await tx.sellerOrder.create({
    data: {
      orderId: order.id, sellerId: seller.id, sellerName: seller.displayName, sellerType: "THIRD_PARTY",
      supportEmail: seller.supportEmail, commissionRate: seller.commissionRate, merchandiseSubtotal: total,
      total, commissionAmount, status: "DELIVERED", settlementStatus: "PENDING_CAPTURE",
    },
    select: { id: true, total: true, commissionAmount: true },
  });
  const qty = opts.itemQty ?? 2;
  const oi = await tx.orderItem.create({
    data: {
      orderId: order.id, sellerOrderId: so.id, sellerId: seller.id, offerId: offer.id,
      productId, variantId, name: "Test item", unitPrice: 5000, quantity: qty, lineTotal: 5000 * qty,
    },
    select: { id: true },
  });
  return { order, so, orderItemId: oi.id };
}

async function seedReturn(tx: Tx, orderId: string, orderItemId: string, productId: string, variantId: string, status: string, qty: number, unitPrice = 5000) {
  const seq = await tx.$queryRawUnsafe<{ v: bigint }[]>(`SELECT nextval('return_number_seq') AS v`);
  const ret = await tx.returnRequest.create({
    data: {
      returnNumber: `RET-T9F42B-${seq[0].v}`, orderId, status, reason: "DAMAGED",
      items: { create: [{ orderItemId, productId, variantId, name: "Test item", unitPrice, quantity: qty, refundAmount: unitPrice * qty }] },
    },
    select: { id: true, items: { select: { id: true } } },
  });
  return { returnId: ret.id, returnItemId: ret.items[0].id };
}

// ---------------------------------------------------------------------------
// Static wiring
// ---------------------------------------------------------------------------

function staticTests() {
  const settlement = read("src/lib/marketplace/settlement.ts");
  const adminRepo = read("src/lib/admin/settlements.ts");
  const schema = read("prisma/schema.prisma");
  const migration = read("supabase/migrations/20260910140000_settlement_carry_forward.sql");
  const emailTpl = read("src/lib/email/templates/seller-order-notifications.ts");

  ok("schema · SellerSettlement.carryForwardAmount Int? added, nullable, no default", /carryForwardAmount Int\?/.test(schema) && !/carryForwardAmount Int\? @default/.test(schema));
  ok("migration · additive, idempotent, single ADD COLUMN IF NOT EXISTS", /BEGIN;[\s\S]*ADD COLUMN IF NOT EXISTS "carryForwardAmount" INTEGER;[\s\S]*COMMIT;/.test(migration) && !/DROP |ALTER COLUMN|DEFAULT /.test(migration));
  ok("migration · touches no other settlement table/column", !/ReturnRequest|SellerOrder|"Order"|ReturnItem/.test(migration));

  // P1-A
  ok("P1-A · eligibility query requires Order.paymentStatus = PAID", /order: \{\s*is: \{[\s\S]{0,200}paymentStatus: "PAID",/.test(settlement));
  ok("P1-A · the other eligibility conditions are all still present", /settlementId: null,/.test(settlement) && /settlementStatus: "PENDING_CAPTURE",/.test(settlement) && /status: "DELIVERED",/.test(settlement) && /returnRequests: \{ none:/.test(settlement) && /so\.order\.deliveredAt \?\? so\.order\.placedAt/.test(settlement));
  ok("P1-A · no automatic payment mechanism introduced (no paymentStatus write)", !/paymentStatus:\s*"PAID"\s*\}/.test(settlement.replace(/paymentStatus: "PAID",/g, "")) && !/\.update\([\s\S]{0,120}paymentStatus/.test(settlement) && !/paymentStatus:\s*"PAID"/.test(adminRepo));

  // P1-B / P1-C
  ok("P1-B/C · RETURN_VALUE_STATUSES = RECEIVED/REFUND_INITIATED/REFUND_COMPLETED", JSON.stringify([...RETURN_VALUE_STATUSES]) === JSON.stringify(["RECEIVED", "REFUND_INITIATED", "REFUND_COMPLETED"]));
  ok("P1-B/C · blocking-return set UNCHANGED (existing protection kept)", JSON.stringify([...SETTLEMENT_BLOCKING_RETURN_STATUSES]) === JSON.stringify(["REQUESTED", "APPROVED", "RECEIVED", "REFUND_INITIATED"]));
  ok("P1-B/C · deduction uses frozen ReturnItem.refundAmount, never re-reads Offer.price / commissionRate", /returnItem\.findMany/.test(settlement) && /refundAmount: true/.test(settlement) && !/offer\.(?:findMany|findUnique)[\s\S]{0,200}price/.test(settlement));
  ok("P1-B/C · per-order receivable = sellerReceivable(so) - returnedValueDeducted", /receivable: sellerReceivable\(so\) - returnedValueDeducted/.test(settlement));
  ok("P1-B/C · SellerOrder.total / merchandiseSubtotal NOT mutated by settlement", !/sellerOrder\.update[\s\S]{0,200}(total|merchandiseSubtotal)/.test(settlement) && !/sellerOrder\.update[\s\S]{0,200}(total|merchandiseSubtotal)/.test(adminRepo));

  // P2-B
  ok("P2-B · netAmount floored at 0", /netAmount: Math\.max\(0, netRaw\)/.test(settlement));
  ok("P2-B · carryForwardAmount = max(0, -netRaw)", /carryForwardAmount: Math\.max\(0, -netRaw\)/.test(settlement));
  ok("P2-B · carryForwardPrior read from the seller's most recent settlement row", /sellerSettlement\.findFirst\(/.test(settlement) && /orderBy: \[\{ paidAt: "desc" \}, \{ createdAt: "desc" \}/.test(settlement) && /carryForwardPrior = priorRow\?\.carryForwardAmount \?\? 0/.test(settlement));
  ok("P2-B · recordSettlement CONFLICT guard on the eligible-order write is intact", /if \(res\.count !== positiveIds\.length\) \{\s*throw new SettlementConflict/.test(adminRepo));
  ok("P2-B · recordSettlement persists carryForwardAmount + folds pre-settlement returns into the clawback aggregate", /carryForwardAmount: preview\.carryForwardAmount,/.test(adminRepo) && /clawbackAmount: preview\.clawbackAmount \+ preview\.preSettlementReturnDeduction,/.test(adminRepo));
  ok("P2-B · historical rows never rewritten (only .create, no .update/.delete on sellerSettlement)", !/sellerSettlement\.update|sellerSettlement\.delete|sellerSettlement\.updateMany/.test(adminRepo) && /sellerSettlement\.create/.test(adminRepo));

  // email
  ok("email · settlement template accepts optional carryForwardAmount + shows carried-forward lines", /carryForwardAmount\?: number/.test(emailTpl) && /Carried forward to your next settlement/.test(emailTpl) && /Balance carried over from last settlement/.test(emailTpl));
  ok("email · carry-forward copy never implies money was withdrawn", !/withdrawn from your/i.test(emailTpl) && /No money has been withdrawn/.test(emailTpl));

  ok("scope · no PayMongo env / activation, seed-rbac untouched", !/PAYMONGO_/.test(settlement) && !/PAYMONGO_/.test(adminRepo) && !/seed-rbac/.test(settlement) && !/seed-rbac/.test(adminRepo));
}

// ---------------------------------------------------------------------------
// Database (rolled back)
// ---------------------------------------------------------------------------

async function dbTests() {
  const settlementBefore = await prisma.sellerSettlement.count();
  const sellerOrderBefore = await prisma.sellerOrder.count();
  const orderBefore = await prisma.order.count();
  const returnBefore = await prisma.returnRequest.count();

  try {
    await prisma.$transaction(async (tx) => {
      const t = Date.now().toString(36);
      const category = await tx.category.findFirst({ where: { active: true }, select: { id: true } });
      if (!category) { ok("db tests skipped — no active category", true); throw new Rollback(); }
      const product = await tx.product.create({
        data: { name: `S42 ${t}`, slug: `s42-${t}`, shortDescription: "s", description: "d", categoryId: category.id, status: "ACTIVE", price: 5000 },
        select: { id: true },
      });
      const variant = await tx.variant.create({
        data: { productId: product.id, sku: `S42-${t}`, price: 5000, status: "ACTIVE", stock: 40 },
        select: { id: true },
      });
      const A = await seedSellerWithOffer(tx, `s42-a-${t}`, variant.id, 1500); // 15%
      const B = await seedSellerWithOffer(tx, `s42-b-${t}`, variant.id, 1000); // 10%

      // ══ A — COD payment gate (P1-A) ═══════════════════════════════════════
      const pending = await seedDeliveredSO(tx, A.seller, A.offer, product.id, variant.id, `pend-${t}`, { paymentStatus: "PENDING" });
      const unpaid = await seedDeliveredSO(tx, A.seller, A.offer, product.id, variant.id, `unpd-${t}`, { paymentStatus: "UNPAID" });
      const paid = await seedDeliveredSO(tx, A.seller, A.offer, product.id, variant.id, `paid-${t}`, { paymentStatus: "PAID" });
      let preview = await getSellerSettlementPreview(A.seller.id, tx);
      let ids = new Set(preview.eligibleOrders.map((o) => o.id));
      ok("A · DELIVERED + paymentStatus PENDING → NOT eligible", !ids.has(pending.so.id));
      ok("A · DELIVERED + paymentStatus UNPAID → NOT eligible", !ids.has(unpaid.so.id));
      ok("A · DELIVERED + paymentStatus PAID + window elapsed → eligible", ids.has(paid.so.id));
      // flipping payment to PAID makes it eligible; nothing else changed
      await tx.order.update({ where: { id: pending.order.id }, data: { paymentStatus: "PAID" } });
      preview = await getSellerSettlementPreview(A.seller.id, tx);
      ids = new Set(preview.eligibleOrders.map((o) => o.id));
      ok("A · once paymentStatus becomes PAID the same order is eligible", ids.has(pending.so.id));

      // ══ B — return before settlement (P1-B / P1-C) ════════════════════════
      // fresh seller so the math is isolated
      const C = await seedSellerWithOffer(tx, `s42-c-${t}`, variant.id, 1500);
      // partial: 2 units @ 5000, return 1 (refundAmount 5000). total 100000, commission 15000.
      const partial = await seedDeliveredSO(tx, C.seller, C.offer, product.id, variant.id, `part-${t}`, { total: 100000, commissionAmount: 15000, itemQty: 2 });
      await seedReturn(tx, partial.order.id, partial.orderItemId, product.id, variant.id, "REFUND_COMPLETED", 1); // 5000 back
      // full: 2 units, return 2 (refundAmount 10000)
      const full = await seedDeliveredSO(tx, C.seller, C.offer, product.id, variant.id, `full-${t}`, { total: 100000, commissionAmount: 15000, itemQty: 2 });
      await seedReturn(tx, full.order.id, full.orderItemId, product.id, variant.id, "REFUND_COMPLETED", 2); // 10000 back
      // clean control
      const clean = await seedDeliveredSO(tx, C.seller, C.offer, product.id, variant.id, `cln-${t}`, { total: 100000, commissionAmount: 15000, itemQty: 2 });

      preview = await getSellerSettlementPreview(C.seller.id, tx);
      const byId = new Map(preview.eligibleOrders.map((o) => [o.id, o]));
      ok("B · all three orders eligible (a completed return does NOT block)", byId.has(partial.so.id) && byId.has(full.so.id) && byId.has(clean.so.id));
      ok("B · partial return: returnedValueDeducted = 5000, receivable = 100000 - 15000 - 5000 = 80000", byId.get(partial.so.id)?.returnedValueDeducted === 5000 && byId.get(partial.so.id)?.receivable === 80000, JSON.stringify(byId.get(partial.so.id)));
      ok("B · full return: returnedValueDeducted = 10000, receivable = 75000", byId.get(full.so.id)?.returnedValueDeducted === 10000 && byId.get(full.so.id)?.receivable === 75000, JSON.stringify(byId.get(full.so.id)));
      ok("B · clean order: no deduction, receivable = 85000", byId.get(clean.so.id)?.returnedValueDeducted === 0 && byId.get(clean.so.id)?.receivable === 85000);
      ok("B · preSettlementReturnDeduction = 5000 + 10000 = 15000", preview.preSettlementReturnDeduction === 15000);
      ok("B · receivableSubtotal = gross(300000) - commission(45000) - returned(15000) = 240000", preview.receivableSubtotal === 240000, JSON.stringify(preview));
      ok("B · netAmount = 240000 (no clawback, no carry-forward)", preview.netAmount === 240000 && preview.carryForwardAmount === 0);

      // record it — the returned value is folded into the row's clawback aggregate, never lost, never doubled
      const cBatch = await recordSettlement({ sellerId: C.seller.id, paidAt: new Date("2026-09-09"), paymentReference: "T-C" }, tx);
      ok("B · recordSettlement succeeds; net 240000, nothing carried", cBatch.ok === true && cBatch.netAmount === 240000 && cBatch.carryForwardAmount === 0, JSON.stringify(cBatch));
      if (cBatch.ok) {
        const row = await tx.sellerSettlement.findUniqueOrThrow({ where: { id: cBatch.settlementId } });
        ok("B · row: gross 300000, commission 45000, clawbackAmount 15000 (returned value folded in), net 240000", row.grossReceivable === 300000 && row.commissionAmount === 45000 && row.clawbackAmount === 15000 && row.netAmount === 240000, JSON.stringify(row));
        ok("B · row identity reconciles: gross - commission - clawbackAmount - carryIn(0) = net", row.grossReceivable - row.commissionAmount - row.clawbackAmount - 0 === row.netAmount);
        // SellerOrder.total / merchandiseSubtotal untouched
        const soRows = await tx.sellerOrder.findMany({ where: { settlementId: cBatch.settlementId }, select: { total: true, merchandiseSubtotal: true, settlementStatus: true } });
        ok("B · every settled SellerOrder keeps total = merchandiseSubtotal = 100000 and is SETTLED", soRows.length === 3 && soRows.every((s) => s.total === 100000 && s.merchandiseSubtotal === 100000 && s.settlementStatus === "SETTLED"));
        // no double subtraction — settling again yields nothing
        preview = await getSellerSettlementPreview(C.seller.id, tx);
        ok("B · after settlement: 0 eligible, 0 outstanding clawbacks, no phantom deduction", preview.eligibleOrders.length === 0 && preview.outstandingClawbacks.length === 0 && preview.preSettlementReturnDeduction === 0 && preview.netAmount === 0);
      }

      // ══ C — post-settlement return: existing clawback mechanism unchanged ══
      const D = await seedSellerWithOffer(tx, `s42-d-${t}`, variant.id, 1500);
      const psOrder = await seedDeliveredSO(tx, D.seller, D.offer, product.id, variant.id, `ps-${t}`, { total: 100000, commissionAmount: 15000, itemQty: 2 });
      const dBatch = await recordSettlement({ sellerId: D.seller.id, paidAt: new Date("2026-09-09"), paymentReference: "T-D" }, tx);
      ok("C · order settled first (net 85000)", dBatch.ok === true && dBatch.netAmount === 85000);
      // now a return is received post-settlement — replicate the returns-actions.ts clawback write
      const psSo = await tx.sellerOrder.findUniqueOrThrow({ where: { id: psOrder.so.id }, select: { commissionAmount: true, commissionRate: true, settlementId: true } });
      const returnedValue = 5000;
      const commissionAdjustment = roundHalfUp((returnedValue * psSo.commissionRate) / 10000); // 750
      const clawbackDelta = Math.max(0, returnedValue - commissionAdjustment); // 4250
      await tx.sellerOrder.update({
        where: { id: psOrder.so.id },
        data: {
          commissionAmount: Math.max(0, psSo.commissionAmount - commissionAdjustment),
          settlementStatus: "CLAWED_BACK",
          settlementClawbackAmount: { increment: clawbackDelta },
        },
      });
      preview = await getSellerSettlementPreview(D.seller.id, tx);
      ok("C · post-settlement return shows as an OUTSTANDING CLAWBACK, not a pre-settlement deduction", preview.outstandingClawbacks.some((c) => c.id === psOrder.so.id && c.clawbackAmount === clawbackDelta) && preview.preSettlementReturnDeduction === 0);
      ok("C · with only that clawback: net floored to 0, residual (4250) carried forward", preview.netAmount === 0 && preview.carryForwardAmount === clawbackDelta && preview.carryForwardPrior === 0);

      // ══ D — carry-forward chain (P2-B) ═══════════════════════════════════
      // sweep the clawback → residual carried on the sweep row
      const sweep = await recordSettlement({ sellerId: D.seller.id, paidAt: new Date("2026-09-10"), note: "sweep" }, tx);
      ok("D · sweep batch: net 0, carryForwardAmount = 4250", sweep.ok === true && sweep.netAmount === 0 && sweep.carryForwardAmount === clawbackDelta);
      preview = await getSellerSettlementPreview(D.seller.id, tx);
      ok("D · residual is now carryForwardPrior for the next settlement", preview.carryForwardPrior === clawbackDelta);
      // a new small delivered+paid order: receivable 2000 (total 2000, commission 0) — less than the 4250 residual
      const small = await seedDeliveredSO(tx, D.seller, D.offer, product.id, variant.id, `sml-${t}`, { total: 2000, commissionAmount: 0, itemQty: 1 });
      void small;
      preview = await getSellerSettlementPreview(D.seller.id, tx);
      ok("D · next settlement: receivable 2000 < residual 4250 → net 0, new residual 2250", preview.netAmount === 0 && preview.carryForwardAmount === 2250 && preview.receivableSubtotal === 2000, JSON.stringify(preview));
      const nextBatch = await recordSettlement({ sellerId: D.seller.id, paidAt: new Date("2026-09-11") }, tx);
      ok("D · recordSettlement consumes the carry-forward, persists the smaller residual", nextBatch.ok === true && nextBatch.netAmount === 0 && nextBatch.carryForwardAmount === 2250);
      // a bigger order clears the rest
      const big = await seedDeliveredSO(tx, D.seller, D.offer, product.id, variant.id, `big-${t}`, { total: 10000, commissionAmount: 0, itemQty: 1 });
      void big;
      preview = await getSellerSettlementPreview(D.seller.id, tx);
      ok("D · final settlement: receivable 10000 - residual 2250 → net 7750, nothing carried", preview.netAmount === 7750 && preview.carryForwardAmount === 0 && preview.carryForwardPrior === 2250);
      const finalBatch = await recordSettlement({ sellerId: D.seller.id, paidAt: new Date("2026-09-12") }, tx);
      ok("D · final batch net 7750, carryForwardAmount 0", finalBatch.ok === true && finalBatch.netAmount === 7750 && finalBatch.carryForwardAmount === 0);
      preview = await getSellerSettlementPreview(D.seller.id, tx);
      ok("D · carry-forward fully cleared", preview.carryForwardPrior === 0 && preview.carryForwardAmount === 0);

      // ══ E — frozen-value integrity ═══════════════════════════════════════
      const E = await seedSellerWithOffer(tx, `s42-e-${t}`, variant.id, 1500);
      const eOrder = await seedDeliveredSO(tx, E.seller, E.offer, product.id, variant.id, `frz-${t}`, { total: 100000, commissionAmount: 15000, itemQty: 2 });
      await seedReturn(tx, eOrder.order.id, eOrder.orderItemId, product.id, variant.id, "REFUND_COMPLETED", 1); // refundAmount 5000 frozen
      const beforeMut = await getSellerSettlementPreview(E.seller.id, tx);
      // mutate current Offer.price and current Seller.commissionRate AFTER the sale
      await tx.offer.update({ where: { id: E.offer.id }, data: { price: 999999 } });
      await tx.seller.update({ where: { id: E.seller.id }, data: { commissionRate: 9999 } });
      const afterMut = await getSellerSettlementPreview(E.seller.id, tx);
      ok("E · changing current Offer.price does not move the settlement receivable", beforeMut.eligibleOrders[0]?.receivable === afterMut.eligibleOrders[0]?.receivable && afterMut.eligibleOrders[0]?.receivable === 80000);
      ok("E · changing current Seller.commissionRate does not move the settled commission", beforeMut.commissionAmount === afterMut.commissionAmount && afterMut.commissionAmount === 15000);
      ok("E · returned value comes from the frozen ReturnItem.refundAmount", afterMut.preSettlementReturnDeduction === 5000);

      // ══ F — concurrency / idempotency ════════════════════════════════════
      const F = await seedSellerWithOffer(tx, `s42-f-${t}`, variant.id, 1500);
      const fOrder = await seedDeliveredSO(tx, F.seller, F.offer, product.id, variant.id, `cc-${t}`, { total: 100000, commissionAmount: 15000, itemQty: 2 });
      const f1 = await recordSettlement({ sellerId: F.seller.id, paidAt: new Date() }, tx);
      ok("F · first settlement succeeds", f1.ok === true);
      const f2 = await recordSettlement({ sellerId: F.seller.id, paidAt: new Date() }, tx);
      ok("F · immediate duplicate → NOTHING_TO_SETTLE (no second row)", f2.ok === false && f2.code === "NOTHING_TO_SETTLE");
      ok("F · the SellerOrder was consumed exactly once", (await tx.sellerOrder.count({ where: { id: fOrder.so.id, settlementStatus: "SETTLED", settlementId: f1.ok ? f1.settlementId : "" } })) === 1);
      // an order already consumed by another settlement can never be swept into a second one
      const G = await seedSellerWithOffer(tx, `s42-g-${t}`, variant.id, 1500);
      const gOrder = await seedDeliveredSO(tx, G.seller, G.offer, product.id, variant.id, `st-${t}`, { total: 100000, commissionAmount: 15000, itemQty: 2 });
      await tx.sellerOrder.update({ where: { id: gOrder.so.id }, data: { settlementStatus: "SETTLED", settlementId: (f1.ok ? f1.settlementId : null) } });
      const conflict = await recordSettlement({ sellerId: G.seller.id, paidAt: new Date() }, tx);
      ok("F · an already-consumed SellerOrder is not settleable again (NOTHING_TO_SETTLE, no second row)", conflict.ok === false && conflict.code === "NOTHING_TO_SETTLE");
      ok("F · no settlement row was created for G", (await tx.sellerSettlement.count({ where: { sellerId: G.seller.id } })) === 0);

      // ══ AX-260907-100348 — real production order, read-only ═══════════════
      const axSo = await tx.sellerOrder.findFirst({
        where: { order: { orderNumber: "AX-260907-100348" } },
        select: { sellerId: true, settlementStatus: true, settlementId: true, order: { select: { status: true, paymentStatus: true } } },
      });
      if (axSo) {
        ok("AX · production order still DELIVERED / paymentStatus PENDING / PENDING_CAPTURE / unsettled", axSo.order.status === "DELIVERED" && axSo.order.paymentStatus === "PENDING" && axSo.settlementStatus === "PENDING_CAPTURE" && axSo.settlementId === null, JSON.stringify(axSo));
        const axPreview = await getSellerSettlementPreview(axSo.sellerId, tx);
        ok("AX · AX-260907-100348 does NOT appear in its seller's settlement preview (paymentStatus PENDING gate)", !axPreview.eligibleOrders.some((o) => o.orderNumber === "AX-260907-100348"));
      } else {
        ok("AX · (AX-260907-100348 not present in this DB — skipped)", true);
      }

      throw new Rollback();
    }, { timeout: 120_000, maxWait: 15_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("isolation · SellerSettlement count unchanged after rollback", (await prisma.sellerSettlement.count()) === settlementBefore);
  ok("isolation · SellerOrder count unchanged after rollback", (await prisma.sellerOrder.count()) === sellerOrderBefore);
  ok("isolation · Order count unchanged after rollback", (await prisma.order.count()) === orderBefore);
  ok("isolation · ReturnRequest count unchanged after rollback", (await prisma.returnRequest.count()) === returnBefore);
}

async function main() {
  console.log("\nPHASE 9F-42B — minimum-safe 3P settlement fix\n");
  console.log("Static wiring");
  staticTests();
  console.log("\nDatabase (rolled back)");
  await dbTests();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
