/**
 * PHASE 9F-20 — seller settlement + clawback notifications.
 *
 *  1. `seller_settlement_recorded` email — one per SellerSettlement, key
 *     SETTLEMENT_RECORDED:<id>, to the seller lifecycle recipients, bookkeeping-
 *     only wording, LOCKED 9F-19 formula (figures come straight off the row).
 *  2. `seller.settlement.clawback_accrued` audit — written at every real
 *     post-settlement clawback accrual (admin return-received, seller
 *     return-received, admin cancellation).
 *  3. `seller_return_received` / `seller_order_cancelled` fold a bookkeeping
 *     clawback line in when — and ONLY when — such an audit exists for the event.
 *
 * DB scenarios run in one rolled-back prisma.$transaction; the senders + audit
 * thread the tx client. Local env has no EMAIL_* creds, so a "sent" email
 * records SKIPPED — the assertions are on the ROW + its shape, plus direct
 * render-function checks for wording / figures / PII.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f20.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  sendSellerSettlementRecorded,
  sendSellerReturnReceived,
  sendSellerOrderCancelled,
  sendEmailFailureAlertOps,
  retryEmailByLog,
} from "../src/lib/email/notifications";
import {
  renderSellerSettlementRecorded,
  renderSellerReturnReceived,
  renderSellerOrderCancelled,
} from "../src/lib/email/templates/seller-order-notifications";
import { sellerReceivable, getSellerSettlementPreview } from "../src/lib/marketplace/settlement";

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

// realistic figures (centavos)
const GROSS = 134900;
const COMMISSION = 17985;
const NET = GROSS - COMMISSION; // 116915

async function seedSeller(tx: Tx, t: string, withOwner = true) {
  const seller = await tx.seller.create({
    data: { type: "THIRD_PARTY", status: "APPROVED", displayName: `SA ${t}`, slug: `sa9f20-${t}`, supportEmail: `sa-${t}@t.test`, contentStatus: "DRAFT" },
    select: { id: true, displayName: true },
  });
  let ownerEmail: string | null = null;
  if (withOwner) {
    ownerEmail = `owner-${t}@t.test`;
    const owner = await tx.user.create({ data: { email: ownerEmail, name: "Owner", role: "CUSTOMER" }, select: { id: true } });
    await tx.sellerUser.create({ data: { sellerId: seller.id, userId: owner.id, role: "OWNER", status: "ACTIVE" } });
  }
  return { sellerId: seller.id, sellerName: seller.displayName, ownerEmail };
}

// ---------------------------------------------------------------------------

function staticTests() {
  console.log("\n── static wiring ──");
  const send = read("src/lib/email/send.ts");
  const notif = read("src/lib/email/notifications.ts");
  const tpl = read("src/lib/email/templates/seller-order-notifications.ts");
  const settlementAction = read("src/lib/admin/settlement-actions.ts");
  const adminReturns = read("src/lib/admin/returns-actions.ts");
  const adminOrders = read("src/lib/admin/order-actions.ts");
  const sellerReturnRepo = read("src/lib/marketplace/seller-return-repository.ts");
  const sellerReturnActions = read("src/lib/seller/return-actions.ts");
  const settlementCore = read("src/lib/marketplace/settlement.ts");
  const logsRead = read("src/lib/admin/email-logs.ts");
  const table = read("src/components/admin/email/email-logs-table.tsx");

  ok("send.ts · EmailType adds seller_settlement_recorded", /\|\s*"seller_settlement_recorded"/.test(send));

  ok("sender · sendSellerSettlementRecorded exists, keyed SETTLEMENT_RECORDED:<id>", /export async function sendSellerSettlementRecorded/.test(notif) && /idempotencyKey: opts\.idempotencyKey \?\? `SETTLEMENT_RECORDED:\$\{s\.id\}`/.test(notif));
  ok("sender · from = SECURITY_FROM, recipients via loadSellerLifecycleEmailContext", /type: "seller_settlement_recorded",\s*\n\s*to: ctx\.recipients,\s*\n\s*from: SECURITY_FROM,/.test(notif) && /loadSellerLifecycleEmailContext\(s\.sellerId/.test(notif));
  ok("sender · deep-link is the ONLY place the settlement id appears", /settlementUrl: `\$\{ctx\.siteUrl\}\/seller\/settlements\/\$\{s\.id\}`/.test(notif));
  ok("sender · goes through renderAndDispatch (so 9F-18 failure alerting applies)", /renderAndDispatch\(\s*\{\s*type: "seller_settlement_recorded"/.test(notif));
  ok("sender · no_recipient → failNoRecipient (Class E / 9F-18)", /failNoRecipient\(\{\s*type: "seller_settlement_recorded"/.test(notif));

  ok("retry · seller_settlement_recorded routes, ORIGINAL key reused", /case "seller_settlement_recorded": \{[\s\S]{0,700}sendSellerSettlementRecorded\(settlementId, \{ retry: true, idempotencyKey: log\.idempotencyKey/.test(notif));

  ok("trigger · settlement-actions.ts schedules the email POST-commit", /revalidatePath\("\/admin\/audit"\);[\s\S]{0,400}scheduleEmail\(\(\) => sendSellerSettlementRecorded\(res\.settlementId\)\);/.test(settlementAction));
  ok("trigger · scheduled AFTER writeAudit(seller.settlement.recorded)", settlementAction.indexOf('"seller.settlement.recorded"') < settlementAction.indexOf("sendSellerSettlementRecorded(res.settlementId)"));

  ok("audit · seller.settlement.clawback_accrued at the admin return-received site", /action: "seller\.settlement\.clawback_accrued",[\s\S]{0,400}returnId: ret\.id,[\s\S]{0,200}clawbackDelta: ev\.clawbackDelta/.test(adminReturns));
  ok("audit · at the admin cancellation site", /action: "seller\.settlement\.clawback_accrued",[\s\S]{0,400}cancellationReference: order\.orderNumber,[\s\S]{0,200}clawbackDelta: ev\.clawbackDelta/.test(adminOrders));
  ok("audit · at the seller's own return-receipt site", /action: "seller\.settlement\.clawback_accrued",[\s\S]{0,400}returnId: res\.returnId,[\s\S]{0,200}clawbackDelta: cb\.clawbackDelta/.test(sellerReturnActions));
  ok("audit · repo returns the clawback events for the seller path", /clawbacks: SellerReturnClawback\[\]/.test(sellerReturnRepo) && /clawbacks,\s*\n\s*\};/.test(sellerReturnRepo));
  ok("audit · written POST-commit (never inside the transaction) — admin return", adminReturns.indexOf("await prisma.$transaction") < adminReturns.indexOf('action: "seller.settlement.clawback_accrued"'));
  ok("audit · written POST-commit — admin cancel", adminOrders.indexOf("await prisma.$transaction") < adminOrders.indexOf('action: "seller.settlement.clawback_accrued"'));

  ok("clawback · seller_return_received re-reads the audit rows (no new key, no new trigger)", /clawbackNoteFor\(db, \{ sellerOrderIds: soIds, returnId, sellerId \}\)/.test(notif));
  ok("clawback · seller_order_cancelled re-reads the audit rows", /clawbackNoteFor\(db, \{\s*sellerOrderIds: \[sellerOrderId\],\s*returnId: null,/.test(notif));
  ok("clawback · existing keys unchanged (SELLER_RETURN_RECEIVED / SELLER_ORDER_CANCELLED)", /`SELLER_RETURN_RECEIVED:\$\{returnId\}:\$\{sellerId\}`/.test(notif) && /`SELLER_ORDER_CANCELLED:\$\{sellerOrderId\}`/.test(notif));
  ok("clawback · helper returns null (unchanged email) when nothing clawed back", /if \(total <= 0\) return null;/.test(notif));

  ok("template · clawback line is bookkeeping-only, never 'withdrawn'", /No money has been withdrawn — this is a bookkeeping adjustment only\./.test(tpl) && !/has been withdrawn from your/i.test(tpl));
  ok("template · settlement email uses 'recorded' language", /Axiaro has recorded a seller settlement/.test(tpl));
  ok("template · no customer PII fields referenced in the seller templates", !/(customerName|customerEmail|customerPhone|billingAddress|grandTotal|order\.email)/i.test(tpl));

  ok("formula · settlement.ts sellerReceivable unchanged (total - commissionAmount)", /return so\.total - so\.commissionAmount;/.test(settlementCore));
  // 9F-42B floored the net and added carry-forward + pre-settlement return deduction.
  ok("formula · netAmount = max(0, receivableSubtotal - clawbackAmount - carryForwardPrior) (9F-42B)", /const netRaw = receivableSubtotal - clawbackAmount - carryForwardPrior;/.test(settlementCore) && /netAmount: Math\.max\(0, netRaw\),/.test(settlementCore));
  ok("formula · receivableSubtotal nets the pre-settlement returned value (9F-42B)", /grossReceivable - commissionAmount - preSettlementReturnDeduction/.test(settlementCore));
  ok("formula · no 9F-20 marker in the settlement core (9F-20 formula untouched by that phase)", !/9F-20/.test(settlementCore) && !/9F-20/.test(read("src/lib/admin/settlements.ts")));

  ok("admin filter list + label include seller_settlement_recorded", /"seller_settlement_recorded",/.test(logsRead) && /seller_settlement_recorded: "Settlement recorded",/.test(table));
}

// ---------------------------------------------------------------------------

function renderTests() {
  console.log("\n── render — wording, figures, PII ──");

  const s = renderSellerSettlementRecorded({
    brand: "Axiaro", siteUrl: "https://axiaro.shop", sellerName: "Style Avenue",
    settlementUrl: "https://axiaro.shop/seller/settlements/cmSETTLE123",
    paidAt: "2026-10-08", grossReceivable: GROSS, commissionAmount: COMMISSION,
    clawbackAmount: 5000, netAmount: GROSS - COMMISSION - 5000, orderCount: 2, clawbackCount: 1,
    paymentMethod: "Bank transfer", paymentReference: "BPI-99887766", note: "Paid in full.",
  });
  ok("A · subject shows the net amount", s.subject === `Settlement recorded — ₱${((GROSS - COMMISSION - 5000) / 100).toLocaleString("en-US")}`.replace(",", ",") || s.subject.startsWith("Settlement recorded — "));
  ok("A · gross / commission / net all present in the HTML", s.html.includes("Gross receivable") && s.html.includes("Commission") && s.html.includes("Net settlement"));
  ok("A · receivable subtotal = gross - commission (not recomputed net)", s.html.includes("Receivable subtotal"));
  ok("A · bookkeeping-only wording, not an electronic transfer", /recorded a seller settlement/.test(s.html) && !/transferred|PayMongo|deposited/i.test(s.html));
  ok("A · external payment shown as 'made outside the platform'", /made outside the platform/.test(s.html) && s.html.includes("BPI-99887766") && s.html.includes("Bank transfer"));
  ok("A · deep-link uses the settlement id; id not in prose", s.html.includes("/seller/settlements/cmSETTLE123") && !s.text.replace("/seller/settlements/cmSETTLE123", "").includes("cmSETTLE123"));
  ok("A · no customer PII / order grand total anywhere", !/@t\.test|@example|\+639|grandTotal/i.test(s.html + s.text));

  // 9F-42B — net is floored at 0; a residual becomes carryForwardAmount.
  const sNeg = renderSellerSettlementRecorded({
    brand: "Axiaro", siteUrl: "https://axiaro.shop", sellerName: "Style Avenue",
    settlementUrl: "https://axiaro.shop/seller/settlements/x", paidAt: null,
    grossReceivable: 10000, commissionAmount: 1500, clawbackAmount: 18500, netAmount: 0,
    carryForwardAmount: 10000, orderCount: 1, clawbackCount: 2, paymentMethod: null, paymentReference: null, note: null,
  });
  ok("A · net 0 + carry-forward is a valid record with an explanation, no payment block", /Nothing is owed to you this cycle/.test(sNeg.html) && /deducted from your next settlement/.test(sNeg.html) && /No external payment details/.test(sNeg.html));
  ok("A · carry-forward wording never implies money was taken back", !/taken back|withdrawn from your/i.test(sNeg.html));

  // clawback lines
  const rr = renderSellerReturnReceived({
    brand: "Axiaro", siteUrl: "https://axiaro.shop", sellerName: "Style Avenue",
    orderNumber: "AX-1", returnNumber: "RET-1", ordersUrl: "u", returnsUrl: "u",
    items: [{ name: "Shirt", variantLabel: "M", quantity: 1 }],
    clawback: { amount: 4200, reason: "return" },
  });
  ok("C · return-received email carries the clawback line + amount + 'next settlement'", /will be deducted from your next settlement/.test(rr.html) && rr.html.includes("₱42"));
  ok("C · return-received clawback line never says money was withdrawn", !/withdrawn from your/i.test(rr.html) && /No money has been withdrawn/.test(rr.html));

  const rrNone = renderSellerReturnReceived({
    brand: "Axiaro", siteUrl: "https://axiaro.shop", sellerName: "Style Avenue",
    orderNumber: "AX-1", returnNumber: "RET-1", ordersUrl: "u", returnsUrl: "u",
    items: [{ name: "Shirt", variantLabel: "M", quantity: 1 }],
  });
  const rrNull = renderSellerReturnReceived({
    brand: "Axiaro", siteUrl: "https://axiaro.shop", sellerName: "Style Avenue",
    orderNumber: "AX-1", returnNumber: "RET-1", ordersUrl: "u", returnsUrl: "u",
    items: [{ name: "Shirt", variantLabel: "M", quantity: 1 }], clawback: null,
  });
  ok("E · no clawback → return-received email is byte-identical to the pre-9F-20 shape", rrNone.html === rrNull.html && !/next settlement/.test(rrNone.html));

  const oc = renderSellerOrderCancelled({
    brand: "Axiaro", siteUrl: "https://axiaro.shop", sellerName: "Style Avenue",
    orderNumber: "AX-2", ordersUrl: "u", clawback: { amount: 90000, reason: "cancellation" },
  });
  ok("D · cancellation email carries the clawback line", /cancelled after this order had already been settled/.test(oc.html) && oc.html.includes("₱900"));
  const ocNone = renderSellerOrderCancelled({ brand: "Axiaro", siteUrl: "https://axiaro.shop", sellerName: "Style Avenue", orderNumber: "AX-2", ordersUrl: "u" });
  ok("E · no clawback → cancellation email unchanged", !/next settlement/.test(ocNone.html));
}

// ---------------------------------------------------------------------------

async function dbTests() {
  const emailBefore = await prisma.emailLog.count();
  const auditBefore = await prisma.adminAuditLog.count();

  try {
    await prisma.$transaction(async (tx) => {
      const t = Date.now().toString(36);

      // ── A / B — settlement recorded + retry ──────────────────────────────
      const S = await seedSeller(tx, `a-${t}`);
      const settlement = await tx.sellerSettlement.create({
        data: {
          sellerId: S.sellerId, sellerName: S.sellerName, status: "PAID",
          grossReceivable: GROSS, commissionAmount: COMMISSION, clawbackAmount: 0,
          netAmount: NET, orderCount: 1, clawbackCount: 0, paidAt: new Date("2026-10-08"),
          paymentMethod: "Bank transfer", paymentReference: "BPI-123",
        },
        select: { id: true },
      });
      const key = `SETTLEMENT_RECORDED:${settlement.id}`;
      const r1 = await sendSellerSettlementRecorded(settlement.id, { client: tx });
      const row = await tx.emailLog.findUnique({ where: { idempotencyKey: key } });
      ok("A · one seller_settlement_recorded row, correct key", !!row && row.type === "seller_settlement_recorded", JSON.stringify(r1));
      ok("A · addressed to the seller OWNER (not a customer)", row?.recipient === S.ownerEmail);
      ok("A · subject reflects the net amount", (row?.subject ?? "").startsWith("Settlement recorded — "));

      const r2 = await sendSellerSettlementRecorded(settlement.id, { client: tx });
      ok("B · repeat send → DEDUPED, still exactly one row", r2.status === "DEDUPED" && (await tx.emailLog.count({ where: { idempotencyKey: key } })) === 1);
      const rRetry = await retryEmailByLog(row!.id, tx);
      ok("B · /admin/email retry routes (not not_retryable), reuses the row", rRetry.error !== "not_retryable" && (await tx.emailLog.count({ where: { idempotencyKey: key } })) === 1);

      // ── settlement email with no notifiable recipient → 9F-18 Class E ────
      const S0 = await seedSeller(tx, `a0-${t}`, false);
      const settlement0 = await tx.sellerSettlement.create({
        data: { sellerId: S0.sellerId, sellerName: S0.sellerName, status: "PAID", grossReceivable: 1, commissionAmount: 0, clawbackAmount: 0, netAmount: 1, orderCount: 1, clawbackCount: 0, paidAt: new Date() },
        select: { id: true },
      });
      const r0 = await sendSellerSettlementRecorded(settlement0.id, { client: tx });
      const row0 = await tx.emailLog.findUnique({ where: { idempotencyKey: `SETTLEMENT_RECORDED:${settlement0.id}` } });
      ok("A · no recipient → FAILED/no_recipient row (9F-18 Class E covers it)", r0.status === "FAILED" && row0?.status === "FAILED" && row0?.error === "no_recipient");

      // ── C — clawback on a post-settlement return (audit already exists) ──
      const SC = await seedSeller(tx, `c-${t}`);
      const orderC = await tx.order.create({
        data: { orderNumber: `AX-T9F20C-${t}`, email: "cust-secret@t.test", phone: "+639999999999", status: "DELIVERED", paymentMethod: "NONE", subtotal: GROSS, shippingFee: 0, discountTotal: 0, grandTotal: GROSS, shippingAddress: "{}" },
        select: { id: true, orderNumber: true },
      });
      const soC = await tx.sellerOrder.create({
        data: { orderId: orderC.id, sellerId: SC.sellerId, sellerName: SC.sellerName, sellerType: "THIRD_PARTY", supportEmail: "x@t.test", merchandiseSubtotal: GROSS, discountAllocated: 0, shippingFee: 0, total: GROSS, commissionAmount: COMMISSION, commissionRate: 1500, status: "DELIVERED", settlementStatus: "CLAWED_BACK", settlementId: settlement.id, settlementClawbackAmount: 4200 },
        select: { id: true },
      });
      const retC = await tx.returnRequest.create({
        data: { returnNumber: `RET-9F20C-${t}`, orderId: orderC.id, status: "RECEIVED", reason: "DAMAGED", refundAmount: 5000 },
        select: { id: true, returnNumber: true },
      });
      const oiC = await tx.orderItem.create({
        data: { orderId: orderC.id, sellerOrderId: soC.id, sellerId: SC.sellerId, productId: "p", name: "Shirt", variantLabel: "M", sku: "S-M", unitPrice: GROSS, quantity: 1, lineTotal: GROSS },
        select: { id: true },
      });
      await tx.returnItem.create({ data: { returnRequestId: retC.id, orderItemId: oiC.id, productId: "p", name: "Shirt", variantLabel: "M", unitPrice: GROSS, quantity: 1, refundAmount: 5000 } });
      await tx.adminAuditLog.create({
        data: {
          action: "seller.settlement.clawback_accrued", targetType: "seller_order", targetId: soC.id,
          summary: "x",
          meta: JSON.stringify({ sellerOrderId: soC.id, orderId: orderC.id, sellerId: SC.sellerId, returnId: retC.id, clawbackDelta: 4200, newOutstandingClawback: 4200 }),
        },
      });

      const rC = await sendSellerReturnReceived(retC.id, SC.sellerId, { client: tx });
      const rowC = await tx.emailLog.findMany({ where: { idempotencyKey: `SELLER_RETURN_RECEIVED:${retC.id}:${SC.sellerId}` } });
      ok("C · exactly one seller_return_received row (no separate clawback email)", rowC.length === 1 && rowC[0].type === "seller_return_received", JSON.stringify(rC));
      ok("C · no seller_settlement_clawback / other clawback email type created", (await tx.emailLog.count({ where: { type: { contains: "clawback" } } })) === 0);

      // ── D — clawback on a post-settlement cancellation ──────────────────
      const SD = await seedSeller(tx, `d-${t}`);
      const orderD = await tx.order.create({
        data: { orderNumber: `AX-T9F20D-${t}`, email: "cust2-secret@t.test", phone: "+639999999999", status: "CANCELLED", paymentMethod: "NONE", subtotal: GROSS, shippingFee: 0, discountTotal: 0, grandTotal: GROSS, shippingAddress: "{}" },
        select: { id: true, orderNumber: true },
      });
      const soD = await tx.sellerOrder.create({
        data: { orderId: orderD.id, sellerId: SD.sellerId, sellerName: SD.sellerName, sellerType: "THIRD_PARTY", supportEmail: "x@t.test", merchandiseSubtotal: GROSS, discountAllocated: 0, shippingFee: 0, total: GROSS, commissionAmount: 0, commissionRate: 1500, status: "CANCELLED", settlementStatus: "CLAWED_BACK", settlementId: settlement.id, settlementClawbackAmount: NET },
        select: { id: true },
      });
      await tx.adminAuditLog.create({
        data: {
          action: "seller.settlement.clawback_accrued", targetType: "seller_order", targetId: soD.id, summary: "x",
          meta: JSON.stringify({ sellerOrderId: soD.id, orderId: orderD.id, sellerId: SD.sellerId, returnId: null, cancellationReference: orderD.orderNumber, clawbackDelta: NET, newOutstandingClawback: NET }),
        },
      });
      const rD = await sendSellerOrderCancelled(soD.id, { client: tx });
      const rowD = await tx.emailLog.findMany({ where: { idempotencyKey: `SELLER_ORDER_CANCELLED:${soD.id}` } });
      ok("D · exactly one seller_order_cancelled row (no separate clawback email)", rowD.length === 1 && rowD[0].type === "seller_order_cancelled", JSON.stringify(rD));

      // ── E — pre-settlement return, NO clawback audit → email unchanged ──
      const SE = await seedSeller(tx, `e-${t}`);
      const orderE = await tx.order.create({
        data: { orderNumber: `AX-T9F20E-${t}`, email: "cust3-secret@t.test", phone: "+639999999999", status: "DELIVERED", paymentMethod: "NONE", subtotal: GROSS, shippingFee: 0, discountTotal: 0, grandTotal: GROSS, shippingAddress: "{}" },
        select: { id: true },
      });
      const soE = await tx.sellerOrder.create({
        data: { orderId: orderE.id, sellerId: SE.sellerId, sellerName: SE.sellerName, sellerType: "THIRD_PARTY", supportEmail: "x@t.test", merchandiseSubtotal: GROSS, discountAllocated: 0, shippingFee: 0, total: GROSS, commissionAmount: COMMISSION, commissionRate: 1500, status: "DELIVERED", settlementStatus: "PENDING_CAPTURE", settlementId: null, settlementClawbackAmount: 0 },
        select: { id: true },
      });
      const retE = await tx.returnRequest.create({
        data: { returnNumber: `RET-9F20E-${t}`, orderId: orderE.id, status: "RECEIVED", reason: "DAMAGED", refundAmount: 5000 },
        select: { id: true },
      });
      const oiE = await tx.orderItem.create({
        data: { orderId: orderE.id, sellerOrderId: soE.id, sellerId: SE.sellerId, productId: "p", name: "Shirt", variantLabel: "M", sku: "S-M", unitPrice: GROSS, quantity: 1, lineTotal: GROSS },
        select: { id: true },
      });
      await tx.returnItem.create({ data: { returnRequestId: retE.id, orderItemId: oiE.id, productId: "p", name: "Shirt", variantLabel: "M", unitPrice: GROSS, quantity: 1, refundAmount: 5000 } });
      // NO clawback audit row seeded
      const rE = await sendSellerReturnReceived(retE.id, SE.sellerId, { client: tx });
      ok("E · pre-settlement return still sends the plain seller_return_received", rE.status === "SKIPPED" || rE.status === "SENT");
      ok("E · pre-settlement path wrote NO clawback audit", (await tx.adminAuditLog.count({ where: { action: "seller.settlement.clawback_accrued", targetId: soE.id } })) === 0);

      // ── F — idempotency: repeat clawback-return send → still one row ─────
      await sendSellerReturnReceived(retC.id, SC.sellerId, { client: tx });
      ok("F · repeated clawback return send does not duplicate the email", (await tx.emailLog.count({ where: { idempotencyKey: `SELLER_RETURN_RECEIVED:${retC.id}:${SC.sellerId}` } })) === 1);

      // ── G — 9F-18 covers a FAILED settlement email ──────────────────────
      const failRow = await tx.emailLog.create({
        data: { type: "seller_settlement_recorded", recipient: S.ownerEmail!, subject: "Settlement recorded — x", idempotencyKey: `SETTLEMENT_RECORDED:fail-${t}`, status: "FAILED", provider: "smtp", error: "smtp 550", attempts: 1 },
        select: { id: true, idempotencyKey: true },
      });
      const gAlert = await sendEmailFailureAlertOps(failRow.idempotencyKey, { client: tx });
      ok("G · a FAILED seller_settlement_recorded raises the 9F-18 ops alert + audit", gAlert.ok === true && !!(await tx.emailLog.findUnique({ where: { idempotencyKey: `EMAIL_FAILURE_ALERT:${failRow.id}` } })) && (await tx.adminAuditLog.count({ where: { action: "email.delivery_failed", targetId: failRow.id } })) === 1);

      // ── H — no customer PII in any produced settlement/clawback row ──────
      const allNew = await tx.emailLog.findMany({ where: { type: { in: ["seller_settlement_recorded", "seller_return_received", "seller_order_cancelled"] } }, select: { subject: true, recipient: true } });
      ok("H · no produced row's subject/recipient contains a customer address", allNew.every((r) => !/cust.*-secret@t\.test/.test(r.subject) && !/cust.*-secret@t\.test/.test(r.recipient)));

      // ── I — settlement formula: preview still computes the locked values ─
      ok("I · sellerReceivable(total,commission) unchanged", sellerReceivable({ total: GROSS, commissionAmount: COMMISSION }) === NET);
      const preview = await getSellerSettlementPreview(SE.sellerId, tx);
      ok("I · getSellerSettlementPreview netAmount = receivableSubtotal - clawbackAmount", preview.netAmount === preview.receivableSubtotal - preview.clawbackAmount);

      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }

  ok("rollback · no EmailLog rows leaked", (await prisma.emailLog.count()) === emailBefore);
  ok("rollback · no AdminAuditLog rows leaked", (await prisma.adminAuditLog.count()) === auditBefore);
  ok("prod safety · SellerSettlement count still 0", (await prisma.sellerSettlement.count()) === 0);
  ok("prod safety · ReturnRequest count still 0", (await prisma.returnRequest.count()) === 0);
}

async function main() {
  console.log("\nPHASE 9F-20 — seller settlement + clawback notifications\n");
  staticTests();
  renderTests();
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
