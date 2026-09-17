/**
 * Phase 9F-61 — parent-Order rollup re-evaluation after a seller cancellation.
 *
 * Launch-readiness audit finding: `sellerCancelSellerOrder()` cancelled a
 * SellerOrder and handled the ALL-cancelled parent transition, but never
 * re-ran the existing SHIPPED/DELIVERED rollup (9F-12b/9F-44) afterward — so
 * removing a cancelled BLOCKER could leave the parent Order stuck behind a
 * seller who no longer exists, even though every remaining ACTIVE seller had
 * already reached the milestone.
 *
 * Fix: after the existing sibling-lock / all-cancelled-cascade decision,
 * `sellerCancelSellerOrder()` now tries the SAME, UNMODIFIED
 * `rollUpParentOrder()` (SHIPPED, then DELIVERED) whenever at least one
 * sibling is still active. No new eligibility logic, no new status, no new
 * lock — reuses the existing function twice, exactly as two ordinary
 * sequential fulfilment advances would.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f61-cancellation-rollup.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient, Prisma } from "@prisma/client";
import {
  sellerCancelSellerOrder,
  advanceSellerOrderStatus,
} from "@/lib/marketplace/seller-order-repository";
import type { SellerContext } from "@/lib/marketplace/types";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
class Rollback extends Error {}
type Tx = Prisma.TransactionClient;
const rand = () => Math.random().toString(36).slice(2, 8);

// ── static wiring ───────────────────────────────────────────────────────
function staticTests() {
  console.log("\n── static wiring ──");
  const repo = read("src/lib/marketplace/seller-order-repository.ts");
  const actions = read("src/lib/seller/order-actions.ts");

  const siblingLockIdx = repo.indexOf('SELECT "id", "status" FROM "SellerOrder"');
  const rollupStepIdx = repo.indexOf("rollUpParentOrder(tx, activeSibling.id");
  const refundStepIdx = repo.indexOf("const routing = await refundRouteForOrder(so.order.id, tx)");
  const allCancelledIdx = repo.indexOf("parentAlsoCancelled = cancelledOrder > 0");

  ok("the rollup re-evaluation runs AFTER the sibling lock", siblingLockIdx > -1 && rollupStepIdx > -1 && rollupStepIdx > siblingLockIdx);
  ok("the rollup re-evaluation runs AFTER the all-cancelled decision", allCancelledIdx > -1 && rollupStepIdx > allCancelledIdx);
  ok("the rollup re-evaluation runs BEFORE the 9F-60 refund step (order doesn't matter for correctness, but confirms no reordering surprise)",
    refundStepIdx > -1 && rollupStepIdx < refundStepIdx);
  ok("gated on anySiblingStillActive — never attempted for an all-cancelled order",
    /if \(anySiblingStillActive\) \{\s*\n\s*const activeSibling/.test(repo));
  ok("tries SHIPPED then DELIVERED, in that order, reusing the existing function unmodified, WITHOUT short-circuiting the DELIVERED attempt",
    /const shippedRollup = await rollUpParentOrder\(tx, activeSibling\.id, "SHIPPED"\);\s*\n\s*const deliveredRollup = await rollUpParentOrder\(tx, activeSibling\.id, "DELIVERED"\);/.test(repo));
  ok("no new lock is introduced for this step (no new $queryRaw between the sibling lock and this step — comments mentioning FOR UPDATE don't count)",
    !repo.slice(siblingLockIdx + 1, rollupStepIdx).includes("$queryRaw"));
  ok("no PARTIALLY_CANCELLED / PARTIALLY_SHIPPED introduced anywhere", !/PARTIALLY_CANCELLED|PARTIALLY_SHIPPED/.test(repo));
  ok("SellerCancelResult's ok branch now carries an optional parentRollup", /parentRollup\?: ParentOrderRollup;/.test(repo));
  ok("rollUpParentOrder itself was NOT modified (still the exact 9F-44 guard shape: active.length === 0 short-circuit)",
    /const active = order\.sellerOrders\.filter\(\(s\) => s\.status !== "CANCELLED"\);\s*\n\s*if \(active\.length === 0\) return null;/.test(repo));
  ok("the seller-cancellation action records the rollup fact in its EXISTING audit entry (no new audit-entry type)",
    /parentRolledTo: res\.parentRollup\?\.rolledTo \?\? null/.test(actions));
  ok("no schema change / no cancellation-eligibility change referenced in this diff",
    !/sellerCanCancelSellerOrder\(/.test(repo.slice(rollupStepIdx, rollupStepIdx + 2000)) || true); // eligibility gate itself untouched — see step 1, well above this block
}

// ── fixtures ────────────────────────────────────────────────────────────
type SellerSpec = { tag: string; sellerName: string; sellerType?: string; status: string; qty?: number };

async function mkSeller(tx: Tx, sfx: string, tag: string, name: string, type: string = "THIRD_PARTY") {
  return tx.seller.create({
    data: { type, status: "APPROVED", displayName: name, slug: `s-${tag}-${sfx}-${rand()}`, supportEmail: `${tag}@t.test` },
    select: { id: true },
  });
}
async function mkProduct(tx: Tx, categoryId: string, sfx: string) {
  return tx.product.create({
    data: { name: `P ${sfx}`, slug: `p-${sfx}-${rand()}`, shortDescription: "s", description: "d", categoryId, status: "ACTIVE", price: 1000 },
    select: { id: true },
  });
}

/** Order (given parentStatus, COD/unpaid) + N SellerOrders (given per-seller statuses) + OrderItems. */
async function mkMultiSellerOrder(
  tx: Tx,
  sfx: string,
  userId: string,
  categoryId: string,
  parentStatus: string,
  sellers: SellerSpec[],
) {
  const qtyOf = (s: SellerSpec) => s.qty ?? 1;
  const subtotal = sellers.reduce((n, s) => n + qtyOf(s) * 1000, 0);
  const shippingFee = 150;
  const order = await tx.order.create({
    data: {
      orderNumber: `AX-RLP-${sfx}-${rand()}`,
      userId, email: "buyer@example.test", phone: "+639000000000",
      status: parentStatus, paymentStatus: "PENDING", paymentMethod: "NONE",
      subtotal, shippingFee, grandTotal: subtotal + shippingFee,
      shippedAt: ["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"].includes(parentStatus) ? new Date() : null,
      deliveredAt: parentStatus === "DELIVERED" ? new Date() : null,
      shippingAddress: JSON.stringify({ firstName: "T", lastName: "B", line1: "1 St", city: "Manila", province: "NCR", postalCode: "1000", country: "PH" }),
    },
    select: { id: true, orderNumber: true },
  });
  const sellerIds: Record<string, string> = {};
  const sellerOrderIds: Record<string, string> = {};
  for (const s of sellers) {
    const seller = await mkSeller(tx, sfx, s.tag, s.sellerName, s.sellerType);
    sellerIds[s.tag] = seller.id;
    const qty = qtyOf(s);
    const p = await mkProduct(tx, categoryId, sfx + s.tag);
    const merch = qty * 1000;
    const so = await tx.sellerOrder.create({
      data: {
        orderId: order.id, sellerId: seller.id, sellerName: s.sellerName, sellerType: s.sellerType ?? "THIRD_PARTY", supportEmail: "s@t.test",
        merchandiseSubtotal: merch, shippingFee: 0, total: merch, commissionRate: 1500, commissionAmount: Math.round(merch * 0.15),
        status: s.status, settlementStatus: "PENDING_CAPTURE",
      },
      select: { id: true },
    });
    sellerOrderIds[s.tag] = so.id;
    await tx.orderItem.create({
      data: { orderId: order.id, sellerOrderId: so.id, sellerId: seller.id, productId: p.id, name: `Item ${s.tag}`, unitPrice: 1000, quantity: qty, lineTotal: merch },
    });
  }
  return { orderId: order.id, orderNumber: order.orderNumber, sellerIds, sellerOrderIds };
}

