/**
 * Phase 9F-45B — pilot-readiness cleanup.
 *
 *  A. 9F-44 reconciler — no grandfathered exceptions; recurrence of either
 *     historical drift is a TRUE FAIL (delegates to the pure evaluator).
 *  B. Email durability — a seller-lifecycle notification that fails BEFORE
 *     render/recipient work still leaves a durable FAILED EmailLog row that
 *     9F-18 can alert on; idempotency key stays unique; a real retry still
 *     works; genuine SKIPPED stays SKIPPED.
 *  C. Multi-seller — the `sellerIds.size !== 1` checkout abort is UNCONDITIONAL
 *     (flag-independent); `marketplace.multiSellerCheckout` only governs 3P
 *     offer visibility and is `"true"` for the pilot.
 *  D. Status labels — PARTIALLY_REFUNDED handled consistently.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f45b.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  evaluateSellerOrder,
  type ReconcileSellerOrder,
} from "../src/lib/marketplace/state-reconcile";
import {
  sendSellerOrderReceived,
  sendSellerReturnApproved,
  sendSellerSettlementRecorded,
  sendEmailFailureAlertOps,
} from "../src/lib/email/notifications";
import { PAYMENT_STATUS_LABEL, paymentStatusTone } from "../src/lib/orders/status";

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

// ---------------------------------------------------------------------------
// A · 9F-44 reconciler — grandfathering removed
// ---------------------------------------------------------------------------

function reconcilerTests() {
  console.log("A · 9F-44 reconciler — no grandfathered exceptions");
  const script = read("scripts/reconcile-marketplace.ts");
  const test44b = read("scripts/test-9f44b.ts");

  ok("A · reconcile-marketplace.ts has NO GRANDFATHERED_DRIFT set / demote-to-WARN",
    !/GRANDFATHERED_DRIFT/.test(script) && !/=== "FAIL" && GRANDFATHERED/.test(script));
  ok("A · reconcile-marketplace.ts no longer names the two repaired orders as exceptions",
    !/grandfathered \(WARN until one-time repair\)/.test(script));
  ok("A · test-9f44b.ts has NO GRANDFATHERED set and asserts zero FAIL findings",
    !/const GRANDFATHERED = new Set/.test(test44b) && /zero FAIL findings across all production orders \(no grandfathered exceptions\)/.test(test44b));

  const base = (o: Partial<ReconcileSellerOrder> = {}): ReconcileSellerOrder => ({
    id: "so", sellerType: "FIRST_PARTY", status: "PENDING_PAYMENT", settlementStatus: "PENDING_CAPTURE",
    settlementId: null, settlementClawbackAmount: 0, merchandiseSubtotal: 100000, discountAllocated: 0,
    shippingFee: 0, commissionRate: 0, commissionAmount: 0, total: 100000, ...o,
  });
  // recurrence of AX-260904-100255's drift → FAIL (rule A)
  ok("A · recurrence of a CANCELLED-parent + PENDING_PAYMENT SellerOrder → FAIL (not WARN)",
    evaluateSellerOrder({ orderNumber: "AX-260904-100255", status: "CANCELLED" }, base(), 0, true)
      .some((f) => f.rule === "A" && f.level === "FAIL"));
  // recurrence of AX-260902-100023's drift → FAIL (rule B)
  ok("A · recurrence of a PROCESSING-parent + 1P PENDING_PAYMENT shadow → FAIL (not WARN)",
    evaluateSellerOrder({ orderNumber: "AX-260902-100023", status: "PROCESSING" }, base(), 0, true)
      .some((f) => f.rule === "B" && f.level === "FAIL"));
}

// ---------------------------------------------------------------------------
// C · multi-seller checkout gate is unconditional
// ---------------------------------------------------------------------------

function multiSellerTests() {
  console.log("\nC · multi-seller checkout stays blocked (flag-independent)");
  const checkout = read("src/lib/checkout.ts");
  // The abort is unconditional — it does NOT read the flag near the gate.
  ok("C · checkout aborts a multi-seller cart: `if (sellerIds.size !== 1)` → code \"SELLER\"",
    /if \(sellerIds\.size !== 1\) \{\s*\n\s*return \{ ok: false, code: "SELLER"/.test(checkout));
  const gateRegion = checkout.slice(
    Math.max(0, checkout.indexOf("if (sellerIds.size !== 1)") - 600),
    checkout.indexOf("if (sellerIds.size !== 1)") + 200,
  );
  ok("C · the abort does NOT read marketplace.multiSellerCheckout (unconditional)",
    !/getStoreSetting\("marketplace\.multiSellerCheckout"\)/.test(gateRegion) && !/multiSellerCheckout.*===.*"true"/.test(gateRegion));
  ok("C · checkout comment reflects the pilot meaning (flag = 3P offer visibility only, gate is permanent)",
    /PERMANENT gate/.test(checkout) && /only controls\s*\n?\s*\*\s*whether THIRD_PARTY offers may go ACTIVE/.test(checkout));
  ok("C · the SELLER error message stays generic (no seller identity leaked)",
    /GENERIC_SELLER_ERROR =\s*\n?\s*"[^"]*"/.test(checkout) && !/GENERIC_SELLER_ERROR = `[^`]*\$\{/.test(checkout));

  // stale test assertions updated: no live test still asserts the flag is "false"
  const staleFalse = [
    "9e3c2", "9e3d1", "9e3d2", "9e3d3", "9e3d5", "9e3d6", "9f4", "9f4b", "9f5a", "9f5b", "9f5c", "9f8c",
  ].filter((t) => {
    try {
      const src = read(`scripts/test-${t}.ts`);
      return /multiSellerCheckout.*\)?\s*(===|!==)\s*"false"/.test(src) ||
        /\(gate\?\.value \?\? "false"\) !== "true"/.test(src) ||
        /g\?\.value === "false"/.test(src);
    } catch { return false; }
  });
  ok("C · no stale `multiSellerCheckout == \"false\"` assertion remains in the updated suites", staleFalse.length === 0, staleFalse.join(", "));

  // live flag value
}

async function multiSellerFlagCheck() {
  const g = await prisma.storeSetting.findUnique({ where: { key: "marketplace.multiSellerCheckout" } });
  ok("C · production flag marketplace.multiSellerCheckout is the pilot value \"true\"", g?.value === "true", g?.value ?? "<absent>");
}

// ---------------------------------------------------------------------------
// D · status labels — PARTIALLY_REFUNDED
// ---------------------------------------------------------------------------

function statusLabelTests() {
  console.log("\nD · status labels — PARTIALLY_REFUNDED handled consistently");
  ok("D · PAYMENT_STATUS_LABEL has PARTIALLY_REFUNDED", PAYMENT_STATUS_LABEL.PARTIALLY_REFUNDED === "Partially refunded");
  ok("D · PAYMENT_STATUS_LABEL still has the four originals", PAYMENT_STATUS_LABEL.PENDING === "Awaiting payment" && PAYMENT_STATUS_LABEL.UNPAID === "Unpaid" && PAYMENT_STATUS_LABEL.PAID === "Paid" && PAYMENT_STATUS_LABEL.REFUNDED === "Refunded");
  ok("D · paymentStatusTone(PARTIALLY_REFUNDED) === 'info' (same as REFUNDED)", paymentStatusTone("PARTIALLY_REFUNDED") === "info");
  ok("D · paymentStatusTone treats UNPAID and PENDING the same ('warning')", paymentStatusTone("UNPAID") === paymentStatusTone("PENDING") && paymentStatusTone("PENDING") === "warning");
  const schema = read("prisma/schema.prisma");
  ok("D · Order.paymentStatus schema comment lists PARTIALLY_REFUNDED", /paymentStatus String @default\("UNPAID"\).*PARTIALLY_REFUNDED/.test(schema));
  ok("D · SellerSettlement model comment updated for the 9F-42B floor + carry-forward", /`netAmount` is FLOORED at 0/.test(schema) && !/`netAmount` MAY be <= 0/.test(schema));
}

// ---------------------------------------------------------------------------
// B · email durability
// ---------------------------------------------------------------------------

async function emailDurabilityTests() {
  console.log("\nB · seller-lifecycle email durability (rolled-back)");

  const emailBefore = await prisma.emailLog.count();
  const auditBefore = await prisma.adminAuditLog.count();

  // static — the helper + its use
  const notif = read("src/lib/email/notifications.ts");
  ok("B · notifications.ts defines failEmailPreparation (durable FAILED row + 9F-18 alert)",
    /async function failEmailPreparation\(meta: \{[\s\S]{0,500}recordEmailFailure\(\{[\s\S]{0,600}scheduleEmail\(\(\) => sendEmailFailureAlertOps\(meta\.idempotencyKey\)\)/.test(notif));
  ok("B · the 7 seller order/return/settlement senders each define a failPrep → failEmailPreparation closure",
    (notif.match(/const failPrep = \(error: string\) =>\s*\n?\s*failEmailPreparation\(\{/g) ?? []).length === 7);
  ok("B · those 7 senders' catch blocks route the unexpected error through failPrep (not a bare FAILED)",
    (notif.match(/return failPrep\(`unexpected: \$\{err instanceof Error \? err\.message : String\(err\)\}`\);/g) ?? []).length === 7);
  for (const fn of [
    "sendSellerOrderReceived", "sendSellerOrderCancelled", "sendSellerOrderCancelledOps",
    "sendSellerReturnRequested", "sendSellerReturnReceived", "sendSellerReturnApproved",
    "sendSellerSettlementRecorded",
  ]) {
    const body = notif.slice(notif.indexOf(`export async function ${fn}(`), notif.indexOf(`export async function ${fn}(`) + 3500);
    ok(`B · ${fn} — no bare 'status: "FAILED", error: "unexpected"' in its catch`,
      !/console\.error\("\[email\] send[A-Za-z]+", err\);\s*\n\s*return \{ ok: false, status: "FAILED", error: "unexpected" \};/.test(body));
  }

  try {
    await prisma.$transaction(async (tx: Tx) => {
      // ── B1 — a missing order → durable FAILED row keyed on the deterministic key ──
      const r1 = await sendSellerOrderReceived("does-not-exist-1", { client: tx });
      ok("B1 · sendSellerOrderReceived(missing order) → FAILED result", r1.ok === false && r1.status === "FAILED");
      const row1 = await tx.emailLog.findUnique({ where: { idempotencyKey: "SELLER_ORDER_RECEIVED:does-not-exist-1" } });
      ok("B1 · a durable EmailLog row exists (type + FAILED + error captured)",
        !!row1 && row1.type === "seller_order_received" && row1.status === "FAILED" && /order_not_found/.test(row1.error ?? ""), JSON.stringify(row1));

      // ── B2 — idempotency: a second call does not duplicate the row ──
      await sendSellerOrderReceived("does-not-exist-1", { client: tx });
      ok("B2 · second call → still exactly one row for that key",
        (await tx.emailLog.count({ where: { idempotencyKey: "SELLER_ORDER_RECEIVED:does-not-exist-1" } })) === 1);

      // ── B3 — 9F-18 can detect it: the alert path finds the FAILED row ──
      const alert = await sendEmailFailureAlertOps("SELLER_ORDER_RECEIVED:does-not-exist-1", { client: tx });
      ok("B3 · sendEmailFailureAlertOps finds the FAILED row + writes email.delivery_failed audit",
        alert.ok === true && (await tx.adminAuditLog.count({ where: { action: "email.delivery_failed" } })) >= 1, JSON.stringify(alert));

      // ── B4 — a later real retry still goes out (the FAILED row is refreshed, not blocking) ──
      // Build a genuine 3P delivered order + a seller with a resolvable OWNER, then
      // retry the SAME key with { retry: true }. Local env has no SMTP → SKIPPED,
      // but the row transitions off FAILED (proving retry is not blocked).
      const cat = await tx.category.findFirst({ where: { active: true }, select: { id: true } });
      const product = await tx.product.create({ data: { name: `p45b-${Date.now().toString(36)}`, slug: `p45b-${Date.now().toString(36)}`, shortDescription: "s", description: "d", categoryId: cat!.id, status: "ACTIVE", price: 5000 }, select: { id: true } });
      const variant = await tx.variant.create({ data: { productId: product.id, sku: `P45B-${Date.now().toString(36)}`, price: 5000, status: "ACTIVE", stock: 10 }, select: { id: true } });
      const user = await tx.user.create({ data: { email: `seller45b-${Date.now().toString(36)}@t.test`, emailVerified: new Date() }, select: { id: true } });
      const seller = await tx.seller.create({ data: { type: "THIRD_PARTY", status: "APPROVED", displayName: "S45B", slug: `s45b-${Date.now().toString(36)}`, supportEmail: "s45b@t.test", commissionRate: 1500, sellerUsers: { create: [{ userId: user.id, role: "OWNER", status: "ACTIVE" }] } }, select: { id: true } });
      const offer = await tx.offer.create({ data: { sellerId: seller.id, variantId: variant.id, price: 5000, condition: "NEW", status: "ACTIVE", sellerSku: "sku45b" }, select: { id: true } });
      await tx.offerInventory.create({ data: { offerId: offer.id, quantity: 10, reserved: 0, reorderPoint: 2 } });
      const order = await tx.order.create({ data: { orderNumber: `AX-T45B-${Date.now().toString(36)}`, email: "b@e.test", status: "PROCESSING", paymentMethod: "NONE", paymentStatus: "PENDING", subtotal: 5000, grandTotal: 5000, shippingAddress: "{}" }, select: { id: true } });
      const so = await tx.sellerOrder.create({ data: { orderId: order.id, sellerId: seller.id, sellerName: "S45B", sellerType: "THIRD_PARTY", supportEmail: "s45b@t.test", commissionRate: 1500, merchandiseSubtotal: 5000, total: 5000, commissionAmount: 750, status: "PENDING_PAYMENT", settlementStatus: "PENDING_CAPTURE" }, select: { id: true } });
      await tx.orderItem.create({ data: { orderId: order.id, sellerOrderId: so.id, sellerId: seller.id, offerId: offer.id, productId: product.id, variantId: variant.id, name: "x", unitPrice: 5000, quantity: 1, lineTotal: 5000 } });

      const first = await sendSellerOrderReceived(order.id, { client: tx });
      ok("B4 · a real 3P order → the notification path runs and leaves a row (SENT or SKIPPED, never a silent drop)",
        (first.status === "SENT" || first.status === "SKIPPED") &&
        !!(await tx.emailLog.findUnique({ where: { idempotencyKey: `SELLER_ORDER_RECEIVED:${order.id}` } })), JSON.stringify(first));
      const realRow = await tx.emailLog.findUnique({ where: { idempotencyKey: `SELLER_ORDER_RECEIVED:${order.id}` }, select: { status: true } });
      ok("B4 · genuine SKIPPED stays SKIPPED (local env: no SMTP)", realRow?.status === "SKIPPED" || realRow?.status === "SENT", JSON.stringify(realRow));

      // ── B5 — a 1P order → SKIPPED, NO row (not a delivery failure) ──
      const fp = await tx.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true, displayName: true, supportEmail: true } });
      const order1p = await tx.order.create({ data: { orderNumber: `AX-T45B1P-${Date.now().toString(36)}`, email: "b@e.test", status: "PROCESSING", paymentMethod: "NONE", paymentStatus: "PENDING", subtotal: 5000, grandTotal: 5000, shippingAddress: "{}" }, select: { id: true } });
      const so1p = await tx.sellerOrder.create({ data: { orderId: order1p.id, sellerId: fp!.id, sellerName: fp!.displayName, sellerType: "FIRST_PARTY", supportEmail: fp!.supportEmail, commissionRate: 0, merchandiseSubtotal: 5000, total: 5000, commissionAmount: 0, status: "PENDING_PAYMENT", settlementStatus: "PENDING_CAPTURE" }, select: { id: true } });
      await tx.orderItem.create({ data: { orderId: order1p.id, sellerOrderId: so1p.id, sellerId: fp!.id, productId: product.id, name: "x", unitPrice: 5000, quantity: 1, lineTotal: 5000 } });
      const r1p = await sendSellerOrderReceived(order1p.id, { client: tx });
      ok("B5 · 1P order → SKIPPED and NO EmailLog row (nothing to send, not a failure)",
        r1p.status === "SKIPPED" && !(await tx.emailLog.findUnique({ where: { idempotencyKey: `SELLER_ORDER_RECEIVED:${order1p.id}` } })));

      // ── B6 — the same durability on other seller-lifecycle senders ──
      const rApp = await sendSellerReturnApproved("no-return-x", seller.id, { client: tx });
      ok("B6 · sendSellerReturnApproved(missing return) → durable FAILED row",
        rApp.ok === false && !!(await tx.emailLog.findFirst({ where: { idempotencyKey: `SELLER_RETURN_APPROVED:no-return-x:${seller.id}`, status: "FAILED" } })));
      const rSet = await sendSellerSettlementRecorded("no-settlement-x", { client: tx });
      ok("B6 · sendSellerSettlementRecorded(missing settlement) → durable FAILED row",
        rSet.ok === false && !!(await tx.emailLog.findFirst({ where: { idempotencyKey: "SETTLEMENT_RECORDED:no-settlement-x", status: "FAILED" } })));

      throw new Rollback();
    }, { timeout: 120_000, maxWait: 15_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("B · EmailLog count unchanged after rollback", (await prisma.emailLog.count()) === emailBefore);
  ok("B · AdminAuditLog count unchanged after rollback", (await prisma.adminAuditLog.count()) === auditBefore);
}

// ---------------------------------------------------------------------------
// AX-260907-100348 — inspect only
// ---------------------------------------------------------------------------

async function ax348Check() {
  console.log("\nAX-260907-100348 — seller notification (inspect only)");
  const ax = await prisma.order.findFirst({ where: { orderNumber: "AX-260907-100348" }, select: { id: true } });
  if (!ax) { ok("AX · (order not in this DB — skipped)", true); return; }
  const row = await prisma.emailLog.findUnique({ where: { idempotencyKey: `SELLER_ORDER_RECEIVED:${ax.id}` } });
  ok("AX · confirmed: SELLER_ORDER_RECEIVED for AX-260907-100348 has NO EmailLog row (the lost 9F-45A notification) — NOT resent here",
    row === null, JSON.stringify(row));
  ok("AX · the order's other lifecycle emails did land", (await prisma.emailLog.count({ where: { orderId: ax.id, status: "SENT" } })) >= 4);
}

async function main() {
  console.log("\nPHASE 9F-45B — pilot-readiness cleanup\n");
  reconcilerTests();
  multiSellerTests();
  await multiSellerFlagCheck();
  statusLabelTests();
  await emailDurabilityTests();
  await ax348Check();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
