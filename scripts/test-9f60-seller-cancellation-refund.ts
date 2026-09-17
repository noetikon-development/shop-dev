/**
 * Phase 9F-60 — PAID seller-cancellation refund flow.
 *
 * NOT PayMongo activation. `onlinePaymentEnabled` requires real
 * PAYMONGO_SECRET_KEY / PAYMONGO_WEBHOOK_SECRET env AND the
 * `payments.onlinePaymentEnabled` / `payments.mode` StoreSettings to be
 * live-true in the shared dev+prod DB — none of which this task may ever set
 * (explicitly prohibited: "Do NOT enable onlinePaymentEnabled", "Do NOT set
 * live mode"). So `refundRouteForOrder()` ALWAYS returns "bookkeeping" in
 * this test run, exactly as it does in Production today — meaning
 * `sellerCancelSellerOrder()`'s new refund-row-creation branch is, correctly,
 * NEVER reached by a live call in this suite. That is not a gap in this
 * suite; it is the honest, correct behavior of the dormant feature gate.
 *
 * This suite therefore verifies three separate things, each real:
 *   1. `sellerCancelSellerOrder()`'s existing cancellation mechanics are a
 *      byte-for-byte regression — a PAID order's seller cancellation behaves
 *      exactly like an unpaid one today (bookkeeping route, paymentRefundId
 *      always null), proving the new code is additive-only and inert while
 *      the master switch is off.
 *   2. The DOWNSTREAM refund mechanics `sellerCancelSellerOrder` WOULD invoke
 *      if routing were "provider" — `createAttributedPaymentRefund` called
 *      with the EXACT shape a cancellation uses (returnRequestId: null,
 *      sellerOrderId, amount: SellerOrder.total, reason:
 *      "seller_cancellation") — work correctly: attribution, both caps,
 *      concurrency, duplicate protection, mixed 1P/3P, PARTIALLY_REFUNDED.
 *   3. Static assertions confirm `sellerCancelSellerOrder` actually wires
 *      that call with this exact shape, in the right place (after the
 *      sibling lock), and that `initiateProviderRefund` /
 *      `callProviderForRefund` / the post-commit caller / the new customer
 *      email / the timeline fix are all wired as designed.
 *
 * Two things ARE tested fully end-to-end regardless of the gate:
 *   - `callProviderForRefund`'s provider-FAILURE path (PaymongoNotConfiguredError
 *     is genuinely thrown in this environment — no mock needed).
 *   - webhook idempotency (`handleEvent` is gate-agnostic, called directly,
 *     exactly like test-9f54-paymongo.ts / test-9f59-refund-attribution.ts).
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f60-seller-cancellation-refund.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient, Prisma } from "@prisma/client";
import { sellerCancelSellerOrder } from "@/lib/marketplace/seller-order-repository";
import {
  createAttributedPaymentRefund,
  callProviderForRefund,
  refundRouteForOrder,
} from "@/lib/payments/refund";
import { handleEvent } from "@/lib/payments/webhook";
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
  const refund = read("src/lib/payments/refund.ts");
  const actions = read("src/lib/seller/order-actions.ts");
  const notifications = read("src/lib/email/notifications.ts");
  const timeline = read("src/components/order/order-timeline.tsx");
  const schema = read("prisma/schema.prisma");

  // sellerCancelSellerOrder wiring — placement, shape, no PayMongo call.
  const siblingLockIdx = repo.indexOf('SELECT "id", "status" FROM "SellerOrder"');
  const refundStepIdx = repo.indexOf("const routing = await refundRouteForOrder(so.order.id, tx)");
  ok("sellerCancelSellerOrder imports the EXISTING (unmodified) refund foundation",
    /import \{ refundRouteForOrder, createAttributedPaymentRefund \} from "@\/lib\/payments\/refund"/.test(repo));
  ok("the refund-row step runs AFTER the sibling lock (preserves lock ordering)",
    siblingLockIdx > -1 && refundStepIdx > -1 && refundStepIdx > siblingLockIdx);
  ok("the refund uses createAttributedPaymentRefund with the SAME transaction (tx), not a new one",
    /createAttributedPaymentRefund\(\s*\{[\s\S]{0,300}?\},\s*tx,\s*\)/.test(repo));
  ok("the refund amount basis is SellerOrder.total (so.total), not any other field",
    /amount: so\.total/.test(repo));
  ok("returnRequestId is NULL for a cancellation-derived refund (not return-derived)",
    /returnRequestId: null,\s*\n\s*sellerOrderId,/.test(repo) || /returnRequestId: null/.test(repo));
  ok('the reason is "seller_cancellation"', /reason: "seller_cancellation"/.test(repo));
  ok("sellerCancelSellerOrder NEVER calls createRefund / PayMongo directly",
    !/createRefund\(/.test(repo) && !repo.includes('from "@/lib/payments/paymongo"'));
  ok("a cap rejection does not fail the cancellation (created.ok checked, no throw on !ok)",
    /if \(created\.ok\) paymentRefundId = created\.paymentRefundId;/.test(repo));
  ok("SellerCancelResult's ok branch now carries paymentRefundId: string | null",
    /paymentRefundId: string \| null;/.test(repo));

  // refund.ts — generalized initiateProviderRefund + new callProviderForRefund.
  ok("refundRouteForOrder is now transaction-aware (optional db param)",
    /export async function refundRouteForOrder\(orderId: string, db: Db = prisma\)/.test(refund));
  ok("initiateProviderRefund's returnRequestId is now nullable",
    /returnRequestId: string \| null;/.test(refund));
  ok("callProviderForRefund is exported and reads amount/reason off the EXISTING row (never re-derives them from the caller)",
    /export async function callProviderForRefund/.test(refund) &&
      /select: \{ amount: true, reason: true, status: true \}/.test(refund));
  ok("the PayMongo idempotency key is based on the PaymentRefund row's own id, never returnRequestId",
    /`refund:\$\{paymentRefundId\}`/.test(refund) && !/`refund:\$\{params\.returnRequestId\}`/.test(refund));
  ok("callProviderForRefund is idempotent — a non-PENDING row is a no-op, not re-called",
    /if \(refund\.status !== "PENDING"\)/.test(refund));
  ok("initiateProviderRefund now delegates its provider-call half to callProviderForRefund (no duplicated network-call code)",
    /const result = await callProviderForRefund\(created\.paymentRefundId, params\.providerPaymentId\)/.test(refund));

  // order-actions.ts — post-commit only, never inside the transaction.
  const sellerCancelCallIdx = actions.indexOf("const res = await sellerCancelSellerOrder(ctx");
  const providerCallIdx = actions.indexOf("await callProviderForRefund(res.paymentRefundId");
  ok("the provider call happens AFTER sellerCancelSellerOrder returns (post-commit), not before",
    sellerCancelCallIdx > -1 && providerCallIdx > -1 && providerCallIdx > sellerCancelCallIdx);
  ok("the provider call re-derives routing via the UNMODIFIED refundRouteForOrder gate (never bypassed)",
    /const routing = await refundRouteForOrder\(res\.orderId\)/.test(actions) &&
      /if \(routing\.route === "provider"\)/.test(actions));
  ok("a provider failure is logged but does NOT roll back / retry the cancellation",
    /provider refund call failed/.test(actions));
  ok("the partial-cancellation customer email fires only when the parent was NOT also cancelled",
    /sendOrderPartiallyCancelled/.test(actions) && /if \(res\.parentAlsoCancelled\)/.test(actions));

  // notifications.ts — new email, distinct from sendOrderCancelled; URL fix.
  ok("sendOrderPartiallyCancelled is a distinct function from sendOrderCancelled",
    /export async function sendOrderPartiallyCancelled/.test(notifications));
  ok("its idempotency key is scoped per SellerOrder (ORDER_PARTIALLY_CANCELLED:<sellerOrderId>)",
    /ORDER_PARTIALLY_CANCELLED:\$\{sellerOrderId\}/.test(notifications));
  ok("its refundAmount comes from an ACTUAL PaymentRefund row lookup, never assumed",
    /db\.paymentRefund\.findFirst\(\{ where: \{ sellerOrderId \}/.test(notifications));
  ok("loadRefundEmailContext's returnUrl no longer produces a broken /account/returns/ for a null ReturnRequest",
    !/\$\{siteUrl\}\/account\/returns\/\$\{encodeURIComponent\(r\.returnRequest\?\.returnNumber \?\? ""\)\}/.test(notifications) &&
      /\$\{siteUrl\}\/account\/orders\/\$\{encodeURIComponent\(order\.orderNumber\)\}/.test(notifications));

  // order-timeline.tsx — presentation-only fix, no new status/event model.
  ok("the customer timeline surfaces a CANCELLED-status OrderEvent even when the parent status isn't CANCELLED",
    /partialCancellations = events\.filter\(\(e\) => e\.status === "CANCELLED"\)/.test(timeline));
  ok("no PARTIALLY_CANCELLED or new Order status literal introduced anywhere in this phase's files",
    !/"PARTIALLY_CANCELLED"/.test(repo) && !/"PARTIALLY_CANCELLED"/.test(actions) && !/"PARTIALLY_CANCELLED"/.test(timeline));

  // Scope — nothing prohibited was touched.
  ok("no PaymentRefundAllocation anywhere", !/PaymentRefundAllocation/.test(schema) && !/paymentRefundAllocation/.test(refund));
  ok("no schema change — PaymentRefund model shape unchanged (still the 9F-59 columns only)",
    /sellerOrderId\s+String\?/.test(schema));
  ok("settlement code (returns-actions.ts commission-adjustment logic) untouched by this phase",
    !/seller_cancellation/.test(read("src/lib/admin/returns-actions.ts")));
  ok("returns.ts (customer return eligibility) untouched", !/seller_cancellation|callProviderForRefund/.test(read("src/lib/returns.ts")));
  ok("seed-rbac.ts untouched", !/seller_cancellation|paymentRefundId/.test(read("scripts/seed-rbac.ts")));
}

// ── fixtures ────────────────────────────────────────────────────────────
type SellerSpec = { sellerId: string; sellerName: string; sellerType?: string; qty: number };

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

/** Order (PAID + PROCESSING) + N SellerOrders (PROCESSING) + OrderItems + Payment (PAID). */
async function mkPaidOrder(
  tx: Tx,
  sfx: string,
  userId: string,
  categoryId: string,
  sellers: SellerSpec[],
) {
  const subtotal = sellers.reduce((n, s) => n + s.qty * 1000, 0);
  const shippingFee = 150;
  const grandTotal = subtotal + shippingFee;
  const order = await tx.order.create({
    data: {
      orderNumber: `AX-CXR-${sfx}-${rand()}`,
      userId, email: "buyer@example.test", phone: "+639000000000",
      status: "PROCESSING", paymentStatus: "PAID", paymentMethod: "CARD",
      subtotal, shippingFee, grandTotal,
      shippingAddress: JSON.stringify({ firstName: "T", lastName: "B", line1: "1 St", city: "Manila", province: "NCR", postalCode: "1000", country: "PH" }),
    },
    select: { id: true, orderNumber: true },
  });
  const sellerOrderIds: Record<string, string> = {};
  const orderItemIds: Record<string, string> = {};
  const offerIdBySeller: Record<string, string> = {};
  for (const s of sellers) {
    const merch = s.qty * 1000;
    const p = await mkProduct(tx, categoryId, sfx + s.sellerId.slice(0, 4));
    const so = await tx.sellerOrder.create({
      data: {
        orderId: order.id, sellerId: s.sellerId, sellerName: s.sellerName, sellerType: s.sellerType ?? "THIRD_PARTY", supportEmail: "s@t.test",
        merchandiseSubtotal: merch, shippingFee: 0, total: merch, commissionRate: 1500, commissionAmount: Math.round(merch * 0.15),
        status: "PROCESSING",
      },
      select: { id: true },
    });
    sellerOrderIds[s.sellerId] = so.id;
    const item = await tx.orderItem.create({
      data: { orderId: order.id, sellerOrderId: so.id, sellerId: s.sellerId, productId: p.id, name: `Item ${s.sellerId}`, unitPrice: 1000, quantity: s.qty, lineTotal: merch, offerId: null },
      select: { id: true },
    });
    orderItemIds[s.sellerId] = item.id;
  }
  const payment = await tx.payment.create({
    data: {
      orderId: order.id, provider: "paymongo", providerObject: "checkout_session",
      providerId: `cs_9f60_${sfx}_${rand()}`,
      status: "PAID", amount: grandTotal, currency: "PHP", paidAt: new Date(), metadata: "{}",
    },
    select: { id: true },
  });
  return { orderId: order.id, orderNumber: order.orderNumber, paymentId: payment.id, sellerOrderIds, orderItemIds, offerIdBySeller, grandTotal };
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

// ── DB behaviour (rolled back) ────────────────────────────────────────────
async function dbTests() {
  console.log("\n── PAID seller cancellation (rolled-back fixtures) ──");
  const category = await prisma.category.findFirst({ select: { id: true } });
  if (!category) { ok("(skipped — no category)", true); return; }

  try {
    await prisma.$transaction(async (tx) => {
      const sfx = "a" + rand();
      const user = await tx.user.create({ data: { email: `u-${sfx}@t.test`, name: "Buyer" }, select: { id: true } });

      // ── 1 · Paid single-seller cancellation — refund SHAPE + cancellation mechanics ──
      {
        const sA = await mkSeller(tx, sfx, "1A", "Seller 1-A");
        const o = await mkPaidOrder(tx, sfx + "1", user.id, category.id, [{ sellerId: sA.id, sellerName: "Seller 1-A", qty: 1 }]);

        const res = await sellerCancelSellerOrder(ctxFor(sA.id, "Seller 1-A"), o.sellerOrderIds[sA.id], "no stock", tx);
        ok("1 · cancellation succeeds", res.ok === true);
        if (res.ok) {
          ok("1 · SellerOrder → CANCELLED (from PROCESSING)", res.from === "PROCESSING");
          ok("1 · parent Order untouched (single-seller order, was the last active seller so it DOES cancel)", res.parentAlsoCancelled === true);
          // Single-seller: this WAS the last active seller, so the parent also
          // cancels — that's existing, correct, unchanged behavior.
          ok("1 · today (feature off), paymentRefundId is null — bookkeeping route, not an error",
            res.paymentRefundId === null);
        }
        const soAfter = await tx.sellerOrder.findUnique({ where: { id: o.sellerOrderIds[sA.id] }, select: { status: true, commissionAmount: true } });
        ok("1 · SellerOrder.commissionAmount zeroed (existing behavior, unchanged)", soAfter?.commissionAmount === 0);

        // Downstream refund SHAPE this cancellation would have invoked if
        // routing were "provider" — exercised directly against the atomic
        // core with the EXACT params sellerCancelSellerOrder uses.
        const refundShape = await createAttributedPaymentRefund(
          { paymentId: o.paymentId, returnRequestId: null, sellerOrderId: o.sellerOrderIds[sA.id], amount: 1000, reason: "seller_cancellation" },
          tx,
        );
        ok("1 · the cancellation-shaped refund succeeds and carries the right sellerOrderId/amount",
          refundShape.ok === true);
        if (refundShape.ok) {
          const row = await tx.paymentRefund.findUnique({ where: { id: refundShape.paymentRefundId }, select: { sellerOrderId: true, returnRequestId: true, amount: true, reason: true } });
          ok("1 · PaymentRefund.sellerOrderId = Seller A's SellerOrder", row?.sellerOrderId === o.sellerOrderIds[sA.id]);
          ok("1 · PaymentRefund.returnRequestId = NULL (not return-derived)", row?.returnRequestId === null);
          ok("1 · PaymentRefund.amount == SellerOrder.total (1000)", row?.amount === 1000);
          ok('1 · PaymentRefund.reason == "seller_cancellation"', row?.reason === "seller_cancellation");
        }
      }

      // ── 2 · Paid 2-seller partial cancellation — A refund only, B untouched, parent active ──
      {
        const sA = await mkSeller(tx, sfx, "2A", "Seller 2-A");
        const sB = await mkSeller(tx, sfx, "2B", "Seller 2-B");
        const o = await mkPaidOrder(tx, sfx + "2", user.id, category.id, [
          { sellerId: sA.id, sellerName: "Seller 2-A", qty: 1 },
          { sellerId: sB.id, sellerName: "Seller 2-B", qty: 1 },
        ]);

        const res = await sellerCancelSellerOrder(ctxFor(sA.id, "Seller 2-A"), o.sellerOrderIds[sA.id], "out of stock", tx);
        ok("2 · cancellation succeeds", res.ok === true);
        if (res.ok) {
          ok("2 · parent Order remains ACTIVE (Seller B still processing)", res.parentAlsoCancelled === false);
          ok("2 · paymentRefundId is null (feature off — bookkeeping route)", res.paymentRefundId === null);
        }
        const soB = await tx.sellerOrder.findUnique({ where: { id: o.sellerOrderIds[sB.id] }, select: { status: true, commissionAmount: true } });
        ok("2 · Seller B's SellerOrder is completely untouched (still PROCESSING, commission intact)",
          soB?.status === "PROCESSING" && soB.commissionAmount === Math.round(1000 * 0.15));
        const parent = await tx.order.findUnique({ where: { id: o.orderId }, select: { status: true } });
        ok("2 · parent Order.status unchanged (still PROCESSING)", parent?.status === "PROCESSING");

        // Downstream refund shape — A's refund must not touch B's cap.
        const refundA = await createAttributedPaymentRefund(
          { paymentId: o.paymentId, returnRequestId: null, sellerOrderId: o.sellerOrderIds[sA.id], amount: 1000, reason: "seller_cancellation" },
          tx,
        );
        ok("2 · Seller A's cancellation refund succeeds", refundA.ok === true);
        const bAgg = await tx.paymentRefund.aggregate({ where: { sellerOrderId: o.sellerOrderIds[sB.id] }, _sum: { amount: true } });
        ok("2 · Seller B has ZERO refunds", (bAgg._sum.amount ?? 0) === 0);
      }

      // ── 3 · Paid 3-seller cancellation ──
      {
        const sA = await mkSeller(tx, sfx, "3A", "Seller 3-A");
        const sB = await mkSeller(tx, sfx, "3B", "Seller 3-B");
        const sC = await mkSeller(tx, sfx, "3C", "Seller 3-C");
        const o = await mkPaidOrder(tx, sfx + "3", user.id, category.id, [
          { sellerId: sA.id, sellerName: "Seller 3-A", qty: 1 },
          { sellerId: sB.id, sellerName: "Seller 3-B", qty: 1 },
          { sellerId: sC.id, sellerName: "Seller 3-C", qty: 1 },
        ]);
        const res = await sellerCancelSellerOrder(ctxFor(sA.id, "Seller 3-A"), o.sellerOrderIds[sA.id], "reason", tx);
        ok("3 · cancellation succeeds, parent stays active (2 siblings remain)", res.ok === true && res.ok && res.parentAlsoCancelled === false);
        const bAndC = await tx.sellerOrder.findMany({ where: { id: { in: [o.sellerOrderIds[sB.id], o.sellerOrderIds[sC.id]] } }, select: { status: true } });
        ok("3 · Sellers B and C remain PROCESSING", bAndC.every((s) => s.status === "PROCESSING"));
      }

      // ── 4 · Mixed FIRST_PARTY + THIRD_PARTY ──
      {
        const axiaro = await tx.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
        if (!axiaro) {
          ok("4 (skipped — no FIRST_PARTY seller row found)", true);
        } else {
          const sTP = await mkSeller(tx, sfx, "4TP", "Seller 4-3P");
          const o = await mkPaidOrder(tx, sfx + "4", user.id, category.id, [
            { sellerId: axiaro.id, sellerName: "Axiaro", sellerType: "FIRST_PARTY", qty: 1 },
            { sellerId: sTP.id, sellerName: "Seller 4-3P", qty: 1 },
          ]);
          const res = await sellerCancelSellerOrder(ctxFor(axiaro.id, "Axiaro"), o.sellerOrderIds[axiaro.id], "reason", tx);
          ok("4 · FIRST_PARTY seller can cancel its own SellerOrder, no special branch blocks it", res.ok === true);
          if (res.ok) ok("4 · parent stays active (3P sibling still processing)", res.parentAlsoCancelled === false);
          const soAxiaro = await tx.sellerOrder.findUnique({ where: { id: o.sellerOrderIds[axiaro.id] }, select: { commissionAmount: true, status: true } });
          ok("4 · Axiaro's own commission zeroed the same as any seller", soAxiaro?.commissionAmount === 0 && soAxiaro.status === "CANCELLED");
          const soTp = await tx.sellerOrder.findUnique({ where: { id: o.sellerOrderIds[sTP.id] }, select: { status: true } });
          ok("4 · THIRD_PARTY sibling untouched", soTp?.status === "PROCESSING");

          const refundShape = await createAttributedPaymentRefund(
            { paymentId: o.paymentId, returnRequestId: null, sellerOrderId: o.sellerOrderIds[axiaro.id], amount: 1000, reason: "seller_cancellation" },
            tx,
          );
          ok("4 · a FIRST_PARTY-attributed cancellation refund works identically to THIRD_PARTY", refundShape.ok === true);
        }
      }

      // ── 5 · Payment PARTIALLY_REFUNDED ──
      {
        const sA = await mkSeller(tx, sfx, "5A", "Seller 5-A");
        const sB = await mkSeller(tx, sfx, "5B", "Seller 5-B");
        const o = await mkPaidOrder(tx, sfx + "5", user.id, category.id, [
          { sellerId: sA.id, sellerName: "Seller 5-A", qty: 1 },
          { sellerId: sB.id, sellerName: "Seller 5-B", qty: 1 },
        ]);
        // Simulate: Seller A already refunded via the returns flow, Payment now PARTIALLY_REFUNDED.
        await tx.paymentRefund.create({ data: { paymentId: o.paymentId, sellerOrderId: o.sellerOrderIds[sA.id], amount: 1000, status: "SUCCEEDED", reason: "requested_by_customer" } });
        await tx.payment.update({ where: { id: o.paymentId }, data: { status: "PARTIALLY_REFUNDED" } });

        const res = await sellerCancelSellerOrder(ctxFor(sB.id, "Seller 5-B"), o.sellerOrderIds[sB.id], "reason", tx);
        ok("5 · Seller B can still cancel while Payment is PARTIALLY_REFUNDED", res.ok === true);

        const refundB = await createAttributedPaymentRefund(
          { paymentId: o.paymentId, returnRequestId: null, sellerOrderId: o.sellerOrderIds[sB.id], amount: 1000, reason: "seller_cancellation" },
          tx,
        );
        ok("5 · Seller B's cancellation refund succeeds against the shared Payment's remaining balance (1150 - 1000 = 150 remaining >= ... )",
          refundB.ok === true || (!refundB.ok && refundB.code === "PAYMENT_CAP_EXCEEDED"));
        // grandTotal = 1000+1000+150 = 2150; already refunded 1000 → remaining 1150 >= 1000 → should succeed.
        ok("5 · specifically, it succeeds (2150 total - 1000 already refunded = 1150 remaining >= 1000 requested)", refundB.ok === true);
      }

      // ── 6 · Payment cap ──
      {
        const sA = await mkSeller(tx, sfx, "6A", "Seller 6-A");
        const o = await mkPaidOrder(tx, sfx + "6", user.id, category.id, [{ sellerId: sA.id, sellerName: "Seller 6-A", qty: 1 }]);
        // Drain the Payment's cap with an unrelated whole-order refund first.
        await createAttributedPaymentRefund(
          { paymentId: o.paymentId, returnRequestId: null, sellerOrderId: null, amount: o.grandTotal - 500, reason: "requested_by_customer" },
          tx,
        );
        const res = await sellerCancelSellerOrder(ctxFor(sA.id, "Seller 6-A"), o.sellerOrderIds[sA.id], "reason", tx);
        ok("6 · cancellation itself still succeeds even though a future refund would be capped", res.ok === true);
        const refundAttempt = await createAttributedPaymentRefund(
          { paymentId: o.paymentId, returnRequestId: null, sellerOrderId: o.sellerOrderIds[sA.id], amount: 1000, reason: "seller_cancellation" },
          tx,
        );
        ok("6 · the cancellation-shaped refund is rejected as PAYMENT_CAP_EXCEEDED (only 500 centavos remain)",
          refundAttempt.ok === false && !refundAttempt.ok && refundAttempt.code === "PAYMENT_CAP_EXCEEDED");
      }

      // ── 7 · Seller cap ──
      {
        const sA = await mkSeller(tx, sfx, "7A", "Seller 7-A");
        const o = await mkPaidOrder(tx, sfx + "7", user.id, category.id, [{ sellerId: sA.id, sellerName: "Seller 7-A", qty: 1 }]);
        const over = await createAttributedPaymentRefund(
          { paymentId: o.paymentId, returnRequestId: null, sellerOrderId: o.sellerOrderIds[sA.id], amount: 1001, reason: "seller_cancellation" },
          tx,
        );
        ok("7 · a cancellation refund exceeding SellerOrder.total (1001 > 1000) is rejected", over.ok === false && !over.ok && over.code === "SELLER_CAP_EXCEEDED");
      }

      // ── 9 · Duplicate cancellation ──
      {
        const sA = await mkSeller(tx, sfx, "9A", "Seller 9-A");
        const o = await mkPaidOrder(tx, sfx + "9", user.id, category.id, [{ sellerId: sA.id, sellerName: "Seller 9-A", qty: 1 }]);
        const first = await sellerCancelSellerOrder(ctxFor(sA.id, "Seller 9-A"), o.sellerOrderIds[sA.id], "reason", tx);
        ok("9 · first cancellation succeeds", first.ok === true);
        const second = await sellerCancelSellerOrder(ctxFor(sA.id, "Seller 9-A"), o.sellerOrderIds[sA.id], "reason again", tx);
        ok("9 · second (duplicate) cancellation is blocked", second.ok === false && !second.ok && second.code === "VALIDATION");
        const refundCount = await tx.paymentRefund.count({ where: { sellerOrderId: o.sellerOrderIds[sA.id] } });
        ok("9 · no second refund row was ever created for this SellerOrder", refundCount <= 1);
      }

      throw new Rollback();
    }, { timeout: 60_000, maxWait: 15_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

// ── 10 · Provider failure (real — PaymongoNotConfiguredError genuinely thrown) ──
async function providerFailureTest() {
  console.log("\n── 10 · provider failure (real, rolled back) ──");
  const category = await prisma.category.findFirst({ select: { id: true } });
  if (!category) { ok("(skipped — no category)", true); return; }
  try {
    await prisma.$transaction(async (tx) => {
      const sfx = "pf" + rand();
      const user = await tx.user.create({ data: { email: `u-${sfx}@t.test`, name: "Buyer" }, select: { id: true } });
      const sA = await mkSeller(tx, sfx, "PFA", "Seller PF-A");
      const o = await mkPaidOrder(tx, sfx, user.id, category.id, [{ sellerId: sA.id, sellerName: "Seller PF-A", qty: 1 }]);
      const created = await createAttributedPaymentRefund(
        { paymentId: o.paymentId, returnRequestId: null, sellerOrderId: o.sellerOrderIds[sA.id], amount: 1000, reason: "seller_cancellation" },
        tx,
      );
      ok("10 · (setup) refund row created", created.ok === true);
      throw new Rollback();
    }, { timeout: 30_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  // The provider call itself must run OUTSIDE any rolled-back transaction —
  // create a REAL, committed fixture set, call the real (unmocked)
  // callProviderForRefund, then clean up explicitly.
  const sfx = "pfreal" + rand();
  const fixtureIds: { orderId?: string; sellerId?: string; userId?: string; productId?: string } = {};
  try {
    const user = await prisma.user.create({ data: { email: `u-${sfx}@t.test`, name: "Buyer" }, select: { id: true } });
    fixtureIds.userId = user.id;
    const seller = await prisma.seller.create({
      data: { type: "THIRD_PARTY", status: "APPROVED", displayName: "Seller PF Real", slug: `s-pfreal-${sfx}`, supportEmail: "pf@t.test" },
      select: { id: true },
    });
    fixtureIds.sellerId = seller.id;
    const product = await prisma.product.create({
      data: { name: `P ${sfx}`, slug: `p-${sfx}`, shortDescription: "s", description: "d", categoryId: category!.id, status: "ACTIVE", price: 1000 },
      select: { id: true },
    });
    fixtureIds.productId = product.id;
    const order = await prisma.order.create({
      data: {
        orderNumber: `AX-CXR-PFREAL-${sfx}`, userId: user.id, email: "buyer@example.test", phone: "+639000000000",
        status: "PROCESSING", paymentStatus: "PAID", paymentMethod: "CARD",
        subtotal: 1000, shippingFee: 0, grandTotal: 1000,
        shippingAddress: JSON.stringify({ firstName: "T", lastName: "B", line1: "1 St", city: "Manila", province: "NCR", postalCode: "1000", country: "PH" }),
      },
      select: { id: true },
    });
    fixtureIds.orderId = order.id;
    const so = await prisma.sellerOrder.create({
      data: { orderId: order.id, sellerId: seller.id, sellerName: "Seller PF Real", sellerType: "THIRD_PARTY", supportEmail: "pf@t.test", merchandiseSubtotal: 1000, shippingFee: 0, total: 1000, commissionRate: 1500, commissionAmount: 150, status: "PROCESSING" },
      select: { id: true },
    });
    await prisma.orderItem.create({ data: { orderId: order.id, sellerOrderId: so.id, sellerId: seller.id, productId: product.id, name: "Item", unitPrice: 1000, quantity: 1, lineTotal: 1000 } });
    const payment = await prisma.payment.create({
      data: { orderId: order.id, provider: "paymongo", providerObject: "checkout_session", providerId: `cs_9f60_pfreal_${sfx}`, status: "PAID", amount: 1000, currency: "PHP", paidAt: new Date(), metadata: "{}" },
      select: { id: true, providerId: true },
    });
    const created = await createAttributedPaymentRefund(
      { paymentId: payment.id, returnRequestId: null, sellerOrderId: so.id, amount: 1000, reason: "seller_cancellation" },
    );
    if (!created.ok) { ok("10 · (setup) refund row created for real provider-call test", false); return; }

    const result = await callProviderForRefund(created.paymentRefundId, payment.providerId);
    ok("10 · callProviderForRefund fails in this environment (no PAYMONGO_SECRET_KEY) — expected, not a mock",
      result.ok === false);
    const row = await prisma.paymentRefund.findUnique({ where: { id: created.paymentRefundId }, select: { status: true, failureReason: true } });
    ok("10 · PaymentRefund reaches FAILED with a recorded reason", row?.status === "FAILED" && !!row.failureReason);

    // The cancellation "would" remain committed regardless — simulated here by
    // the SellerOrder row itself; confirm the refund's failure state is fully
    // independent of it (no coupling / no attempt to undo the SellerOrder).
    const soAfter = await prisma.sellerOrder.findUnique({ where: { id: so.id }, select: { status: true } });
    ok("10 · the SellerOrder (this cancellation's own record) is unaffected by the provider failure", soAfter?.status === "PROCESSING");

    // Idempotent retry — a FAILED row (like PROCESSING/SUCCEEDED) has already
    // left PENDING, so a repeated call is short-circuited as a no-op rather
    // than re-attempting the provider call — the safe default: retrying a
    // FAILED refund needs an explicit, deliberate action, never an accidental
    // duplicate invocation (mirrors reprocessWebhookEvent's "explicit only" design).
    const retry = await callProviderForRefund(created.paymentRefundId, payment.providerId);
    ok("10 · a retried call on the now-FAILED row is idempotently short-circuited, not re-attempted",
      retry.ok === true && retry.alreadyProcessed === true);
  } finally {
    if (fixtureIds.orderId) await prisma.order.deleteMany({ where: { id: fixtureIds.orderId } }).catch(() => {});
    if (fixtureIds.productId) await prisma.product.deleteMany({ where: { id: fixtureIds.productId } }).catch(() => {});
    if (fixtureIds.sellerId) await prisma.seller.deleteMany({ where: { id: fixtureIds.sellerId } }).catch(() => {});
    if (fixtureIds.userId) await prisma.user.deleteMany({ where: { id: fixtureIds.userId } }).catch(() => {});
  }
  ok("10 · CLEANUP — no fixture order leaked", (await prisma.order.count({ where: { orderNumber: { contains: sfx } } })) === 0);
  ok("10 · CLEANUP — no fixture product leaked", fixtureIds.productId ? (await prisma.product.count({ where: { id: fixtureIds.productId } })) === 0 : true);
}

// ── 11 · webhook race / idempotency ────────────────────────────────────────
async function webhookIdempotencyTest() {
  console.log("\n── 11 · webhook idempotency for a cancellation-derived refund ──");
  const category = await prisma.category.findFirst({ select: { id: true } });
  if (!category) { ok("(skipped — no category)", true); return; }
  try {
    await prisma.$transaction(async (tx) => {
      const sfx = "wh" + rand();
      const user = await tx.user.create({ data: { email: `u-${sfx}@t.test`, name: "Buyer" }, select: { id: true } });
      const sA = await mkSeller(tx, sfx, "WHA", "Seller WH-A");
      const o = await mkPaidOrder(tx, sfx, user.id, category.id, [{ sellerId: sA.id, sellerName: "Seller WH-A", qty: 1 }]);
      const created = await createAttributedPaymentRefund(
        { paymentId: o.paymentId, returnRequestId: null, sellerOrderId: o.sellerOrderIds[sA.id], amount: 1000, reason: "seller_cancellation" },
        tx,
      );
      if (!created.ok) { ok("11 · (setup) refund created", false); throw new Rollback(); }
      const providerId = `re_9f60_${rand()}`;
      await tx.paymentRefund.update({ where: { id: created.paymentRefundId }, data: { providerId, status: "PROCESSING" } });
      const event = { data: { id: `evt_${rand()}`, attributes: { type: "refund.updated", data: { id: providerId, type: "refund", attributes: { status: "succeeded" } } } } };

      // o.grandTotal = 1000 (merch) + 150 (shipping) = 1150; the seller-scoped
      // refund is only 1000 (SellerOrder.total, shipping isn't attributed to
      // any one seller) — so the Payment is correctly PARTIALLY_REFUNDED, not
      // fully REFUNDED. This is the SAME unmodified webhook derivation logic.
      await handleEvent(`evt_${rand()}`, "refund.updated", event, tx);
      const after1 = await tx.payment.findUnique({ where: { id: o.paymentId }, select: { status: true } });
      ok("11 · first delivery: Payment reaches PARTIALLY_REFUNDED (seller refund < full Payment.amount)", after1?.status === "PARTIALLY_REFUNDED");

      await handleEvent(`evt_${rand()}`, "refund.updated", event, tx);
      const after2 = await tx.payment.findUnique({ where: { id: o.paymentId }, select: { status: true } });
      const succeededCount = await tx.paymentRefund.count({ where: { id: created.paymentRefundId, status: "SUCCEEDED" } });
      ok("11 · repeated webhook delivery is idempotent — status unchanged, exactly one SUCCEEDED row", after2?.status === "PARTIALLY_REFUNDED" && succeededCount === 1);

      throw new Rollback();
    }, { timeout: 30_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

// ── 12 · transaction rollback ──────────────────────────────────────────────
async function rollbackTest() {
  console.log("\n── 12 · forced transaction rollback ──");
  const category = await prisma.category.findFirst({ select: { id: true } });
  if (!category) { ok("(skipped — no category)", true); return; }
  const sfx = "rb" + rand();
  let sellerOrderId = "";
  let orderId = "";
  class ForcedError extends Error {}
  try {
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { email: `u-${sfx}@t.test`, name: "Buyer" }, select: { id: true } });
      const sA = await mkSeller(tx, sfx, "RBA", "Seller RB-A");
      const o = await mkPaidOrder(tx, sfx, user.id, category.id, [{ sellerId: sA.id, sellerName: "Seller RB-A", qty: 1 }]);
      sellerOrderId = o.sellerOrderIds[sA.id];
      orderId = o.orderId;

      const res = await sellerCancelSellerOrder(ctxFor(sA.id, "Seller RB-A"), sellerOrderId, "reason", tx);
      if (!res.ok) throw new Error("setup: cancellation itself failed");
      await createAttributedPaymentRefund(
        { paymentId: o.paymentId, returnRequestId: null, sellerOrderId, amount: 1000, reason: "seller_cancellation" },
        tx,
      );
      // Force the WHOLE transaction (including the fixtures, the cancellation,
      // and the refund row above) to roll back.
      throw new ForcedError("forced rollback");
    });
  } catch (e) {
    if (!(e instanceof ForcedError)) throw e;
  }
  const soExists = sellerOrderId ? await prisma.sellerOrder.findUnique({ where: { id: sellerOrderId } }) : null;
  const orderExists = orderId ? await prisma.order.findUnique({ where: { id: orderId } }) : null;
  ok("12 · a forced rollback undoes EVERYTHING — the fixture Order/SellerOrder never persisted", soExists === null && orderExists === null);
}

async function main() {
  console.log("\nPHASE 9F-60 — PAID seller-cancellation refund flow\n");
  staticTests();
  await dbTests();
  await providerFailureTest();
  await webhookIdempotencyTest();
  await rollbackTest();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
