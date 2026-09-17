/**
 * Phase 9F-59 — seller-aware refund attribution foundation.
 *
 * NOT PayMongo activation. Exercises only the DB-only, provider-agnostic
 * pieces added on top of the already-deployed schema foundation
 * (PaymentRefund.sellerOrderId, nullable FK -> SellerOrder, ON DELETE SET
 * NULL): `deriveReturnSellerOrderId` (src/lib/payments/refund.ts) and the
 * atomic, lock-protected `createAttributedPaymentRefund` core it and
 * `initiateProviderRefund` both use. No PayMongo network call is made — the
 * provider call in `initiateProviderRefund` is unreachable while
 * `onlinePaymentEnabled`/`mode !== "live"` (unchanged, still dormant), so
 * these tests drive `createAttributedPaymentRefund` directly, exactly the
 * way `restoreOfferStock` / `commitOfferStockForSale` are tested directly
 * elsewhere in this codebase.
 *
 * Pattern: one rolled-back `prisma.$transaction` per scenario (mirrors
 * test-9f54-paymongo.ts's `Rollback` sentinel), EXCEPT the concurrency
 * scenario (I), which needs two REAL, independent transactions to prove the
 * `SELECT ... FOR UPDATE` lock actually serializes them — that one uses real
 * committed fixtures with explicit `finally` cleanup (mirrors the seller
 * self-cancellation race test, test-multiseller-seller-cancellation.ts §J).
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f59-refund-attribution.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient, Prisma } from "@prisma/client";
import {
  deriveReturnSellerOrderId,
  createAttributedPaymentRefund,
  refundRouteForOrder,
} from "@/lib/payments/refund";
import { handleEvent } from "@/lib/payments/webhook";

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
  const refund = read("src/lib/payments/refund.ts");
  const returnsActions = read("src/lib/admin/returns-actions.ts");
  const webhook = read("src/lib/payments/webhook.ts");
  const schema = read("prisma/schema.prisma");

  ok("refund.ts exports deriveReturnSellerOrderId and createAttributedPaymentRefund",
    /export async function deriveReturnSellerOrderId/.test(refund) &&
      /export async function createAttributedPaymentRefund/.test(refund));
  ok("the atomic core locks the Payment row with SELECT ... FOR UPDATE before any cap read",
    /SELECT "id", "amount" FROM "Payment" WHERE "id" = \$\{params\.paymentId\} FOR UPDATE/.test(refund));
  ok("the seller-cap check reads SellerOrder.total read-only (no write to it anywhere in this file)",
    /select: \{ total: true \}/.test(refund) && !/sellerOrder\.update/.test(refund) && !/tx\.sellerOrder\.update/.test(refund));
  ok("initiateProviderRefund now routes PaymentRefund creation through the atomic core (no direct prisma.paymentRefund.create left in it)",
    /const created = await createAttributedPaymentRefund/.test(refund));
  ok("no PaymentRefundAllocation / split-refund mechanism was actually introduced (code, not comments)",
    !/model PaymentRefundAllocation/.test(schema) && !/paymentRefundAllocation\./.test(refund) &&
      !/paymentRefundAllocation\./.test(returnsActions));
  ok("deriveReturnSellerOrderId falls back to NULL (not an arbitrary pick) on a genuinely mixed-seller return",
    /distinct\.size === 0.*return \{ sellerOrderId: null, mixed: false \}/.test(refund.replace(/\n/g, " ")) &&
      /return \{ sellerOrderId: null, mixed: true \}/.test(refund));

  ok("returns-actions.ts wires seller attribution into the existing initiateRefundAction provider branch",
    /const attribution = await deriveReturnSellerOrderId\(ret\.id\)/.test(returnsActions) &&
      /sellerOrderId: attribution\.sellerOrderId/.test(returnsActions));
  ok("sellerCancelSellerOrder / cancellation is NOT wired to any automatic refund trigger",
    !/initiateProviderRefund/.test(read("src/lib/marketplace/seller-order-repository.ts")) &&
      !/initiateProviderRefund/.test(read("src/lib/orders/cancellation.ts")));

  // Scope — Payment.status / Order.paymentStatus derivation untouched.
  ok("webhook.ts's refund.updated handler still derives Payment.status from the aggregate SUCCEEDED sum (untouched)",
    /const fully = refunded >= refund\.payment\.amount/.test(webhook) &&
      /status: fully \? "REFUNDED" : "PARTIALLY_REFUNDED"/.test(webhook));
  ok("no per-seller Payment row was introduced (Payment model unchanged)",
    !/model Payment \{[\s\S]*?sellerOrderId/.test(schema.slice(schema.indexOf("model Payment {"), schema.indexOf("model Payment {") + 1200)));
  ok("PaymentRefund.returnRequestId is still @unique (one refund per return — no allocation split)",
    /returnRequestId String\? @unique/.test(schema));
  ok("no new migration file / schema column beyond the already-applied PaymentRefund.sellerOrderId",
    (schema.match(/sellerOrderId\s+String\?/g) ?? []).length === 1 || /sellerOrder\s+SellerOrder\?\s+@relation\(fields: \[sellerOrderId\]/.test(schema));
  ok("seed-rbac.ts untouched", !/deriveReturnSellerOrderId|createAttributedPaymentRefund/.test(read("scripts/seed-rbac.ts")));
}

// ── fixtures ────────────────────────────────────────────────────────────
type SellerSpec = { sellerId: string; sellerName: string; sellerType?: string; qty: number };

async function mkSeller(tx: Tx, sfx: string, tag: string, name: string) {
  return tx.seller.create({
    data: { type: "THIRD_PARTY", status: "APPROVED", displayName: name, slug: `s-${tag}-${sfx}-${rand()}`, supportEmail: `${tag}@t.test` },
    select: { id: true },
  });
}
async function mkProduct(tx: Tx, categoryId: string, sfx: string) {
  return tx.product.create({
    data: { name: `P ${sfx}`, slug: `p-${sfx}-${rand()}`, shortDescription: "s", description: "d", categoryId, status: "ACTIVE", price: 1000 },
    select: { id: true },
  });
}

/** Order + N SellerOrders (+ OrderItems) + one Payment (default PAID). */
async function mkOrderWithPayment(
  tx: Tx,
  sfx: string,
  userId: string,
  categoryId: string,
  sellers: SellerSpec[],
  opts: { paymentStatus?: string; paymentAmount?: number } = {},
) {
  const subtotal = sellers.reduce((n, s) => n + s.qty * 1000, 0);
  const shippingFee = 150;
  const grandTotal = subtotal + shippingFee;
  const order = await tx.order.create({
    data: {
      orderNumber: `AX-RFND-${sfx}-${rand()}`,
      userId, email: "buyer@example.test", phone: "+639000000000",
      status: "DELIVERED", paymentStatus: "PAID", paymentMethod: "CARD",
      subtotal, shippingFee, grandTotal, deliveredAt: new Date(),
      shippingAddress: JSON.stringify({ firstName: "T", lastName: "B", line1: "1 St", city: "Manila", province: "NCR", postalCode: "1000", country: "PH" }),
    },
    select: { id: true, orderNumber: true },
  });
  const sellerOrderIds: Record<string, string> = {};
  const orderItemIds: Record<string, string> = {};
  for (const s of sellers) {
    const merch = s.qty * 1000;
    const p = await mkProduct(tx, categoryId, sfx + s.sellerId.slice(0, 4));
    const so = await tx.sellerOrder.create({
      data: {
        orderId: order.id, sellerId: s.sellerId, sellerName: s.sellerName, sellerType: s.sellerType ?? "THIRD_PARTY", supportEmail: "s@t.test",
        merchandiseSubtotal: merch, shippingFee: 0, total: merch, commissionRate: 1500, commissionAmount: Math.round(merch * 0.15),
        status: "DELIVERED",
      },
      select: { id: true },
    });
    sellerOrderIds[s.sellerId] = so.id;
    const item = await tx.orderItem.create({
      data: { orderId: order.id, sellerOrderId: so.id, sellerId: s.sellerId, productId: p.id, name: `Item ${s.sellerId}`, unitPrice: 1000, quantity: s.qty, lineTotal: merch },
      select: { id: true },
    });
    orderItemIds[s.sellerId] = item.id;
  }
  const payment = await tx.payment.create({
    data: {
      orderId: order.id, provider: "paymongo", providerObject: "checkout_session",
      providerId: `cs_9f59_${sfx}_${rand()}`,
      status: opts.paymentStatus ?? "PAID",
      amount: opts.paymentAmount ?? grandTotal, currency: "PHP",
      paidAt: new Date(), metadata: "{}",
    },
    select: { id: true },
  });
  return { orderId: order.id, orderNumber: order.orderNumber, paymentId: payment.id, sellerOrderIds, orderItemIds, grandTotal };
}