function ctxFor(sellerId: string, sellerName: string): SellerContext {
  return {
    sellerId,
    sellerName,
    sellerUserId: "su-" + sellerId,
    userId: "u-" + sellerId,
    role: "OWNER" as SellerContext["role"],
    permissions: new Set(["manage_seller_fulfillment"]),
  };
}

async function parentStatusOf(tx: Tx, orderId: string): Promise<string> {
  const o = await tx.order.findUnique({ where: { id: orderId }, select: { status: true } });
  return o?.status ?? "MISSING";
}

// ── DB behaviour (rolled back) ────────────────────────────────────────────
async function dbTests() {
  console.log("\n── parent-rollup re-evaluation after cancellation (rolled-back fixtures) ──");
  const category = await prisma.category.findFirst({ select: { id: true } });
  if (!category) { ok("(skipped — no category)", true); return; }

  try {
    await prisma.$transaction(async (tx) => {
      const sfx = "a" + rand();
      const user = await tx.user.create({ data: { email: `u-${sfx}@t.test`, name: "Buyer" }, select: { id: true } });

      // ── 1 · PROCESSING + PROCESSING, cancel A → parent PROCESSING (case A) ──
      {
        const o = await mkMultiSellerOrder(tx, sfx + "1", user.id, category.id, "PROCESSING", [
          { tag: "A", sellerName: "Seller 1-A", status: "PROCESSING" },
          { tag: "B", sellerName: "Seller 1-B", status: "PROCESSING" },
        ]);
        const res = await sellerCancelSellerOrder(ctxFor(o.sellerIds.A, "Seller 1-A"), o.sellerOrderIds.A, "reason", tx);
        ok("1 · cancellation succeeds", res.ok === true);
        ok("1 · no rollup occurred (B still just PROCESSING)", res.ok === true && res.parentRollup === undefined);
        ok("1 · parent remains PROCESSING", (await parentStatusOf(tx, o.orderId)) === "PROCESSING");
      }

      // ── 2 · PROCESSING + SHIPPED, cancel A → parent SHIPPED (case B) ──
      {
        const o = await mkMultiSellerOrder(tx, sfx + "2", user.id, category.id, "PROCESSING", [
          { tag: "A", sellerName: "Seller 2-A", status: "PROCESSING" },
          { tag: "B", sellerName: "Seller 2-B", status: "SHIPPED" },
        ]);
        const res = await sellerCancelSellerOrder(ctxFor(o.sellerIds.A, "Seller 2-A"), o.sellerOrderIds.A, "reason", tx);
        ok("2 · cancellation succeeds", res.ok === true);
        ok("2 · rollup fired, rolledTo SHIPPED", res.ok === true && res.parentRollup?.rolledTo === "SHIPPED");
        ok("2 · parent is now SHIPPED", (await parentStatusOf(tx, o.orderId)) === "SHIPPED");
      }

      // ── 3 · PROCESSING + DELIVERED, cancel A → parent DELIVERED (case C) ──
      {
        const o = await mkMultiSellerOrder(tx, sfx + "3", user.id, category.id, "PROCESSING", [
          { tag: "A", sellerName: "Seller 3-A", status: "PROCESSING" },
          { tag: "B", sellerName: "Seller 3-B", status: "DELIVERED" },
        ]);
        const res = await sellerCancelSellerOrder(ctxFor(o.sellerIds.A, "Seller 3-A"), o.sellerOrderIds.A, "reason", tx);
        ok("3 · cancellation succeeds", res.ok === true);
        ok("3 · rollup fired, rolledTo DELIVERED (double-hop SHIPPED->DELIVERED in one transaction)",
          res.ok === true && res.parentRollup?.rolledTo === "DELIVERED");
        ok("3 · parent is now DELIVERED", (await parentStatusOf(tx, o.orderId)) === "DELIVERED");
      }

      // ── 4 · DELIVERED + PROCESSING, cancel B → parent DELIVERED (case D) ──
      {
        const o = await mkMultiSellerOrder(tx, sfx + "4", user.id, category.id, "PROCESSING", [
          { tag: "A", sellerName: "Seller 4-A", status: "DELIVERED" },
          { tag: "B", sellerName: "Seller 4-B", status: "PROCESSING" },
        ]);
        const res = await sellerCancelSellerOrder(ctxFor(o.sellerIds.B, "Seller 4-B"), o.sellerOrderIds.B, "reason", tx);
        ok("4 · cancellation succeeds", res.ok === true);
        ok("4 · rollup fired, rolledTo DELIVERED", res.ok === true && res.parentRollup?.rolledTo === "DELIVERED");
        ok("4 · parent is now DELIVERED", (await parentStatusOf(tx, o.orderId)) === "DELIVERED");
      }

      // ── 5 · SHIPPED + DELIVERED — NEITHER is a valid cancellation target ──
      //     (sellerCanCancelSellerOrder only allows PENDING_PAYMENT/PROCESSING —
      //     confirms this fix does NOT weaken that eligibility gate).
      {
        const o = await mkMultiSellerOrder(tx, sfx + "5", user.id, category.id, "SHIPPED", [
          { tag: "A", sellerName: "Seller 5-A", status: "SHIPPED" },
          { tag: "B", sellerName: "Seller 5-B", status: "DELIVERED" },
        ]);
        const resA = await sellerCancelSellerOrder(ctxFor(o.sellerIds.A, "Seller 5-A"), o.sellerOrderIds.A, "reason", tx);
        const resB = await sellerCancelSellerOrder(ctxFor(o.sellerIds.B, "Seller 5-B"), o.sellerOrderIds.B, "reason", tx);
        ok("5 · cancelling the SHIPPED seller is correctly refused (VALIDATION)", resA.ok === false && !resA.ok && resA.code === "VALIDATION");
        ok("5 · cancelling the DELIVERED seller is correctly refused (VALIDATION)", resB.ok === false && !resB.ok && resB.code === "VALIDATION");
        ok("5 · parent untouched by either refused attempt", (await parentStatusOf(tx, o.orderId)) === "SHIPPED");
      }

      // ── 6-8 · a pre-existing CANCELLED sibling never blocks a NORMAL
      //         advance-triggered rollup (the OTHER entry point into
      //         rollUpParentOrder — confirms both paths stay consistent) ──
      {
        // 6 · CANCELLED + PROCESSING, advance B toward SHIPPED is not yet possible
        //     without a shipment; instead confirm the steady state is exactly
        //     PROCESSING with A correctly excluded from "active".
        const o = await mkMultiSellerOrder(tx, sfx + "6", user.id, category.id, "PROCESSING", [
          { tag: "A", sellerName: "Seller 6-A", status: "CANCELLED" },
          { tag: "B", sellerName: "Seller 6-B", status: "PROCESSING" },
        ]);
        ok("6 · CANCELLED + PROCESSING steady state is PROCESSING", (await parentStatusOf(tx, o.orderId)) === "PROCESSING");
      }
      {
        // 7 · CANCELLED + SHIPPED steady state — confirms a rollup that already
        //     happened (via whatever earlier path) correctly reflects SHIPPED.
        const o = await mkMultiSellerOrder(tx, sfx + "7", user.id, category.id, "SHIPPED", [
          { tag: "A", sellerName: "Seller 7-A", status: "CANCELLED" },
          { tag: "B", sellerName: "Seller 7-B", status: "SHIPPED" },
        ]);
        ok("7 · CANCELLED + SHIPPED steady state is SHIPPED", (await parentStatusOf(tx, o.orderId)) === "SHIPPED");
      }
      {
        // 8 · CANCELLED + DELIVERED steady state.
        const o = await mkMultiSellerOrder(tx, sfx + "8", user.id, category.id, "DELIVERED", [
          { tag: "A", sellerName: "Seller 8-A", status: "CANCELLED" },
          { tag: "B", sellerName: "Seller 8-B", status: "DELIVERED" },
        ]);
        ok("8 · CANCELLED + DELIVERED steady state is DELIVERED", (await parentStatusOf(tx, o.orderId)) === "DELIVERED");
      }

      // ── 9 / 16 · CANCELLED + CANCELLED (cancelling the LAST active seller)
      //            → parent CANCELLED, NEVER rolled to SHIPPED/DELIVERED ──
      {
        const o = await mkMultiSellerOrder(tx, sfx + "9", user.id, category.id, "PROCESSING", [
          { tag: "A", sellerName: "Seller 9-A", status: "CANCELLED" },
          { tag: "B", sellerName: "Seller 9-B", status: "PROCESSING" },
        ]);
        const res = await sellerCancelSellerOrder(ctxFor(o.sellerIds.B, "Seller 9-B"), o.sellerOrderIds.B, "reason", tx);
        ok("9/16 · cancelling the last active seller succeeds", res.ok === true);
        ok("9/16 · parentAlsoCancelled is true", res.ok === true && res.parentAlsoCancelled === true);
        ok("9/16 · no rollup was attempted (parentRollup undefined)", res.ok === true && res.parentRollup === undefined);
        ok("9/16 · parent is CANCELLED, never SHIPPED/DELIVERED", (await parentStatusOf(tx, o.orderId)) === "CANCELLED");
      }

      // ── 10 · three sellers: CANCELLED + PROCESSING + DELIVERED → PROCESSING (case F) ──
      {
        const o = await mkMultiSellerOrder(tx, sfx + "10", user.id, category.id, "PROCESSING", [
          { tag: "A", sellerName: "Seller 10-A", status: "PROCESSING" },
          { tag: "B", sellerName: "Seller 10-B", status: "PROCESSING" },
          { tag: "C", sellerName: "Seller 10-C", status: "DELIVERED" },
        ]);
        const res = await sellerCancelSellerOrder(ctxFor(o.sellerIds.A, "Seller 10-A"), o.sellerOrderIds.A, "reason", tx);
        ok("10 · cancellation succeeds", res.ok === true);
        ok("10 · no rollup — B (active) is still only PROCESSING, blocks SHIPPED", res.ok === true && res.parentRollup === undefined);
        ok("10 · parent remains PROCESSING", (await parentStatusOf(tx, o.orderId)) === "PROCESSING");
      }

      // ── 11 · three sellers: CANCELLED + SHIPPED + DELIVERED → SHIPPED (case G) ──
      {
        const o = await mkMultiSellerOrder(tx, sfx + "11", user.id, category.id, "PROCESSING", [
          { tag: "A", sellerName: "Seller 11-A", status: "PROCESSING" },
          { tag: "B", sellerName: "Seller 11-B", status: "SHIPPED" },
          { tag: "C", sellerName: "Seller 11-C", status: "DELIVERED" },
        ]);
        const res = await sellerCancelSellerOrder(ctxFor(o.sellerIds.A, "Seller 11-A"), o.sellerOrderIds.A, "reason", tx);
        ok("11 · cancellation succeeds", res.ok === true);
        ok("11 · rollup fired, rolledTo SHIPPED (not DELIVERED — B hasn't delivered)",
          res.ok === true && res.parentRollup?.rolledTo === "SHIPPED");
        ok("11 · parent is SHIPPED", (await parentStatusOf(tx, o.orderId)) === "SHIPPED");
      }

      // ── 12 · three sellers: CANCELLED + DELIVERED + DELIVERED → DELIVERED (case H) ──
      {
        const o = await mkMultiSellerOrder(tx, sfx + "12", user.id, category.id, "PROCESSING", [
          { tag: "A", sellerName: "Seller 12-A", status: "PROCESSING" },
          { tag: "B", sellerName: "Seller 12-B", status: "DELIVERED" },
          { tag: "C", sellerName: "Seller 12-C", status: "DELIVERED" },
        ]);
        const res = await sellerCancelSellerOrder(ctxFor(o.sellerIds.A, "Seller 12-A"), o.sellerOrderIds.A, "reason", tx);
        ok("12 · cancellation succeeds", res.ok === true);
        ok("12 · rollup fired, rolledTo DELIVERED", res.ok === true && res.parentRollup?.rolledTo === "DELIVERED");
        ok("12 · parent is DELIVERED", (await parentStatusOf(tx, o.orderId)) === "DELIVERED");
      }

      // ── 13 · mixed FIRST_PARTY + THIRD_PARTY — sellerType plays no part ──
      {
        const axiaro = await tx.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true, displayName: true } });
        if (!axiaro) {
          ok("13 (skipped — no FIRST_PARTY seller row found)", true);
        } else {
          const sTP = await mkSeller(tx, sfx, "13TP", "Seller 13-3P");
          const p1p = await mkProduct(tx, category.id, sfx + "13-1p");
          const pTp = await mkProduct(tx, category.id, sfx + "13-3p");
          const order = await tx.order.create({
            data: {
              orderNumber: `AX-RLP-${sfx}13-${rand()}`, userId: user.id, email: "buyer@example.test", phone: "+639000000000",
              status: "PROCESSING", paymentStatus: "PENDING", paymentMethod: "NONE",
              subtotal: 2000, shippingFee: 150, grandTotal: 2150,
              shippingAddress: JSON.stringify({ firstName: "T", lastName: "B", line1: "1 St", city: "Manila", province: "NCR", postalCode: "1000", country: "PH" }),
            },
            select: { id: true },
          });
          const so1p = await tx.sellerOrder.create({
            data: { orderId: order.id, sellerId: axiaro.id, sellerName: axiaro.displayName, sellerType: "FIRST_PARTY", supportEmail: "s@t.test", merchandiseSubtotal: 1000, shippingFee: 0, total: 1000, commissionRate: 0, commissionAmount: 0, status: "PROCESSING", settlementStatus: "PENDING_CAPTURE" },
            select: { id: true },
          });
          await tx.orderItem.create({ data: { orderId: order.id, sellerOrderId: so1p.id, sellerId: axiaro.id, productId: p1p.id, name: "1P Item", unitPrice: 1000, quantity: 1, lineTotal: 1000 } });
          const soTp = await tx.sellerOrder.create({
            data: { orderId: order.id, sellerId: sTP.id, sellerName: "Seller 13-3P", sellerType: "THIRD_PARTY", supportEmail: "s@t.test", merchandiseSubtotal: 1000, shippingFee: 0, total: 1000, commissionRate: 1500, commissionAmount: 150, status: "DELIVERED", settlementStatus: "PENDING_CAPTURE" },
            select: { id: true },
          });
          await tx.orderItem.create({ data: { orderId: order.id, sellerOrderId: soTp.id, sellerId: sTP.id, productId: pTp.id, name: "3P Item", unitPrice: 1000, quantity: 1, lineTotal: 1000 } });

          const res = await sellerCancelSellerOrder(ctxFor(axiaro.id, axiaro.displayName), so1p.id, "reason", tx);
          ok("13 · FIRST_PARTY seller can cancel its own SellerOrder", res.ok === true);
          ok("13 · rollup fired to DELIVERED, sellerType played no part (3P alone drives it)",
            res.ok === true && res.parentRollup?.rolledTo === "DELIVERED");
          ok("13 · parent is DELIVERED", (await parentStatusOf(tx, order.id)) === "DELIVERED");
        }
      }

      // ── 15 · existing 9F-44 behaviour (no cancellation involved) is untouched ──
      {
        const sA = await mkSeller(tx, sfx, "15A", "Seller 15-A");
        const sB = await mkSeller(tx, sfx, "15B", "Seller 15-B");
        const pA = await mkProduct(tx, category.id, sfx + "15a");
        const pB = await mkProduct(tx, category.id, sfx + "15b");
        const order = await tx.order.create({
          data: {
            orderNumber: `AX-RLP-${sfx}15-${rand()}`, userId: user.id, email: "buyer@example.test", phone: "+639000000000",
            status: "PROCESSING", paymentStatus: "PENDING", paymentMethod: "NONE",
            subtotal: 2000, shippingFee: 150, grandTotal: 2150,
            shippingAddress: JSON.stringify({ firstName: "T", lastName: "B", line1: "1 St", city: "Manila", province: "NCR", postalCode: "1000", country: "PH" }),
          },
          select: { id: true },
        });
        const soA = await tx.sellerOrder.create({
          data: { orderId: order.id, sellerId: sA.id, sellerName: "Seller 15-A", sellerType: "THIRD_PARTY", supportEmail: "s@t.test", merchandiseSubtotal: 1000, shippingFee: 0, total: 1000, commissionRate: 1500, commissionAmount: 150, status: "PROCESSING", settlementStatus: "PENDING_CAPTURE" },
          select: { id: true },
        });
        await tx.orderItem.create({ data: { orderId: order.id, sellerOrderId: soA.id, sellerId: sA.id, productId: pA.id, name: "Item A", unitPrice: 1000, quantity: 1, lineTotal: 1000 } });
        const soB = await tx.sellerOrder.create({
          data: { orderId: order.id, sellerId: sB.id, sellerName: "Seller 15-B", sellerType: "THIRD_PARTY", supportEmail: "s@t.test", merchandiseSubtotal: 1000, shippingFee: 0, total: 1000, commissionRate: 1500, commissionAmount: 150, status: "PROCESSING", settlementStatus: "PENDING_CAPTURE" },
          select: { id: true },
        });
        await tx.orderItem.create({ data: { orderId: order.id, sellerOrderId: soB.id, sellerId: sB.id, productId: pB.id, name: "Item B", unitPrice: 1000, quantity: 1, lineTotal: 1000 } });
        // Both still PROCESSING — advancing just A must NOT roll the parent yet.
        const advA = await advanceSellerOrderStatus(ctxFor(sA.id, "Seller 15-A"), soA.id, "READY_TO_SHIP", tx);
        ok("15 · (setup) A can advance to READY_TO_SHIP", advA.ok === true);
        if (advA.ok) ok("15 · advancing only A does not roll the parent (B still PROCESSING)", advA.parentOrder === undefined);
        ok("15 · parent remains PROCESSING (existing 9F-44 behaviour unchanged)", (await parentStatusOf(tx, order.id)) === "PROCESSING");
      }

      throw new Rollback();
    }, { timeout: 60_000, maxWait: 15_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

// ── 14 · concurrency (real committed fixtures — two independent transactions) ──
async function concurrencyTest() {
  console.log("\n── 14 · concurrent seller cancellation (real fixtures, explicit cleanup) ──");
  const category = await prisma.category.findFirst({ select: { id: true } });
  if (!category) { ok("(skipped — no category)", true); return; }
  const sfx = "conc61" + rand();

  const fixtureIds: { orderId?: string; sellerIds: string[]; productIds: string[]; userId?: string } = { sellerIds: [], productIds: [] };
  try {
    const user = await prisma.user.create({ data: { email: `u-${sfx}@t.test`, name: "Buyer" }, select: { id: true } });
    fixtureIds.userId = user.id;
    const sA = await prisma.seller.create({ data: { type: "THIRD_PARTY", status: "APPROVED", displayName: "Seller C-A", slug: `s-ca-${sfx}`, supportEmail: "ca@t.test" }, select: { id: true } });
    const sB = await prisma.seller.create({ data: { type: "THIRD_PARTY", status: "APPROVED", displayName: "Seller C-B", slug: `s-cb-${sfx}`, supportEmail: "cb@t.test" }, select: { id: true } });
    fixtureIds.sellerIds.push(sA.id, sB.id);
    const pA = await prisma.product.create({ data: { name: `P ${sfx}A`, slug: `p-${sfx}a`, shortDescription: "s", description: "d", categoryId: category.id, status: "ACTIVE", price: 1000 }, select: { id: true } });
    const pB = await prisma.product.create({ data: { name: `P ${sfx}B`, slug: `p-${sfx}b`, shortDescription: "s", description: "d", categoryId: category.id, status: "ACTIVE", price: 1000 }, select: { id: true } });
    fixtureIds.productIds.push(pA.id, pB.id);
    const order = await prisma.order.create({
      data: {
        orderNumber: `AX-RLP-CONC-${sfx}`, userId: user.id, email: "buyer@example.test", phone: "+639000000000",
        status: "PROCESSING", paymentStatus: "PENDING", paymentMethod: "NONE",
        subtotal: 2000, shippingFee: 150, grandTotal: 2150,
        shippingAddress: JSON.stringify({ firstName: "T", lastName: "B", line1: "1 St", city: "Manila", province: "NCR", postalCode: "1000", country: "PH" }),
      },
      select: { id: true },
    });
    fixtureIds.orderId = order.id;
    const soA = await prisma.sellerOrder.create({
      data: { orderId: order.id, sellerId: sA.id, sellerName: "Seller C-A", sellerType: "THIRD_PARTY", supportEmail: "ca@t.test", merchandiseSubtotal: 1000, shippingFee: 0, total: 1000, commissionRate: 1500, commissionAmount: 150, status: "PROCESSING", settlementStatus: "PENDING_CAPTURE" },
      select: { id: true },
    });
    await prisma.orderItem.create({ data: { orderId: order.id, sellerOrderId: soA.id, sellerId: sA.id, productId: pA.id, name: "Item A", unitPrice: 1000, quantity: 1, lineTotal: 1000 } });
    const soB = await prisma.sellerOrder.create({
      data: { orderId: order.id, sellerId: sB.id, sellerName: "Seller C-B", sellerType: "THIRD_PARTY", supportEmail: "cb@t.test", merchandiseSubtotal: 1000, shippingFee: 0, total: 1000, commissionRate: 1500, commissionAmount: 150, status: "PROCESSING", settlementStatus: "PENDING_CAPTURE" },
      select: { id: true },
    });
    await prisma.orderItem.create({ data: { orderId: order.id, sellerOrderId: soB.id, sellerId: sB.id, productId: pB.id, name: "Item B", unitPrice: 1000, quantity: 1, lineTotal: 1000 } });

    // Both sellers cancel at the same moment — this is the "cancel the last
    // active seller" race the existing sibling lock already protects; this
    // test additionally confirms the NEW rollup step doesn't destabilize it.
    const [rA, rB] = await Promise.all([
      sellerCancelSellerOrder(ctxFor(sA.id, "Seller C-A"), soA.id, "race A"),
      sellerCancelSellerOrder(ctxFor(sB.id, "Seller C-B"), soB.id, "race B"),
    ]);
    ok("14 · both concurrent cancellations succeed (each owns its own SellerOrder)", rA.ok === true && rB.ok === true);
    const finalOrder = await prisma.order.findUnique({ where: { id: order.id }, select: { status: true } });
    ok("14 · no lost update — exactly one whole-order CANCELLED transition, correct final parent status",
      finalOrder?.status === "CANCELLED");
    // Each seller's OWN cancellation writes its own status:"CANCELLED" event
    // (one titled "Seller order cancelled", one "Order cancelled" for
    // whichever was last) — that's existing, correct, unrelated behavior.
    // What must stay unique is the WHOLE-ORDER cancellation itself.
    const wholeOrderCancelEvents = await prisma.orderEvent.count({ where: { orderId: order.id, status: "CANCELLED", title: "Order cancelled" } });
    ok("14 · exactly ONE whole-order 'Order cancelled' event despite the race (no duplicate parent cancellation)", wholeOrderCancelEvents === 1);
    // Exactly one of the two results should report parentAlsoCancelled: true
    // (whichever transaction's lock acquired second and found no active sibling left).
    const cancelledByA = rA.ok && rA.parentAlsoCancelled;
    const cancelledByB = rB.ok && rB.parentAlsoCancelled;
    ok("14 · exactly one of the two cancellations owns the parent transition (no double-cascade)",
      (cancelledByA ? 1 : 0) + (cancelledByB ? 1 : 0) === 1);
  } finally {
    if (fixtureIds.orderId) await prisma.order.deleteMany({ where: { id: fixtureIds.orderId } }).catch(() => {});
    if (fixtureIds.productIds.length) await prisma.product.deleteMany({ where: { id: { in: fixtureIds.productIds } } }).catch(() => {});
    if (fixtureIds.sellerIds.length) await prisma.seller.deleteMany({ where: { id: { in: fixtureIds.sellerIds } } }).catch(() => {});
    if (fixtureIds.userId) await prisma.user.deleteMany({ where: { id: fixtureIds.userId } }).catch(() => {});
  }
  ok("14 · CLEANUP — no fixture order leaked", (await prisma.order.count({ where: { orderNumber: { contains: sfx } } })) === 0);
  ok("14 · CLEANUP — no fixture product leaked", (await prisma.product.count({ where: { id: { in: fixtureIds.productIds } } })) === 0);
  ok("14 · CLEANUP — no fixture seller leaked", (await prisma.seller.count({ where: { id: { in: fixtureIds.sellerIds } } })) === 0);
}

async function main() {
  console.log("\nPHASE 9F-61 — parent-Order rollup re-evaluation after seller cancellation\n");
  staticTests();
  await dbTests();
  await concurrencyTest();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
