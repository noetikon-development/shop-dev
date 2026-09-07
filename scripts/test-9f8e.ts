/**
 * Phase 9F-8e — seller settlement / payout recording (bookkeeping-only).
 *
 * DB tests build THIRD_PARTY sellers + DELIVERED SellerOrders (offer-bound) +
 * ReturnRequests inside ONE prisma.$transaction and roll back. Every settlement
 * read/write core is `client`-aware; `sellerReceiveReturn` takes an externalTx,
 * so the partial-return clawback is exercised end-to-end. The admin
 * `cancelOrderAction` is permission-gated (cookie-dependent) so its clawback
 * effect is verified by replicating its exact DB writes + a static assertion.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f8e.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  sellerReceivable,
  getSellerSettlementPreview,
  SETTLEMENT_BLOCKING_RETURN_STATUSES,
} from "../src/lib/marketplace/settlement";
import { recordSettlement, listAdminSettlements, getAdminSettlement } from "../src/lib/admin/settlements";
import { listSellerSettlements, getSellerSettlement } from "../src/lib/seller/settlement-repository";
import { sellerReceiveReturn } from "../src/lib/marketplace/seller-return-repository";
import type { SellerContext } from "../src/lib/marketplace/types";

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

function ctxFor(sellerId: string): SellerContext {
  return { sellerId, sellerName: "S", sellerUserId: "su-" + sellerId, userId: "u-" + sellerId, role: "OWNER", permissions: new Set() };
}

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

async function seedDeliveredSellerOrder(
  tx: Tx,
  seller: { id: string; displayName: string; supportEmail: string; commissionRate: number },
  offer: { id: string },
  productId: string,
  variantId: string,
  suffix: string,
  opts: {
    deliveredDaysAgo?: number;
    orderStatus?: string;
    sellerOrderStatus?: string;
    total?: number;
    commissionAmount?: number;
    settlementId?: string;
    itemQty?: number;
  } = {},
) {
  const total = opts.total ?? 100000;
  const commissionAmount = opts.commissionAmount ?? roundHalfUp((total * seller.commissionRate) / 10000);
  const deliveredAt = new Date(Date.now() - (opts.deliveredDaysAgo ?? 40) * DAY);
  const order = await tx.order.create({
    data: {
      orderNumber: `AX-T9F8E-${suffix}-${Math.random().toString(36).slice(2, 6)}`,
      email: "buyer@example.test",
      status: opts.orderStatus ?? "DELIVERED",
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
      total, commissionAmount, status: opts.sellerOrderStatus ?? "DELIVERED",
      settlementId: opts.settlementId ?? null,
      settlementStatus: opts.settlementId ? "SETTLED" : "PENDING_CAPTURE",
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

async function seedReturn(tx: Tx, orderId: string, orderItemId: string, productId: string, variantId: string, status: string, returnedQty: number, unitPrice = 5000) {
  const seq = await tx.$queryRawUnsafe<{ v: bigint }[]>(`SELECT nextval('return_number_seq') AS v`);
  const ret = await tx.returnRequest.create({
    data: {
      returnNumber: `RET-T9F8E-${seq[0].v}`, orderId, status, reason: "DAMAGED",
      items: { create: [{ orderItemId, productId, variantId, name: "Test item", unitPrice, quantity: returnedQty, refundAmount: unitPrice * returnedQty }] },
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
  const adminActions = read("src/lib/admin/settlement-actions.ts");
  const sellerRepo = read("src/lib/seller/settlement-repository.ts");
  const orderActions = read("src/lib/admin/order-actions.ts");
  const returnsActions = read("src/lib/admin/returns-actions.ts");
  const sellerReturnRepo = read("src/lib/marketplace/seller-return-repository.ts");
  const adminListPage = read("src/app/admin/(shell)/settlements/page.tsx");
  const adminDetailPage = read("src/app/admin/(shell)/settlements/[id]/page.tsx");
  const sellerListPage = read("src/app/seller/(portal)/settlements/page.tsx");
  const sellerDetailPage = read("src/app/seller/(portal)/settlements/[id]/page.tsx");
  const schema = read("prisma/schema.prisma");
  const nav = read("src/lib/admin/navigation.ts");
  const sellerNav = read("src/lib/seller/navigation.ts");

  // Schema
  ok("schema · SellerSettlement model added", /model SellerSettlement \{/.test(schema));
  ok("schema · SellerOrder.settlementId nullable FK + settlementClawbackAmount added", /settlementId\s+String\?/.test(schema) && /settlementClawbackAmount Int\s+@default\(0\)/.test(schema));
  ok("schema · SellerOrder gains @@index([settlementId])", /@@index\(\[settlementId\]\)/.test(schema));
  ok("schema · settlementStatus enum comment unchanged (still the same 5 values)", /PENDING_CAPTURE \| CAPTURED \| SETTLED \| REFUNDED \| CLAWED_BACK/.test(schema));
  ok("migration · additive SQL file present", /BEGIN;[\s\S]*CREATE TABLE IF NOT EXISTS "SellerSettlement"[\s\S]*ADD COLUMN IF NOT EXISTS "settlementId"[\s\S]*COMMIT;/.test(read("supabase/migrations/20260907120000_seller_settlement.sql")));

  // Receivable
  ok("receivable · sellerReceivable = total - commissionAmount", /return so\.total - so\.commissionAmount;/.test(settlement));

  // Eligibility predicate
  ok("eligibility · settlementId null + PENDING_CAPTURE + THIRD_PARTY + DELIVERED + parent Order DELIVERED", /settlementId: null,\s*settlementStatus: "PENDING_CAPTURE",\s*status: "DELIVERED",[\s\S]{0,120}order: \{\s*is: \{\s*status: "DELIVERED"/.test(settlement));
  ok("eligibility · blocking-return statuses are exactly REQUESTED/APPROVED/RECEIVED/REFUND_INITIATED", JSON.stringify([...SETTLEMENT_BLOCKING_RETURN_STATUSES]) === JSON.stringify(["REQUESTED", "APPROVED", "RECEIVED", "REFUND_INITIATED"]));
  ok("eligibility · window keyed off Order.deliveredAt ?? Order.placedAt", /so\.order\.deliveredAt \?\? so\.order\.placedAt/.test(settlement) && /windowDays \* 24 \* 60 \* 60 \* 1000/.test(settlement));
  ok("eligibility · no SellerOrder.deliveredAt anywhere", !/SellerOrder[\s\S]{0,400}deliveredAt/.test(schema.slice(schema.indexOf("model SellerOrder"), schema.indexOf("model SellerSettlement"))));

  // Permission gating
  ok("perm · record-settlement action requires manage_payments", /requirePermission\("manage_payments"\)/.test(adminActions));
  ok("perm · admin settlement list + detail pages require manage_payments", /requirePermission\("manage_payments"\)/.test(adminListPage) && /requirePermission\("manage_payments"\)/.test(adminDetailPage));
  ok("perm · seller settlement pages use the seller portal session gate", /requireSellerSession\(/.test(sellerListPage) && /requireSellerSession\(/.test(sellerDetailPage));
  ok("perm · no new RBAC permission key introduced", !/9F-8e/.test(read("src/lib/rbac/catalog.ts")));
  ok("perm · scripts/seed-rbac.ts not referenced", ![settlement, adminRepo, adminActions, sellerRepo].some((f) => /seed-rbac/.test(f)));

  // Nav
  ok("nav · /admin/settlements registered with accepts [manage_payments]", /path: "\/admin\/settlements"[\s\S]{0,400}accepts: \["manage_payments"\]/.test(nav));
  ok("nav · /seller/settlements registered", /path: "\/seller\/settlements"/.test(sellerNav));

  // Record core
  ok("record · amounts always recomputed server-side (never from the form)", /getSellerSettlementPreview\(input\.sellerId, tx\)/.test(adminRepo));
  ok("record · positive orders stamped under a settlementId: null guard, abort on count mismatch", /where: \{ id: \{ in: positiveIds \}, settlementId: null, settlementStatus: "PENDING_CAPTURE" \}[\s\S]{0,200}if \(res\.count !== positiveIds\.length\) \{\s*throw new SettlementConflict/.test(adminRepo));
  ok("record · clawback orders reconciled: settlementClawbackAmount -> 0, re-pointed to the batch", /settlementClawbackAmount: \{ gt: 0 \} \}[\s\S]{0,200}data: \{ settlementId: settlement\.id, settlementClawbackAmount: 0 \}/.test(adminRepo));
  ok("record · netAmount MAY be <= 0 (no floor)", /netAmount: preview\.netAmount, \/\/ MAY be <= 0/.test(adminRepo));

  // Clawback in the 3 paths
  ok("clawback · cancelOrderAction claws back total - commissionAmount for settled SellerOrders", /if \(so\.settlementId === null\) continue;[\s\S]{0,400}settlementStatus: "CLAWED_BACK",\s*settlementClawbackAmount: \{ increment: Math\.max\(0, so\.total - so\.commissionAmount\) \}/.test(orderActions));
  ok("clawback · cancelOrderAction keeps the 9F-8c zero-commission behaviour for UNSETTLED orders", /const unsettledIds = toCancel\.filter\(\(s\) => s\.settlementId === null\)[\s\S]{0,220}data: \{ status: "CANCELLED", updatedAt: new Date\(\), commissionAmount: 0 \}/.test(orderActions));
  ok("clawback · admin receiveReturnAction claws back returnedValue - commissionAdjustment for settled orders", /if \(so\.settlementId !== null\) \{\s*data\.settlementStatus = "CLAWED_BACK";\s*data\.settlementClawbackAmount = \{ increment: Math\.max\(0, returnedValue - commissionAdjustment\) \}/.test(returnsActions));
  ok("clawback · seller sellerReceiveReturn uses the IDENTICAL clawback rule", /if \(so\.settlementId !== null\) \{\s*data\.settlementStatus = "CLAWED_BACK";\s*data\.settlementClawbackAmount = \{ increment: Math\.max\(0, returnedValue - commissionAdjustment\) \}/.test(sellerReturnRepo));

  // Seller isolation
  ok("isolation · seller repo scopes every query on ctx.sellerId", (sellerRepo.match(/ctx\.sellerId/g) ?? []).length >= 3);

  // Scope guards
  ok("scope · checkout.ts commission formula untouched", /const sellerCommissionAmount = roundHalfUp\(\(subtotal \* soSeller\.commissionRate\) \/ 10000\);/.test(read("src/lib/checkout.ts")) && !/9F-8e/.test(read("src/lib/checkout.ts")));
  ok("scope · no multiSellerCheckout / PayMongo write in the new code", ![settlement, adminRepo, adminActions, sellerRepo].some((f) => /multiSellerCheckout.*=.*"true"|PAYMONGO_/.test(f)));
  ok("scope · seller-repository.ts (offer activation) not touched by this phase", !/9F-8e/.test(read("src/lib/marketplace/seller-repository.ts")));
  ok("scope · admin/seller detail pages label as bookkeeping-only, not a real transfer", /no automatic transfer/i.test(adminDetailPage) && /outside the platform/i.test(sellerDetailPage));
}

// ---------------------------------------------------------------------------
// Database (rolled back)
// ---------------------------------------------------------------------------

async function dbTests() {
  const settlementBefore = await prisma.sellerSettlement.count();
  const sellerOrderBefore = await prisma.sellerOrder.count();

  try {
    await prisma.$transaction(async (tx) => {
      const t = Date.now().toString(36);
      const category = await tx.category.findFirst({ where: { active: true }, select: { id: true } });
      if (!category) { ok("db tests skipped — no active category", true); throw new Rollback(); }
      const product = await tx.product.create({
        data: { name: `SE ${t}`, slug: `se-${t}`, shortDescription: "s", description: "d", categoryId: category.id, status: "ACTIVE", price: 5000 },
        select: { id: true },
      });
      const variant = await tx.variant.create({
        data: { productId: product.id, sku: `SE-${t}`, price: 5000, status: "ACTIVE", stock: 20 },
        select: { id: true },
      });

      const A = await seedSellerWithOffer(tx, `se-a-${t}`, variant.id, 1500); // 15%
      const B = await seedSellerWithOffer(tx, `se-b-${t}`, variant.id, 1000); // 10%
      const ctxA = ctxFor(A.seller.id);
      const ctxB = ctxFor(B.seller.id);

      // ── 1 — receivable calculation ──────────────────────────────────────
      ok("1 · sellerReceivable(total 100000, commission 15000) === 85000", sellerReceivable({ total: 100000, commissionAmount: 15000 }) === 85000);
      const fxR = await seedDeliveredSellerOrder(tx, A.seller, A.offer, product.id, variant.id, t + "r", { total: 100000, commissionAmount: 15000 });
      let preview = await getSellerSettlementPreview(A.seller.id, tx);
      ok("1 · preview eligible order carries receivable = total - commission", preview.eligibleOrders.length === 1 && preview.eligibleOrders[0].receivable === 85000, JSON.stringify(preview.eligibleOrders));
      ok("1 · preview subtotal / net = 85000 (no other orders)", preview.receivableSubtotal === 85000 && preview.netAmount === 85000);

      // ── 2 — eligibility + return window ────────────────────────────────
      const recent = await seedDeliveredSellerOrder(tx, A.seller, A.offer, product.id, variant.id, t + "w", { deliveredDaysAgo: 5 });
      const processing = await seedDeliveredSellerOrder(tx, A.seller, A.offer, product.id, variant.id, t + "p", { sellerOrderStatus: "PROCESSING" });
      const parentShipped = await seedDeliveredSellerOrder(tx, A.seller, A.offer, product.id, variant.id, t + "ps", { orderStatus: "SHIPPED" });
      preview = await getSellerSettlementPreview(A.seller.id, tx);
      const eligibleIds = new Set(preview.eligibleOrders.map((o) => o.id));
      ok("2 · order delivered 5 days ago (inside window) is NOT eligible", !eligibleIds.has(recent.so.id));
      ok("2 · SellerOrder.status = PROCESSING is NOT eligible", !eligibleIds.has(processing.so.id));
      ok("2 · parent Order.status = SHIPPED is NOT eligible", !eligibleIds.has(parentShipped.so.id));
      ok("2 · the 40-day-old fully-delivered order IS eligible", eligibleIds.has(fxR.so.id));

      // ── 3 — open-return blocking ───────────────────────────────────────
      const blk = await seedDeliveredSellerOrder(tx, A.seller, A.offer, product.id, variant.id, t + "b");
      const blkRet = await seedReturn(tx, blk.order.id, blk.orderItemId, product.id, variant.id, "APPROVED", 1);
      preview = await getSellerSettlementPreview(A.seller.id, tx);
      ok("3 · an order with an APPROVED return is NOT eligible", !preview.eligibleOrders.some((o) => o.id === blk.so.id));
      await tx.returnRequest.update({ where: { id: blkRet.returnId }, data: { status: "REFUND_COMPLETED" } });
      preview = await getSellerSettlementPreview(A.seller.id, tx);
      ok("3 · once the return is REFUND_COMPLETED the order becomes eligible", preview.eligibleOrders.some((o) => o.id === blk.so.id));

      // ── 4 — FIRST_PARTY exclusion ──────────────────────────────────────
      // `Seller.type` has a DB-level "only one FIRST_PARTY" guard, so this uses
      // the real Axiaro FIRST_PARTY seller by reference (read-only + a write
      // attempt that is refused BEFORE anything is created, all in a rolled-
      // back tx).
      const realFp = await tx.seller.findFirstOrThrow({ where: { type: "FIRST_PARTY" }, select: { id: true } });
      const fpPreview = await getSellerSettlementPreview(realFp.id, tx);
      ok("4 · FIRST_PARTY seller preview is flagged not-settleable (sellerName null, no orders)", fpPreview.sellerName === null && fpPreview.eligibleOrders.length === 0 && fpPreview.netAmount === 0);
      const fpRecord = await recordSettlement({ sellerId: realFp.id, paidAt: new Date() }, tx);
      ok("4 · recordSettlement refuses a FIRST_PARTY seller (NOT_THIRD_PARTY), creates nothing", fpRecord.ok === false && fpRecord.code === "NOT_THIRD_PARTY");

      // ── 5 — settlement creation ────────────────────────────────────────
      // Eligible for A right now: fxR + blk (return completed). Snapshot the preview.
      preview = await getSellerSettlementPreview(A.seller.id, tx);
      const expectGross = preview.grossReceivable;
      const expectCommission = preview.commissionAmount;
      const expectNet = preview.netAmount;
      const eligCount = preview.eligibleOrders.length;
      ok("5 · A has 2 eligible orders before settlement", eligCount === 2, JSON.stringify(preview.eligibleOrders.map((o) => o.orderNumber)));
      const created = await recordSettlement({ sellerId: A.seller.id, paidAt: new Date("2026-09-07"), paymentReference: "GC-123", paymentMethod: "GCash" }, tx);
      ok("5 · recordSettlement succeeds", created.ok === true, JSON.stringify(created));
      if (!created.ok) throw new Rollback();
      const batch = await tx.sellerSettlement.findUniqueOrThrow({ where: { id: created.settlementId } });
      ok("5 · batch amounts match the recomputed preview", batch.grossReceivable === expectGross && batch.commissionAmount === expectCommission && batch.netAmount === expectNet);
      ok("5 · batch orderCount = 2, status PAID, reference/method stored", batch.orderCount === 2 && batch.status === "PAID" && batch.paymentReference === "GC-123" && batch.paymentMethod === "GCash");
      const settledOrders = await tx.sellerOrder.findMany({ where: { settlementId: created.settlementId }, select: { settlementStatus: true } });
      ok("5 · the 2 orders are now SETTLED and point at the batch", settledOrders.length === 2 && settledOrders.every((o) => o.settlementStatus === "SETTLED"));
      preview = await getSellerSettlementPreview(A.seller.id, tx);
      ok("5 · A now has 0 eligible orders", preview.eligibleOrders.length === 0);

      // ── 6 — duplicate-settlement guard ────────────────────────────────
      const dup = await recordSettlement({ sellerId: A.seller.id, paidAt: new Date() }, tx);
      ok("6 · a second settlement with nothing left → NOTHING_TO_SETTLE (not a duplicate row)", dup.ok === false && dup.code === "NOTHING_TO_SETTLE");
      ok("6 · still exactly one settlement row for A", (await tx.sellerSettlement.count({ where: { sellerId: A.seller.id } })) === 1);

      // ── 7 — full cancellation clawback (replicates cancelOrderAction) ──
      const settledId = settledOrders.length ? (await tx.sellerOrder.findFirstOrThrow({ where: { settlementId: created.settlementId }, select: { id: true, total: true, commissionAmount: true } })) : null;
      if (settledId) {
        const delta = settledId.total - settledId.commissionAmount;
        await tx.sellerOrder.update({
          where: { id: settledId.id },
          data: { status: "CANCELLED", commissionAmount: 0, settlementStatus: "CLAWED_BACK", settlementClawbackAmount: { increment: Math.max(0, delta) } },
        });
        const clawed = await tx.sellerOrder.findUniqueOrThrow({ where: { id: settledId.id }, select: { settlementStatus: true, settlementClawbackAmount: true } });
        ok("7 · full cancellation → CLAWED_BACK, clawback = total - commissionAmount", clawed.settlementStatus === "CLAWED_BACK" && clawed.settlementClawbackAmount === delta, JSON.stringify(clawed));
        preview = await getSellerSettlementPreview(A.seller.id, tx);
        ok("7 · the clawback shows as outstanding in the next preview", preview.outstandingClawbacks.some((c) => c.id === settledId.id && c.clawbackAmount === delta));

        // ── 9 — negative-net batch ─────────────────────────────────────
        ok("9 · with only a clawback outstanding the preview net is negative", preview.netAmount === -delta && preview.eligibleOrders.length === 0);
        const negBatch = await recordSettlement({ sellerId: A.seller.id, paidAt: new Date(), note: "clawback sweep" }, tx);
        ok("9 · recordSettlement accepts a negative-net bookkeeping batch", negBatch.ok === true && negBatch.netAmount === -delta, JSON.stringify(negBatch));
        if (negBatch.ok) {
          const negRow = await tx.sellerSettlement.findUniqueOrThrow({ where: { id: negBatch.settlementId } });
          ok("9 · the batch row stores netAmount < 0 and clawbackAmount > 0", negRow.netAmount === -delta && negRow.clawbackAmount === delta && negRow.clawbackCount === 1);
          const swept = await tx.sellerOrder.findUniqueOrThrow({ where: { id: settledId.id }, select: { settlementClawbackAmount: true, settlementId: true } });
          ok("9 · the reconciled clawback is zeroed and re-pointed at the sweep batch", swept.settlementClawbackAmount === 0 && swept.settlementId === negBatch.settlementId);
        }
      }

      // ── 8 — partial-return clawback (real sellerReceiveReturn call) ────
      const settledFx = await seedDeliveredSellerOrder(tx, B.seller, B.offer, product.id, variant.id, t + "pr", {
        total: 10000, commissionAmount: 1000, itemQty: 2,
      });
      // put it into a settlement so it's "settled"
      const bSettle = await recordSettlement({ sellerId: B.seller.id, paidAt: new Date() }, tx);
      ok("8 · seller B's order is settled first", bSettle.ok === true);
      const bRet = await seedReturn(tx, settledFx.order.id, settledFx.orderItemId, product.id, variant.id, "APPROVED", 1); // 1 of 2 units, refundAmount 5000
      const recv = await sellerReceiveReturn(
        ctxB,
        bRet.returnId,
        [{ returnItemId: bRet.returnItemId, receivedQuantity: 1, restockQuantity: 1, condition: "RESELLABLE" }],
        tx,
      );
      ok("8 · sellerReceiveReturn succeeds against a settled order", recv.ok === true, JSON.stringify(recv));
      const afterRet = await tx.sellerOrder.findUniqueOrThrow({ where: { id: settledFx.so.id }, select: { settlementStatus: true, settlementClawbackAmount: true, commissionAmount: true } });
      // returnedValue 5000, commissionAdjustment = roundHalfUp(5000*1000/10000) = 500 -> clawback 4500
      ok("8 · partial return → CLAWED_BACK with clawback = returnedValue - commissionAdjustment (5000 - 500 = 4500)", afterRet.settlementStatus === "CLAWED_BACK" && afterRet.settlementClawbackAmount === 4500, JSON.stringify(afterRet));
      ok("8 · commission also reduced by the returned portion (1000 - 500 = 500)", afterRet.commissionAmount === 500);

      // ── 10 — seller statement isolation ───────────────────────────────
      const aStatements = await listSellerSettlements(ctxA, tx);
      const aBatchIds = new Set(aStatements.map((s) => s.id));
      const bStatements = await listSellerSettlements(ctxB, tx);
      ok("10 · seller A sees at least one batch, none of them B's", aStatements.length >= 1 && !bStatements.some((s) => aBatchIds.has(s.id)));
      ok("10 · seller B does not see any of A's batches", (await Promise.all(aStatements.map((s) => getSellerSettlement(ctxB, s.id, tx)))).every((r) => r === null));
      ok("10 · getSellerSettlement(A, A's batch) resolves", (await getSellerSettlement(ctxA, aStatements[0].id, tx)) !== null);

      // ── 11 — admin reads ─────────────────────────────────────────────
      const adminList = await listAdminSettlements({ sellerId: A.seller.id });
      // (uses global prisma — rolled-back rows aren't visible; assert it doesn't throw + shape)
      ok("11 · listAdminSettlements returns a well-formed page object", typeof adminList.total === "number" && Array.isArray(adminList.rows));
      const adminGet = await getAdminSettlement("does-not-exist");
      ok("11 · getAdminSettlement(unknown) → null", adminGet === null);

      throw new Rollback();
    }, { timeout: 60_000, maxWait: 15_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("isolation · SellerSettlement count unchanged after rollback", (await prisma.sellerSettlement.count()) === settlementBefore);
  ok("isolation · SellerOrder count unchanged after rollback", (await prisma.sellerOrder.count()) === sellerOrderBefore);
}

async function main() {
  console.log("\nPHASE 9F-8e — seller settlement / payout recording\n");
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