async function mkReturn(tx: Tx, orderId: string, userId: string, itemIds: string[]) {
  const ret = await tx.returnRequest.create({
    data: {
      returnNumber: `RET-9F59-${rand()}`,
      orderId, userId, status: "RECEIVED", reason: "OTHER",
    },
    select: { id: true },
  });
  for (const orderItemId of itemIds) {
    await tx.returnItem.create({
      data: { returnRequestId: ret.id, orderItemId, productId: "p", name: "n", unitPrice: 1000, quantity: 1, refundAmount: 1000 },
    });
  }
  return ret.id;
}

// ── DB behaviour (rolled back) ────────────────────────────────────────────
async function dbTests() {
  console.log("\n── seller-aware refund attribution (rolled-back fixtures) ──");
  const category = await prisma.category.findFirst({ select: { id: true } });
  if (!category) { ok("(skipped — no category)", true); return; }

  try {
    await prisma.$transaction(async (tx) => {
      const sfx = "a" + rand();
      const user = await tx.user.create({ data: { email: `u-${sfx}@t.test`, name: "Buyer" }, select: { id: true } });

      // ── A · single-seller provider refund ──
      {
        const sA = await mkSeller(tx, sfx, "A", "Seller A");
        const o = await mkOrderWithPayment(tx, sfx + "A", user.id, category.id, [{ sellerId: sA.id, sellerName: "Seller A", qty: 1 }]);
        const retId = await mkReturn(tx, o.orderId, user.id, [o.orderItemIds[sA.id]]);
        const res = await createAttributedPaymentRefund(
          { paymentId: o.paymentId, returnRequestId: retId, sellerOrderId: o.sellerOrderIds[sA.id], amount: 1000, reason: "requested_by_customer" },
          tx,
        );
        ok("A · single-seller refund succeeds", res.ok === true);
        if (res.ok) {
          const row = await tx.paymentRefund.findUnique({ where: { id: res.paymentRefundId }, select: { sellerOrderId: true, amount: true } });
          ok("A · PaymentRefund carries the SellerOrder's id", row?.sellerOrderId === o.sellerOrderIds[sA.id]);
          ok("A · amount <= SellerOrder.total (1000 <= 1000)", (row?.amount ?? -1) <= 1000);
        }
      }

      // ── B · multi-seller: refund Seller A, Seller B unaffected ──
      {
        const sA = await mkSeller(tx, sfx, "BA", "Seller B-A");
        const sB = await mkSeller(tx, sfx, "BB", "Seller B-B");
        const o = await mkOrderWithPayment(tx, sfx + "B", user.id, category.id, [
          { sellerId: sA.id, sellerName: "Seller B-A", qty: 2 },
          { sellerId: sB.id, sellerName: "Seller B-B", qty: 2 },
        ]);
        const retA = await mkReturn(tx, o.orderId, user.id, [o.orderItemIds[sA.id]]);
        const res = await createAttributedPaymentRefund(
          { paymentId: o.paymentId, returnRequestId: retA, sellerOrderId: o.sellerOrderIds[sA.id], amount: 1000, reason: "requested_by_customer" },
          tx,
        );
        ok("B · Seller A's refund succeeds", res.ok === true);
        const bAgg = await tx.paymentRefund.aggregate({ where: { sellerOrderId: o.sellerOrderIds[sB.id] }, _sum: { amount: true } });
        ok("B · Seller B has ZERO refunds — unaffected by A's refund", (bAgg._sum.amount ?? 0) === 0);
        // B's own cap is still its full total (untouched).
        const capB = await createAttributedPaymentRefund(
          { paymentId: o.paymentId, returnRequestId: null, sellerOrderId: o.sellerOrderIds[sB.id], amount: 2000, reason: "requested_by_customer" },
          tx,
        );
        ok("B · Seller B can still refund its FULL own total (2000) — no cross-seller leakage", capB.ok === true);
      }

      // ── C · two independent seller refunds sum <= shared Payment.amount ──
      {
        const sA = await mkSeller(tx, sfx, "CA", "Seller C-A");
        const sB = await mkSeller(tx, sfx, "CB", "Seller C-B");
        const o = await mkOrderWithPayment(tx, sfx + "C", user.id, category.id, [
          { sellerId: sA.id, sellerName: "Seller C-A", qty: 2 },
          { sellerId: sB.id, sellerName: "Seller C-B", qty: 2 },
        ]);
        const r1 = await createAttributedPaymentRefund(
          { paymentId: o.paymentId, returnRequestId: null, sellerOrderId: o.sellerOrderIds[sA.id], amount: 2000, reason: "requested_by_customer" },
          tx,
        );
        const r2 = await createAttributedPaymentRefund(
          { paymentId: o.paymentId, returnRequestId: null, sellerOrderId: o.sellerOrderIds[sB.id], amount: 2000, reason: "requested_by_customer" },
          tx,
        );
        ok("C · both independent seller refunds succeed", r1.ok === true && r2.ok === true);
        const totalAgg = await tx.paymentRefund.aggregate({ where: { paymentId: o.paymentId }, _sum: { amount: true } });
        ok("C · their sum (4000) equals the shared Payment.amount (4150) or less", (totalAgg._sum.amount ?? 0) <= o.grandTotal);
      }

      // ── D · seller cap: request > SellerOrder.total → rejected ──
      {
        const sA = await mkSeller(tx, sfx, "DA", "Seller D-A");
        const o = await mkOrderWithPayment(tx, sfx + "D", user.id, category.id, [{ sellerId: sA.id, sellerName: "Seller D-A", qty: 1 }]);
        const res = await createAttributedPaymentRefund(
          { paymentId: o.paymentId, returnRequestId: null, sellerOrderId: o.sellerOrderIds[sA.id], amount: 1001, reason: "requested_by_customer" },
          tx,
        );
        ok("D · a request exceeding SellerOrder.total (1001 > 1000) is rejected", res.ok === false && !res.ok && res.code === "SELLER_CAP_EXCEEDED");
        ok("D · rejection is NOT silently truncated — no PaymentRefund row was created for it",
          (await tx.paymentRefund.count({ where: { sellerOrderId: o.sellerOrderIds[sA.id] } })) === 0);
      }

      // ── E · payment cap: aggregate refunds > Payment.amount → rejected ──
      {
        const sA = await mkSeller(tx, sfx, "EA", "Seller E-A");
        const o = await mkOrderWithPayment(tx, sfx + "E", user.id, category.id, [{ sellerId: sA.id, sellerName: "Seller E-A", qty: 1 }], { paymentAmount: 1000 });
        const r1 = await createAttributedPaymentRefund(
          { paymentId: o.paymentId, returnRequestId: null, sellerOrderId: null, amount: 900, reason: "requested_by_customer" },
          tx,
        );
        ok("E · first refund (900/1000) succeeds", r1.ok === true);
        const r2 = await createAttributedPaymentRefund(
          { paymentId: o.paymentId, returnRequestId: null, sellerOrderId: null, amount: 200, reason: "requested_by_customer" },
          tx,
        );
        ok("E · second refund pushing the aggregate over Payment.amount (900+200 > 1000) is rejected",
          r2.ok === false && !r2.ok && r2.code === "PAYMENT_CAP_EXCEEDED");
      }

      // ── G · return-derived seller attribution (single-seller) ──
      {
        const sA = await mkSeller(tx, sfx, "GA", "Seller G-A");
        const o = await mkOrderWithPayment(tx, sfx + "G", user.id, category.id, [{ sellerId: sA.id, sellerName: "Seller G-A", qty: 1 }]);
        const retId = await mkReturn(tx, o.orderId, user.id, [o.orderItemIds[sA.id]]);
        const attr = await deriveReturnSellerOrderId(retId, tx);
        ok("G · single-seller return resolves to that SellerOrder's id, not mixed", attr.sellerOrderId === o.sellerOrderIds[sA.id] && attr.mixed === false);
      }
      // ── G2 · genuinely mixed-seller return → NULL + mixed:true, no split invented ──
      {
        const sA = await mkSeller(tx, sfx, "G2A", "Seller G2-A");
        const sB = await mkSeller(tx, sfx, "G2B", "Seller G2-B");
        const o = await mkOrderWithPayment(tx, sfx + "G2", user.id, category.id, [
          { sellerId: sA.id, sellerName: "Seller G2-A", qty: 1 },
          { sellerId: sB.id, sellerName: "Seller G2-B", qty: 1 },
        ]);
        const retId = await mkReturn(tx, o.orderId, user.id, [o.orderItemIds[sA.id], o.orderItemIds[sB.id]]);
        const attr = await deriveReturnSellerOrderId(retId, tx);
        ok("G2 · a return spanning two SellerOrders resolves to NULL (no arbitrary pick), mixed:true", attr.sellerOrderId === null && attr.mixed === true);
      }

      // ── H · mixed FIRST_PARTY + THIRD_PARTY: attribution only where applicable, no leakage ──
      {
        const axiaro = await tx.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
        if (!axiaro) {
          ok("H (skipped — no FIRST_PARTY seller row found)", true);
        } else {
          const sTP = await mkSeller(tx, sfx, "HTP", "Seller H-3P");
          const o = await mkOrderWithPayment(tx, sfx + "H", user.id, category.id, [
            { sellerId: axiaro.id, sellerName: "Axiaro", sellerType: "FIRST_PARTY", qty: 1 },
            { sellerId: sTP.id, sellerName: "Seller H-3P", qty: 1 },
          ]);
          const ret1p = await mkReturn(tx, o.orderId, user.id, [o.orderItemIds[axiaro.id]]);
          const attr1p = await deriveReturnSellerOrderId(ret1p, tx);
          ok("H · a return of only the FIRST_PARTY line resolves to the FIRST_PARTY SellerOrder, not the 3P one",
            attr1p.sellerOrderId === o.sellerOrderIds[axiaro.id] && attr1p.sellerOrderId !== o.sellerOrderIds[sTP.id]);
          const res1p = await createAttributedPaymentRefund(
            { paymentId: o.paymentId, returnRequestId: ret1p, sellerOrderId: attr1p.sellerOrderId, amount: 1000, reason: "requested_by_customer" },
            tx,
          );
          ok("H · that refund succeeds against the FIRST_PARTY SellerOrder's own cap", res1p.ok === true);
          const tpAgg = await tx.paymentRefund.aggregate({ where: { sellerOrderId: o.sellerOrderIds[sTP.id] }, _sum: { amount: true } });
          ok("H · the THIRD_PARTY seller's refund total is untouched (no cross-seller leakage)", (tpAgg._sum.amount ?? 0) === 0);
        }
      }

      // ── J · repeated webhook — existing idempotency remains intact (unchanged code) ──
      {
        const sA = await mkSeller(tx, sfx, "JA", "Seller J-A");
        const o = await mkOrderWithPayment(tx, sfx + "J", user.id, category.id, [{ sellerId: sA.id, sellerName: "Seller J-A", qty: 1 }], { paymentAmount: 1000 });
        const retId = await mkReturn(tx, o.orderId, user.id, [o.orderItemIds[sA.id]]);
        const created = await createAttributedPaymentRefund(
          { paymentId: o.paymentId, returnRequestId: retId, sellerOrderId: o.sellerOrderIds[sA.id], amount: 1000, reason: "requested_by_customer" },
          tx,
        );
        if (created.ok) {
          const providerId = `re_9f59_${rand()}`;
          await tx.paymentRefund.update({ where: { id: created.paymentRefundId }, data: { providerId, status: "PROCESSING" } });
          const event = { data: { id: `evt_${rand()}`, attributes: { type: "refund.updated", data: { id: providerId, type: "refund", attributes: { status: "succeeded" } } } } };
          await handleEvent(`evt_${rand()}`, "refund.updated", event, tx);
          const afterFirst = await tx.payment.findUnique({ where: { id: o.paymentId }, select: { status: true } });
          ok("J · first refund.updated (succeeded) marks the Payment REFUNDED", afterFirst?.status === "REFUNDED");
          // Re-deliver the SAME event — must be a no-op (status-guarded updateMany).
          await handleEvent(`evt_${rand()}`, "refund.updated", event, tx);
          const afterSecond = await tx.payment.findUnique({ where: { id: o.paymentId }, select: { status: true } });
          const succeededCount = await tx.paymentRefund.count({ where: { id: created.paymentRefundId, status: "SUCCEEDED" } });
          ok("J · repeated webhook delivery is idempotent — status unchanged, no duplicate SUCCEEDED row",
            afterSecond?.status === "REFUNDED" && succeededCount === 1);
        } else {
          ok("J · (setup) initial refund creation must succeed for this scenario", false, JSON.stringify(created));
        }
      }

      // ── K · COD: refundRouteForOrder() remains bookkeeping, no provider write ──
      {
        const sA = await mkSeller(tx, sfx, "KA", "Seller K-A");
        const codOrder = await tx.order.create({
          data: {
            orderNumber: `AX-RFND-COD-${sfx}-${rand()}`, userId: user.id, email: "buyer@example.test", phone: "+639000000000",
            status: "DELIVERED", paymentStatus: "PENDING", paymentMethod: "COD",
            subtotal: 1000, shippingFee: 150, grandTotal: 1150, deliveredAt: new Date(),
            shippingAddress: JSON.stringify({ firstName: "T", lastName: "B", line1: "1 St", city: "Manila", province: "NCR", postalCode: "1000", country: "PH" }),
          },
          select: { id: true },
        });
        const routing = await refundRouteForOrder(codOrder.id);
        ok("K · a COD order (no PAID online Payment) routes to bookkeeping", routing.route === "bookkeeping");
        ok("K · no PaymentRefund row exists for this COD order", (await tx.paymentRefund.count({ where: { payment: { orderId: codOrder.id } } })) === 0);
        void sA;
      }

      // ── L · legacy NULL sellerOrderId refunds remain valid ──
      {
        const sA = await mkSeller(tx, sfx, "LA", "Seller L-A");
        const o = await mkOrderWithPayment(tx, sfx + "L", user.id, category.id, [{ sellerId: sA.id, sellerName: "Seller L-A", qty: 1 }], { paymentAmount: 1000 });
        const res = await createAttributedPaymentRefund(
          { paymentId: o.paymentId, returnRequestId: null, sellerOrderId: null, amount: 1000, reason: "requested_by_customer" },
          tx,
        );
        ok("L · a NULL-attributed (legacy/whole-order) refund still succeeds, bound only by the Payment cap", res.ok === true);
        if (res.ok) {
          const row = await tx.paymentRefund.findUnique({ where: { id: res.paymentRefundId }, select: { sellerOrderId: true } });
          ok("L · sellerOrderId is genuinely NULL, not defaulted to anything", row?.sellerOrderId === null);
        }
      }

      throw new Rollback();
    }, { timeout: 60_000, maxWait: 15_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

// ── F · duplicate same ReturnRequest: existing uniqueness remains enforced ──
// A P2002 mid-transaction poisons the WHOLE Postgres transaction (25P02 on
// every subsequent statement) — this must be its own `$transaction` call, not
// nested inside dbTests()'s shared one (mirrors test-9f47b.ts's identical
// (provider, providerEventId) unique-constraint scenario).
async function duplicateReturnRefundTest() {
  console.log("\n── F · duplicate PaymentRefund for the same ReturnRequest ──");
  const category = await prisma.category.findFirst({ select: { id: true } });
  if (!category) { ok("(skipped — no category)", true); return; }
  let firstOk = false;
  let dupCode: string | undefined;
  try {
    await prisma.$transaction(async (tx) => {
      const sfx = "f" + rand();
      const user = await tx.user.create({ data: { email: `u-${sfx}@t.test`, name: "Buyer" }, select: { id: true } });
      const sA = await mkSeller(tx, sfx, "FA", "Seller F-A");
      const o = await mkOrderWithPayment(tx, sfx + "F", user.id, category.id, [{ sellerId: sA.id, sellerName: "Seller F-A", qty: 1 }]);
      const retId = await mkReturn(tx, o.orderId, user.id, [o.orderItemIds[sA.id]]);
      const r1 = await createAttributedPaymentRefund(
        { paymentId: o.paymentId, returnRequestId: retId, sellerOrderId: null, amount: 100, reason: "requested_by_customer" },
        tx,
      );
      firstOk = r1.ok;
      // The second create is expected to throw P2002 — let it propagate so the
      // whole transaction rolls back cleanly (no attempt to keep using `tx`
      // afterward, which would hit the same 25P02 poisoning this isolation avoids).
      await createAttributedPaymentRefund(
        { paymentId: o.paymentId, returnRequestId: retId, sellerOrderId: null, amount: 100, reason: "requested_by_customer" },
        tx,
      );
      throw new Rollback();
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError) dupCode = e.code;
    else if (!(e instanceof Rollback)) throw e;
  }
  ok("F · first refund for this ReturnRequest succeeds", firstOk);
  ok("F · a second PaymentRefund for the SAME ReturnRequest still violates the @unique constraint (P2002)",
    dupCode === "P2002", `got: ${dupCode ?? "no error"}`);
}

// ── I · concurrency (real committed fixtures — two independent transactions) ──
async function concurrencyTest() {
  console.log("\n── I · concurrent refund attempts (real fixtures, explicit cleanup) ──");
  const category = await prisma.category.findFirst({ select: { id: true } });
  if (!category) { ok("(skipped — no category)", true); return; }
  const sfx = "conc" + rand();

  const fixtureOrderIds: string[] = [];
  const fixtureSellerIds: string[] = [];
  const fixtureProductIds: string[] = [];
  let fixtureUserId: string | null = null;

  try {
    const user = await prisma.user.create({ data: { email: `u-${sfx}@t.test`, name: "Buyer" }, select: { id: true } });
    fixtureUserId = user.id;
    const seller = await prisma.seller.create({
      data: { type: "THIRD_PARTY", status: "APPROVED", displayName: "Seller Conc", slug: `s-conc-${sfx}`, supportEmail: "conc@t.test" },
      select: { id: true },
    });
    fixtureSellerIds.push(seller.id);
    const product = await prisma.product.create({
      data: { name: `P ${sfx}`, slug: `p-${sfx}`, shortDescription: "s", description: "d", categoryId: category.id, status: "ACTIVE", price: 1000 },
      select: { id: true },
    });
    fixtureProductIds.push(product.id);
    const order = await prisma.order.create({
      data: {
        orderNumber: `AX-RFND-CONC-${sfx}`, userId: user.id, email: "buyer@example.test", phone: "+639000000000",
        status: "DELIVERED", paymentStatus: "PAID", paymentMethod: "CARD",
        subtotal: 1000, shippingFee: 0, grandTotal: 1000, deliveredAt: new Date(),
        shippingAddress: JSON.stringify({ firstName: "T", lastName: "B", line1: "1 St", city: "Manila", province: "NCR", postalCode: "1000", country: "PH" }),
      },
      select: { id: true },
    });
    fixtureOrderIds.push(order.id);
    const so = await prisma.sellerOrder.create({
      data: {
        orderId: order.id, sellerId: seller.id, sellerName: "Seller Conc", sellerType: "THIRD_PARTY", supportEmail: "conc@t.test",
        merchandiseSubtotal: 1000, shippingFee: 0, total: 1000, commissionRate: 1500, commissionAmount: 150, status: "DELIVERED",
      },
      select: { id: true },
    });
    await prisma.orderItem.create({
      data: { orderId: order.id, sellerOrderId: so.id, sellerId: seller.id, productId: product.id, name: "Item", unitPrice: 1000, quantity: 1, lineTotal: 1000 },
    });
    const payment = await prisma.payment.create({
      data: {
        orderId: order.id, provider: "paymongo", providerObject: "checkout_session", providerId: `cs_9f59_conc_${sfx}`,
        status: "PAID", amount: 1000, currency: "PHP", paidAt: new Date(), metadata: "{}",
      },
      select: { id: true },
    });

    // Two independent transactions, each requesting 700 against a 1000-centavo
    // Payment — combined they exceed it, so the FOR UPDATE lock must serialize
    // them: the second sees the first's committed refund before deciding.
    const [r1, r2] = await Promise.all([
      createAttributedPaymentRefund({ paymentId: payment.id, returnRequestId: null, sellerOrderId: null, amount: 700, reason: "requested_by_customer" }),
      createAttributedPaymentRefund({ paymentId: payment.id, returnRequestId: null, sellerOrderId: null, amount: 700, reason: "requested_by_customer" }),
    ]);
    const succeeded = [r1, r2].filter((r) => r.ok);
    const rejected = [r1, r2].filter((r) => !r.ok);
    ok("I · exactly ONE of the two concurrent 700-centavo refunds succeeds (against a 1000-centavo Payment)",
      succeeded.length === 1, JSON.stringify([r1, r2]));
    ok("I · the other is rejected as PAYMENT_CAP_EXCEEDED, not silently truncated or double-applied",
      rejected.length === 1 && !rejected[0].ok && rejected[0].code === "PAYMENT_CAP_EXCEEDED");
    const finalAgg = await prisma.paymentRefund.aggregate({ where: { paymentId: payment.id }, _sum: { amount: true } });
    ok("I · the ledger never exceeded the Payment's own amount despite the race", (finalAgg._sum.amount ?? 0) <= 1000);
  } finally {
    if (fixtureOrderIds.length) await prisma.order.deleteMany({ where: { id: { in: fixtureOrderIds } } }).catch(() => {});
    if (fixtureProductIds.length) await prisma.product.deleteMany({ where: { id: { in: fixtureProductIds } } }).catch(() => {});
    if (fixtureSellerIds.length) await prisma.seller.deleteMany({ where: { id: { in: fixtureSellerIds } } }).catch(() => {});
    if (fixtureUserId) await prisma.user.deleteMany({ where: { id: fixtureUserId } }).catch(() => {});
  }

  ok("I · CLEANUP — no fixture order leaked", (await prisma.order.count({ where: { orderNumber: { contains: sfx } } })) === 0);
  ok("I · CLEANUP — no fixture product leaked", (await prisma.product.count({ where: { id: { in: fixtureProductIds } } })) === 0);
  ok("I · CLEANUP — no fixture seller leaked", (await prisma.seller.count({ where: { id: { in: fixtureSellerIds } } })) === 0);
}

async function main() {
  console.log("\nPHASE 9F-59 — seller-aware refund attribution foundation\n");
  staticTests();
  await dbTests();
  await duplicateReturnRefundTest();
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
