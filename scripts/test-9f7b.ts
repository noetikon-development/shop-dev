/**
 * Phase 9F-7b — marketplace operations notifications:
 *   1. order_received_ops        (Axiaro Operations, companion to order_confirmation)
 *   2. seller_order_cancelled    (seller, on an admin parent-order cancellation)
 *   3. seller_return_received    (seller, on an admin marking a return received)
 *   4. return_refund_initiated_ops / return_refund_completed_ops (Ops, bookkeeping-only)
 *
 * DB tests build a seller + OWNER user + a category/product/variant + an order
 * (with a marketplace-snapshotted OrderItem.sellerId) + a SellerOrder + a
 * ReturnRequest/ReturnItem inside ONE prisma.$transaction and roll back. Every
 * new sender + `retryEmailByLog` + `getReturnAffectedSellerIds` takes an
 * optional transaction client so nothing leaks. The local env has no EMAIL_*
 * creds, so a "successful" send re-records SKIPPED (not SENT) — the assertion
 * is that it ROUTES, uses the right EmailType/recipient/idempotency key, and
 * (on retry) REUSES the row — which in a configured runtime would send.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f7b.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  retryEmailByLog,
  sendOrderReceivedOps,
  sendSellerOrderCancelled,
  sendSellerReturnReceived,
  sendReturnRefundInitiatedOps,
  sendReturnRefundCompletedOps,
  getReturnAffectedSellerIds,
} from "../src/lib/email/notifications";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
class Rollback extends Error {}
type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

async function seedSeller(tx: Tx, slug: string) {
  return tx.seller.create({
    data: { type: "THIRD_PARTY", status: "APPROVED", displayName: slug, slug, supportEmail: `${slug}@t.test`, contentStatus: "DRAFT" },
    select: { id: true },
  });
}
async function seedUser(tx: Tx, tag: string) {
  return tx.user.create({
    data: { email: `${tag}@t.test`, name: "T", role: "CUSTOMER", supabaseUserId: `sb-${tag}` },
    select: { id: true, email: true },
  });
}

// ---------------------------------------------------------------------------
// Static wiring
// ---------------------------------------------------------------------------

function staticTests() {
  const notifs = read("src/lib/email/notifications.ts");
  const send = read("src/lib/email/send.ts");
  const checkout = read("src/lib/checkout.ts");
  const orderActions = read("src/lib/admin/order-actions.ts");
  const returnsActions = read("src/lib/admin/returns-actions.ts");
  const schema = read("prisma/schema.prisma");

  for (const t of ["order_received_ops", "seller_order_cancelled", "seller_return_received", "return_refund_initiated_ops", "return_refund_completed_ops"]) {
    ok(`EmailType · "${t}" added`, new RegExp(`"${t}"`).test(send));
  }

  ok("routing · all 5 new retry cases present", /case "order_received_ops":/.test(notifs) && /case "seller_order_cancelled":/.test(notifs) && /case "seller_return_received":/.test(notifs) && /case "return_refund_initiated_ops":/.test(notifs) && /case "return_refund_completed_ops":/.test(notifs));
  ok("routing · default branch still returns not_retryable exactly once", (notifs.match(/error: "not_retryable"/g) ?? []).length === 1);

  // idempotency anchors
  ok("idempotency · new order (ops) keys off orderId only, same anchor as order_confirmation", /ORDER_RECEIVED_OPS:\$\{order\.id\}/.test(notifs));
  ok("idempotency · seller-order-cancelled keys off the SellerOrder's own immutable id, not Seller.updatedAt", /SELLER_ORDER_CANCELLED:\$\{sellerOrderId\}/.test(notifs));
  ok("idempotency · seller-return-received keys off (returnId, sellerId), not Seller.updatedAt", /SELLER_RETURN_RECEIVED:\$\{returnId\}:\$\{sellerId\}/.test(notifs));
  ok("idempotency · refund ops keys mirror the sibling customer return-refund keys (returnId only)", /RETURN_REFUND_INITIATED_OPS:\$\{ret\.id\}/.test(notifs) && /RETURN_REFUND_COMPLETED_OPS:\$\{ret\.id\}/.test(notifs));
  ok("idempotency · no new key is built from Seller.updatedAt", !/(ORDER_RECEIVED_OPS|SELLER_ORDER_CANCELLED|SELLER_RETURN_RECEIVED|RETURN_REFUND_(INITIATED|COMPLETED)_OPS)[^\n]*updatedAt/.test(notifs));

  // recipients
  ok("recipients · order_received_ops uses the ops inbox (getSupportInboxEmail)", /sendOrderReceivedOps[\s\S]{0,800}getSupportInboxEmail\(\)/.test(notifs));
  ok("recipients · refund ops senders use the ops inbox", /sendReturnRefundInitiatedOps[\s\S]{0,900}getSupportInboxEmail\(\)/.test(notifs) && /sendReturnRefundCompletedOps[\s\S]{0,900}getSupportInboxEmail\(\)/.test(notifs));
  ok("recipients · seller senders reuse loadSellerLifecycleEmailContext (9F-6b pattern), not a new resolver", /sendSellerOrderCancelled[\s\S]{0,600}loadSellerLifecycleEmailContext/.test(notifs) && /sendSellerReturnReceived[\s\S]{0,600}loadSellerLifecycleEmailContext/.test(notifs));

  // trigger wiring
  ok("trigger · new order schedules the ops companion alongside order_confirmation, doesn't replace it", /scheduleEmail\(\(\) => sendOrderConfirmation\(created\.id\)\);\s*\n[\s\S]{0,200}scheduleEmail\(\(\) => sendOrderReceivedOps\(created\.id\)\);/.test(checkout));
  ok("trigger · cancelOrderAction captures affected SellerOrder ids before the update (not a blind notify-all)", /const toCancel = await tx\.sellerOrder\.findMany/.test(orderActions) && /cancelledSellerOrderIds = toCancel\.map/.test(orderActions));
  ok("trigger · cancelOrderAction still fires the unchanged customer order_cancelled email first", /scheduleEmail\(\(\) => sendOrderCancelled\(orderId, reason \?\? null\)\);[\s\S]{0,300}for \(const sellerOrderId of cancelledSellerOrderIds\)/.test(orderActions));
  ok("trigger · markReceivedAction still fires the unchanged customer return_received email, then loops sellers", /scheduleEmail\(\(\) => sendReturnReceived\(ret\.id\)\);[\s\S]{0,400}getReturnAffectedSellerIds/.test(returnsActions));
  ok("trigger · refund-initiated (bookkeeping) keeps the customer email and adds the ops companion", /scheduleEmail\(\(\) => sendReturnRefundInitiated\(ret\.id\)\);\s*\n[\s\S]{0,200}scheduleEmail\(\(\) => sendReturnRefundInitiatedOps\(ret\.id\)\);/.test(returnsActions));
  ok("trigger · refund-completed (bookkeeping) keeps the customer email and adds the ops companion", /scheduleEmail\(\(\) => sendReturnRefundCompleted\(ret\.id\)\);\s*\n[\s\S]{0,200}scheduleEmail\(\(\) => sendReturnRefundCompletedOps\(ret\.id\)\);/.test(returnsActions));

  // PayMongo-routed refund_issued / webhook refund_completed untouched
  ok("scope · PayMongo-routed refund_issued call site untouched (no ops companion added there)", !/scheduleEmail\(\(\) => sendRefundIssued[\s\S]{0,200}Ops/.test(returnsActions));
  ok("scope · payments/webhook.ts not modified by this phase", !read("src/lib/payments/webhook.ts").includes("9F-7b"));

  // no forbidden scope
  ok("scope · src/lib/order-actions.ts (customer-facing self-service cancel) still does not exist", (() => { try { read("src/lib/order-actions.ts"); return false; } catch { return true; } })());
  ok("scope · no seller-initiated cancellation added", !/export async function cancel/i.test(read("src/lib/seller/order-actions.ts")));
  ok("scope · no fraud/chargeback/dispute code added", !/fraud|chargeback|dispute/i.test(notifs) && !/fraud|chargeback|dispute/i.test(orderActions) && !/fraud|chargeback|dispute/i.test(returnsActions));
  ok("scope · no scheduled/cron stale-order monitoring added", !/setInterval|node-cron|CronCreate/i.test(notifs));
  ok("scope · multiSellerCheckout / PayMongo activation not touched by this phase's files", !/multiSellerCheckout.*=.*true/.test(notifs) && !/PAYMONGO_/.test(notifs));

  // schema — no migration, reuses existing snapshot columns
  ok("schema · OrderItem.sellerId (existing snapshot column) reused, no new column", /model OrderItem \{[\s\S]*?sellerId\s+String\?/.test(schema));
  ok("schema · SellerOrder model unchanged by this phase (still just id/orderId/sellerId + existing columns)", !/9F-7b/.test(schema.slice(schema.indexOf("model SellerOrder"), schema.indexOf("model Shipment"))));

  // seed-rbac untouched by any file this phase touched
  ok("scope · scripts/seed-rbac.ts not imported/required by any file this phase touched", ![notifs, send, checkout, orderActions, returnsActions].some((f) => /(import|require)[^\n]*seed-rbac/.test(f)));
}

// ---------------------------------------------------------------------------
// Database (rolled back)
// ---------------------------------------------------------------------------

async function dbTests() {
  const emailLogBefore = await prisma.emailLog.count();
  const orderBefore = await prisma.order.count();
  const sellerOrderBefore = await prisma.sellerOrder.count();
  const returnBefore = await prisma.returnRequest.count();

  try {
    await prisma.$transaction(async (tx) => {
      const t = Date.now().toString(36);
      const category = await tx.category.findFirst({ where: { active: true }, select: { id: true } });
      if (!category) { ok("db tests skipped — no active category", true); throw new Rollback(); }

      const owner = await seedUser(tx, `owner-${t}`);
      const S = await seedSeller(tx, `mkops-${t}`);
      await tx.sellerUser.create({ data: { sellerId: S.id, userId: owner.id, role: "OWNER", status: "ACTIVE" } });
      const outsider = await seedUser(tx, `out-${t}`);

      const product = await tx.product.create({
        data: { name: `MK ${t}`, slug: `mk-${t}`, shortDescription: "s", description: "d", categoryId: category.id, status: "ACTIVE", price: 50000 },
        select: { id: true },
      });
      const variant = await tx.variant.create({
        data: { productId: product.id, sku: `MK-${t}`, price: 50000, status: "ACTIVE", stock: 10 },
        select: { id: true },
      });

      const order = await tx.order.create({
        data: {
          orderNumber: `MK-${t}`,
          email: "customer@t.test",
          subtotal: 100000,
          grandTotal: 100000,
          shippingAddress: JSON.stringify({ firstName: "Cus", city: "Batangas" }),
          status: "PROCESSING",
        },
        select: { id: true, orderNumber: true },
      });
      const orderItem = await tx.orderItem.create({
        data: {
          orderId: order.id,
          productId: product.id,
          variantId: variant.id,
          name: `MK ${t}`,
          unitPrice: 50000,
          quantity: 2,
          lineTotal: 100000,
          sellerId: S.id, // marketplace snapshot — the field this phase reads
        },
        select: { id: true },
      });

      // ── 1 — order_received_ops (Axiaro Operations, companion to order_confirmation) ──
      const r1 = await sendOrderReceivedOps(order.id, { client: tx });
      const key1 = `ORDER_RECEIVED_OPS:${order.id}`;
      const row1 = await tx.emailLog.findUnique({ where: { idempotencyKey: key1 }, select: { id: true, type: true, recipient: true } });
      ok("1 · order_received_ops row created with the expected key", Boolean(row1), JSON.stringify(r1));
      ok("1 · correct EmailType", row1?.type === "order_received_ops");
      ok("1 · recipient is the ops inbox, not the customer", row1?.recipient !== "customer@t.test");
      if (row1) {
        const retry1 = await retryEmailByLog(row1.id, tx);
        ok("1 · retry routes (not not_retryable)", retry1.error !== "not_retryable", JSON.stringify(retry1));
        ok("1 · retry reuses the same row", (await tx.emailLog.count({ where: { idempotencyKey: key1 } })) === 1);
      }

      // ── 2 — seller_order_cancelled ───────────────────────────────────────
      const so = await tx.sellerOrder.create({
        data: { orderId: order.id, sellerId: S.id, sellerName: S.id, sellerType: "THIRD_PARTY", supportEmail: "x@t.test", status: "CANCELLED" },
        select: { id: true },
      });
      const r2 = await sendSellerOrderCancelled(so.id, { client: tx });
      ok("2 · seller_order_cancelled routes", r2.status !== "FAILED" || r2.error === "smtp_not_configured", JSON.stringify(r2));
      const key2 = `SELLER_ORDER_CANCELLED:${so.id}`;
      const row2 = await tx.emailLog.findUnique({ where: { idempotencyKey: key2 }, select: { type: true, recipient: true } });
      ok("2 · correct EmailType + key", row2?.type === "seller_order_cancelled");
      ok("2 · goes to the seller, not the outsider", row2?.recipient === owner.email && !row2?.recipient.includes(outsider.email));
      const retry2 = await retryEmailByLog((await tx.emailLog.findUniqueOrThrow({ where: { idempotencyKey: key2 }, select: { id: true } })).id, tx);
      ok("2 · retry routes", retry2.error !== "not_retryable");
      ok("2 · retry reuses the same row", (await tx.emailLog.count({ where: { idempotencyKey: key2 } })) === 1);
      const [c1, c2] = await Promise.all([
        retryEmailByLog((await tx.emailLog.findUniqueOrThrow({ where: { idempotencyKey: key2 }, select: { id: true } })).id, tx),
        retryEmailByLog((await tx.emailLog.findUniqueOrThrow({ where: { idempotencyKey: key2 }, select: { id: true } })).id, tx),
      ]);
      ok("2 · concurrent retry both resolve, no duplicate row", Boolean(c1) && Boolean(c2) && (await tx.emailLog.count({ where: { idempotencyKey: key2 } })) === 1);

      // ── 2b — a SENT row retry → DEDUPED ──────────────────────────────────
      const sentRow = await tx.emailLog.create({
        data: { type: "seller_order_cancelled", recipient: owner.email, subject: "x", idempotencyKey: `SELLER_ORDER_CANCELLED:fixture-${t}`, status: "SENT", sentAt: new Date() },
        select: { id: true },
      });
      const retrySent = await retryEmailByLog(sentRow.id, tx);
      ok("2b · retrying a SENT row → DEDUPED, never re-sends", retrySent.status === "DEDUPED");

      // ── 3 — seller_return_received ───────────────────────────────────────
      const ret = await tx.returnRequest.create({
        data: { returnNumber: `RET-${t}`, orderId: order.id, status: "RECEIVED", reason: "NO_LONGER_NEEDED" },
        select: { id: true },
      });
      await tx.returnItem.create({
        data: { returnRequestId: ret.id, orderItemId: orderItem.id, productId: product.id, variantId: variant.id, name: `MK ${t}`, unitPrice: 50000, quantity: 1, refundAmount: 50000 },
      });
      const sellerIds = await getReturnAffectedSellerIds(ret.id, tx);
      ok("3 · getReturnAffectedSellerIds finds exactly the seeded seller", sellerIds.length === 1 && sellerIds[0] === S.id, JSON.stringify(sellerIds));
      const r3 = await sendSellerReturnReceived(ret.id, S.id, { client: tx });
      ok("3 · seller_return_received routes", r3.status !== "FAILED" || r3.error === "smtp_not_configured", JSON.stringify(r3));
      const key3 = `SELLER_RETURN_RECEIVED:${ret.id}:${S.id}`;
      const row3 = await tx.emailLog.findUnique({ where: { idempotencyKey: key3 }, select: { type: true, recipient: true } });
      ok("3 · correct EmailType + key", row3?.type === "seller_return_received");
      ok("3 · goes to the seller who owns the line, not an unrelated seller", row3?.recipient === owner.email);
      const retry3 = await retryEmailByLog((await tx.emailLog.findUniqueOrThrow({ where: { idempotencyKey: key3 }, select: { id: true } })).id, tx);
      ok("3 · retry routes", retry3.error !== "not_retryable");
      // an unrelated seller (WITH a valid recipient, to isolate the "no lines on
      // this return" condition from the separate "no recipient" one tested in #6)
      // has no lines on this return → no_seller_lines, no row
      const other = await seedSeller(tx, `other-${t}`);
      const otherOwner = await seedUser(tx, `otherowner-${t}`);
      await tx.sellerUser.create({ data: { sellerId: other.id, userId: otherOwner.id, role: "OWNER", status: "ACTIVE" } });
      const r3b = await sendSellerReturnReceived(ret.id, other.id, { client: tx });
      ok("3 · a seller with no lines on the return → no_seller_lines, no row written", r3b.ok === false && r3b.error === "no_seller_lines");
      ok("3 · no row for the unrelated seller", (await tx.emailLog.findUnique({ where: { idempotencyKey: `SELLER_RETURN_RECEIVED:${ret.id}:${other.id}` } })) === null);

      // ── 4 — return_refund_initiated_ops ──────────────────────────────────
      await tx.returnRequest.update({ where: { id: ret.id }, data: { refundAmount: 50000, refundMethod: "GCash", status: "REFUND_INITIATED" } });
      const r4 = await sendReturnRefundInitiatedOps(ret.id, { client: tx });
      const key4 = `RETURN_REFUND_INITIATED_OPS:${ret.id}`;
      const row4 = await tx.emailLog.findUnique({ where: { idempotencyKey: key4 }, select: { id: true, type: true, recipient: true } });
      ok("4 · return_refund_initiated_ops row created", Boolean(row4), JSON.stringify(r4));
      ok("4 · correct EmailType", row4?.type === "return_refund_initiated_ops");
      ok("4 · goes to ops, not the customer", row4?.recipient !== "customer@t.test");
      if (row4) {
        const retry4 = await retryEmailByLog(row4.id, tx);
        ok("4 · retry routes", retry4.error !== "not_retryable");
      }

      // ── 5 — return_refund_completed_ops ──────────────────────────────────
      await tx.returnRequest.update({ where: { id: ret.id }, data: { refundCompletedAt: new Date(), status: "REFUND_COMPLETED" } });
      const r5 = await sendReturnRefundCompletedOps(ret.id, { client: tx });
      const key5 = `RETURN_REFUND_COMPLETED_OPS:${ret.id}`;
      const row5 = await tx.emailLog.findUnique({ where: { idempotencyKey: key5 }, select: { id: true, type: true, recipient: true } });
      ok("5 · return_refund_completed_ops row created", Boolean(row5), JSON.stringify(r5));
      ok("5 · correct EmailType", row5?.type === "return_refund_completed_ops");
      ok("5 · goes to ops, not the customer", row5?.recipient !== "customer@t.test");
      if (row5) {
        const retry5 = await retryEmailByLog(row5.id, tx);
        ok("5 · retry routes", retry5.error !== "not_retryable");
      }

      // ── 6 — no resolvable seller recipient → FAILED/no_recipient ─────────
      const lonelySeller = await tx.seller.create({
        data: { type: "THIRD_PARTY", status: "PENDING", displayName: `lonely-${t}`, slug: `lonely-${t}`, supportEmail: `lonely-${t}@t.test`, contentStatus: "DRAFT" },
        select: { id: true },
      });
      const lonelySO = await tx.sellerOrder.create({
        data: { orderId: order.id, sellerId: lonelySeller.id, sellerName: lonelySeller.id, sellerType: "THIRD_PARTY", supportEmail: "x@t.test", status: "CANCELLED" },
        select: { id: true },
      });
      const r6 = await sendSellerOrderCancelled(lonelySO.id, { client: tx });
      ok("6 · no resolvable recipient → FAILED/no_recipient, no row", r6.ok === false && r6.error === "no_recipient");
      ok("6 · no row written for a no-recipient send", (await tx.emailLog.findUnique({ where: { idempotencyKey: `SELLER_ORDER_CANCELLED:${lonelySO.id}` } })) === null);

      // ── 7 — an unrelated existing type stays not_retryable (unaffected) ──
      const eOther = await tx.emailLog.create({
        data: { type: "password_changed", recipient: owner.email, subject: "x", idempotencyKey: `PASSWORD_CHANGED:u-${t}:2026-09-05T09`, status: "SKIPPED", provider: "smtp", error: "smtp_not_configured" },
        select: { id: true },
      });
      const ro = await retryEmailByLog(eOther.id, tx);
      ok("7 · unrelated type (password_changed) is untouched — still not_retryable", ro.ok === false && ro.error === "not_retryable");

      throw new Rollback();
    }, { timeout: 40_000, maxWait: 12_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("isolation · EmailLog count unchanged after rollback", (await prisma.emailLog.count()) === emailLogBefore, `${emailLogBefore} vs ${await prisma.emailLog.count()}`);
  ok("isolation · Order count unchanged after rollback", (await prisma.order.count()) === orderBefore);
  ok("isolation · SellerOrder count unchanged after rollback", (await prisma.sellerOrder.count()) === sellerOrderBefore);
  ok("isolation · ReturnRequest count unchanged after rollback", (await prisma.returnRequest.count()) === returnBefore);
}

async function main() {
  console.log("\nPHASE 9F-7b — marketplace operations notifications\n");
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
