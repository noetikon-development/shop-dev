/**
 * Phase 9F-43B — COD cash collection confirmation.
 *
 * An authorized `manage_payments` admin records that Axiaro has received the
 * remitted COD cash for a DELIVERED cash-on-delivery order:
 *   Order.paymentStatus PENDING / UNPAID → PAID
 * which unlocks the 9F-42B settlement-eligibility gate. NO Payment /
 * PaymentRefund / WebhookEvent row is ever created — only an OrderEvent and an
 * AdminAuditLog row.
 *
 * DB tests build orders inside ONE prisma.$transaction and roll back. The
 * permission-gated wrapper `confirmCodPaymentAction` is verified by a static
 * assertion (`requirePermission("manage_payments")`); the behaviour is exercised
 * through the `client`-aware core `confirmCodPaymentReceived` (the same
 * core/action split as `recordSettlement` / `recordSettlementAction`).
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f43b.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { confirmCodPaymentReceived } from "../src/lib/admin/payments";
import { getSellerSettlementPreview } from "../src/lib/marketplace/settlement";

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

async function seedOrder(
  tx: Tx,
  suffix: string,
  opts: {
    status?: string;
    paymentStatus?: string;
    paymentMethod?: string;
    grandTotal?: number;
    deliveredDaysAgo?: number;
    withOnlinePayment?: boolean;
  } = {},
) {
  const grandTotal = opts.grandTotal ?? 134900;
  const deliveredAt = opts.status === "DELIVERED" ? new Date(Date.now() - (opts.deliveredDaysAgo ?? 40) * DAY) : null;
  const order = await tx.order.create({
    data: {
      orderNumber: `AX-T43B-${suffix}-${Math.random().toString(36).slice(2, 6)}`,
      email: "buyer@example.test",
      status: opts.status ?? "DELIVERED",
      paymentMethod: opts.paymentMethod ?? "NONE",
      paymentStatus: opts.paymentStatus ?? "PENDING",
      subtotal: grandTotal,
      grandTotal,
      deliveredAt,
      placedAt: new Date((deliveredAt?.getTime() ?? Date.now()) - 3 * DAY),
      shippingAddress: JSON.stringify({ firstName: "T", city: "M", country: "PH" }),
    },
    select: { id: true, orderNumber: true, grandTotal: true },
  });
  if (opts.withOnlinePayment) {
    await tx.payment.create({
      data: {
        orderId: order.id,
        provider: "paymongo",
        providerObject: "checkout_session",
        providerId: `ps_test_${suffix}_${Math.random().toString(36).slice(2, 8)}`,
        status: "AWAITING_PAYMENT",
        amount: grandTotal,
        currency: "PHP",
      },
    });
  }
  return order;
}

async function seed3pDeliveredCod(tx: Tx, suffix: string, actor: { userId: string; email: string }) {
  const category = await tx.category.findFirst({ where: { active: true }, select: { id: true } });
  const product = await tx.product.create({
    data: { name: `C43 ${suffix}`, slug: `c43-${suffix}`, shortDescription: "s", description: "d", categoryId: category!.id, status: "ACTIVE", price: 5000 },
    select: { id: true },
  });
  const variant = await tx.variant.create({
    data: { productId: product.id, sku: `C43-${suffix}`, price: 5000, status: "ACTIVE", stock: 20 },
    select: { id: true },
  });
  const seller = await tx.seller.create({
    data: { type: "THIRD_PARTY", status: "APPROVED", displayName: `c43-${suffix}`, slug: `c43-${suffix}`, supportEmail: "s@t.test", commissionRate: 1500 },
    select: { id: true, displayName: true, supportEmail: true },
  });
  const offer = await tx.offer.create({
    data: { sellerId: seller.id, variantId: variant.id, price: 5000, condition: "NEW", status: "DRAFT", sellerSku: `${suffix}-s` },
    select: { id: true },
  });
  await tx.offerInventory.create({ data: { offerId: offer.id, quantity: 10, reserved: 0, reorderPoint: 2 } });
  const deliveredAt = new Date(Date.now() - 40 * DAY);
  const order = await tx.order.create({
    data: {
      orderNumber: `AX-T43B3P-${suffix}-${Math.random().toString(36).slice(2, 6)}`,
      email: "buyer@example.test", status: "DELIVERED", paymentMethod: "NONE", paymentStatus: "PENDING",
      subtotal: 100000, grandTotal: 115000, shippingFee: 15000,
      deliveredAt, placedAt: new Date(deliveredAt.getTime() - 3 * DAY),
      shippingAddress: JSON.stringify({ firstName: "T", city: "M", country: "PH" }),
    },
    select: { id: true, orderNumber: true },
  });
  const commissionAmount = roundHalfUp((100000 * 1500) / 10000); // 15000
  const so = await tx.sellerOrder.create({
    data: {
      orderId: order.id, sellerId: seller.id, sellerName: seller.displayName, sellerType: "THIRD_PARTY",
      supportEmail: seller.supportEmail, commissionRate: 1500, merchandiseSubtotal: 100000, shippingFee: 15000,
      total: 115000, commissionAmount, status: "DELIVERED", settlementStatus: "PENDING_CAPTURE",
    },
    select: { id: true, total: true, commissionAmount: true },
  });
  await tx.orderItem.create({
    data: { orderId: order.id, sellerOrderId: so.id, sellerId: seller.id, offerId: offer.id, productId: product.id, variantId: variant.id, name: "x", unitPrice: 5000, quantity: 20, lineTotal: 100000 },
  });
  void actor;
  return { sellerId: seller.id, order, so };
}

// ---------------------------------------------------------------------------
// Static wiring
// ---------------------------------------------------------------------------

function staticTests() {
  const actions = read("src/lib/admin/payment-actions.ts");
  const core = read("src/lib/admin/payments.ts");
  const panel = read("src/components/admin/payments/payment-panel.tsx");
  const control = read("src/components/admin/payments/record-cod-payment.tsx");
  const orderPage = read("src/app/admin/(shell)/orders/[id]/page.tsx");
  const schema = read("prisma/schema.prisma");

  ok("perm · confirmCodPaymentAction requires manage_payments", /export async function confirmCodPaymentAction[\s\S]{0,200}requirePermission\("manage_payments"\)/.test(actions));
  ok("perm · the core takes an explicit actor, no requirePermission in payments.ts", /confirmCodPaymentReceived\(\s*input: ConfirmCodPaymentInput,\s*actor: \{ userId: string; email: string \}/.test(core) && !/requirePermission/.test(core));
  ok("action · delegates to the core + revalidates on a real confirm only", /confirmCodPaymentReceived\(/.test(actions) && /result\.ok && !result\.alreadyConfirmed/.test(actions) && /revalidatePath\("\/seller\/settlements"\)/.test(actions));

  ok("core · status-guarded updateMany PENDING|UNPAID + DELIVERED + NONE|COD, count must be 1", /paymentStatus: \{ in: \["PENDING", "UNPAID"\] \},\s*status: "DELIVERED",\s*paymentMethod: \{ in: \["NONE", "COD"\] \}[\s\S]{0,200}if \(res\.count !== 1\) throw new CodConfirmConflict\(\)/.test(core));
  ok("core · writes OrderEvent{status:'PAID', title:'Payment received'}", /orderEvent\.create\(\{\s*data: \{ orderId: order\.id, status: "PAID", title: "Payment received", detail: null \}/.test(core));
  ok("core · writes AdminAuditLog order.cod_payment_confirmed with amountConfirmed = grandTotal", /action: "order\.cod_payment_confirmed"/.test(core) && /amountConfirmed: order\.grandTotal,\s*grandTotal: order\.grandTotal,/.test(core));
  ok("core · amount is never operator-entered (no amount field in input / schema)", !/amount:\s*z\./.test(actions) && !/input\.amount/.test(core));
  ok("core · NO Payment / PaymentRefund / WebhookEvent write anywhere", !/\b(payment|paymentRefund|webhookEvent)\.(create|update|updateMany|upsert)\b/i.test(core.replace(/COD_ONLINE_PAYMENT_STATUSES/g, "")) && !/\b(payment|paymentRefund|webhookEvent)\.(create|update)\b/i.test(actions));
  ok("core · no reverse / un-confirm (PAID → PENDING) path", !/paymentStatus: "PENDING"[\s\S]{0,80}PAID|un-?confirm|reverseCodPayment/i.test(core));
  ok("core · CodConfirmConflict → typed INVALID_STATE result (no throw to caller)", /err instanceof CodConfirmConflict[\s\S]{0,120}code: "INVALID_STATE"/.test(core));

  ok("schema · NO new Order columns (no codPaymentConfirmedAt / codRemittanceReference)", !/codPaymentConfirmedAt|codRemittanceReference/.test(schema));
  ok("schema · NO migration referenced for 9F-43B", !/9F-43B|9f43b/i.test(read("prisma/schema.prisma")));

  ok("ui · control rendered inside PaymentPanel, gated on delivered COD awaiting payment", /RecordCodPayment/.test(panel) && /cod\?\.canRecord && !cod\.recorded && canManage/.test(panel));
  ok("ui · page computes canRecord = COD + no online payment + DELIVERED + PENDING|UNPAID", /codIsCash &&\s*!order\.hasOnlinePayment &&\s*order\.status === "DELIVERED" &&\s*\(order\.paymentStatus === "PENDING" \|\| order\.paymentStatus === "UNPAID"\)/.test(orderPage));
  ok("ui · disclaimer wording present, never implies delivery = payment", /Only after Axiaro has received the remitted cash for this order\./.test(control) && !/delivery (is|=|means) payment/i.test(control));
  ok("ui · amount is read-only Order.grandTotal, no amount input", /formatPrice\(grandTotal\)/.test(control) && !/name="amount"/.test(control));
  ok("ui · recorded state shows date + admin + reference", /COD payment recorded on \{formatDate\(cod\.recorded\.at\)\}/.test(panel) && /cod\.recorded\.reference/.test(panel));
  ok("ui · confirmation display derived from the latest order.cod_payment_confirmed audit row", /action: "order\.cod_payment_confirmed", targetType: "order", targetId: orderId/.test(core) && /getCodPaymentConfirmation/.test(orderPage));

  ok("email · NO email scheduled/sent by the COD confirmation", !/scheduleEmail|sendOrder|sendSeller|dispatchEmail/.test(core.slice(core.indexOf("confirmCodPaymentReceived"))) && !/scheduleEmail|send[A-Z]/.test(actions.slice(actions.indexOf("confirmCodPaymentAction"))));
  ok("scope · PayMongo not activated, seed-rbac untouched", !/PAYMONGO_/.test(core) && !/PAYMONGO_/.test(actions) && !/seed-rbac/.test(core) && !/seed-rbac/.test(actions));
}

// ---------------------------------------------------------------------------
// Database (rolled back)
// ---------------------------------------------------------------------------

async function dbTests() {
  const orderBefore = await prisma.order.count();
  const eventBefore = await prisma.orderEvent.count();
  const auditBefore = await prisma.adminAuditLog.count();
  const paymentBefore = await prisma.payment.count();
  const settlementBefore = await prisma.sellerSettlement.count();

  try {
    await prisma.$transaction(async (tx) => {
      const t = Date.now().toString(36);
      const u = await tx.user.findFirst({ select: { id: true, email: true } });
      if (!u) { ok("db tests skipped — no user", true); throw new Rollback(); }
      const actor = { userId: u.id, email: u.email ?? "actor@test" };

      const countEvents = (orderId: string) => tx.orderEvent.count({ where: { orderId, status: "PAID" } });
      const countAudit = (orderId: string) => tx.adminAuditLog.count({ where: { action: "order.cod_payment_confirmed", targetId: orderId } });

      // ── A — basic confirmation (COD NONE/PENDING, DELIVERED) ──────────────
      const a = await seedOrder(tx, `a-${t}`, { status: "DELIVERED", paymentStatus: "PENDING", paymentMethod: "NONE", grandTotal: 134900 });
      const ra = await confirmCodPaymentReceived({ orderId: a.id, remittanceReference: "  GC-BATCH-9  ", note: "counted at desk" }, actor, tx);
      ok("A · confirmation succeeds", ra.ok === true && !ra.alreadyConfirmed, JSON.stringify(ra));
      const aAfter = await tx.order.findUniqueOrThrow({ where: { id: a.id }, select: { paymentStatus: true } });
      ok("A · paymentStatus PENDING → PAID", aAfter.paymentStatus === "PAID");
      ok("A · exactly one OrderEvent{status:PAID}", (await countEvents(a.id)) === 1);
      ok("A · exactly one AdminAuditLog order.cod_payment_confirmed", (await countAudit(a.id)) === 1);
      const aAudit = await tx.adminAuditLog.findFirstOrThrow({ where: { action: "order.cod_payment_confirmed", targetId: a.id }, select: { meta: true, actorUserId: true } });
      const aMeta = JSON.parse(aAudit.meta);
      ok("A · audit meta amountConfirmed = grandTotal = 134900", aMeta.amountConfirmed === 134900 && aMeta.grandTotal === 134900);
      ok("A · audit meta records from/to/method/reference/note/operator", aMeta.from === "PENDING" && aMeta.to === "PAID" && aMeta.paymentMethod === "NONE" && aMeta.remittanceReference === "GC-BATCH-9" && aMeta.note === "counted at desk" && aAudit.actorUserId === actor.userId);
      ok("A · NO Payment / PaymentRefund / WebhookEvent row created", (await tx.payment.count({ where: { orderId: a.id } })) === 0);

      // ── B — UNPAID compatibility ─────────────────────────────────────────
      const b = await seedOrder(tx, `b-${t}`, { status: "DELIVERED", paymentStatus: "UNPAID", paymentMethod: "COD" });
      const rb = await confirmCodPaymentReceived({ orderId: b.id }, actor, tx);
      ok("B · COD UNPAID + DELIVERED → confirmation succeeds, paymentStatus PAID", rb.ok === true && (await tx.order.findUniqueOrThrow({ where: { id: b.id }, select: { paymentStatus: true } })).paymentStatus === "PAID");
      ok("B · one event, one audit", (await countEvents(b.id)) === 1 && (await countAudit(b.id)) === 1);

      // ── C — idempotency (second call against PAID) ───────────────────────
      const rc = await confirmCodPaymentReceived({ orderId: a.id, note: "again" }, actor, tx);
      ok("C · second call against a PAID order → { ok:true, alreadyConfirmed:true }", rc.ok === true && rc.alreadyConfirmed === true);
      ok("C · no second OrderEvent", (await countEvents(a.id)) === 1);
      ok("C · no second AdminAuditLog", (await countAudit(a.id)) === 1);

      // ── D — guards ───────────────────────────────────────────────────────
      const card = await seedOrder(tx, `d1-${t}`, { status: "DELIVERED", paymentStatus: "PENDING", paymentMethod: "CARD" });
      ok("D · CARD → HAS_ONLINE_PAYMENT", (await confirmCodPaymentReceived({ orderId: card.id }, actor, tx)).ok === false && ((await confirmCodPaymentReceived({ orderId: card.id }, actor, tx)) as { code: string }).code === "HAS_ONLINE_PAYMENT");
      const gcash = await seedOrder(tx, `d2-${t}`, { status: "DELIVERED", paymentStatus: "PENDING", paymentMethod: "GCASH" });
      ok("D · GCASH → NOT_COD", ((await confirmCodPaymentReceived({ orderId: gcash.id }, actor, tx)) as { code: string }).code === "NOT_COD");
      const withPay = await seedOrder(tx, `d3-${t}`, { status: "DELIVERED", paymentStatus: "PENDING", paymentMethod: "NONE", withOnlinePayment: true });
      ok("D · any active Payment row → HAS_ONLINE_PAYMENT", ((await confirmCodPaymentReceived({ orderId: withPay.id }, actor, tx)) as { code: string }).code === "HAS_ONLINE_PAYMENT");
      const notDelivered = await seedOrder(tx, `d4-${t}`, { status: "PROCESSING", paymentStatus: "PENDING", paymentMethod: "NONE" });
      ok("D · not DELIVERED → NOT_DELIVERED", ((await confirmCodPaymentReceived({ orderId: notDelivered.id }, actor, tx)) as { code: string }).code === "NOT_DELIVERED");
      const cancelled = await seedOrder(tx, `d5-${t}`, { status: "CANCELLED", paymentStatus: "PENDING", paymentMethod: "NONE" });
      ok("D · CANCELLED → CANCELLED", ((await confirmCodPaymentReceived({ orderId: cancelled.id }, actor, tx)) as { code: string }).code === "CANCELLED");
      const refunded = await seedOrder(tx, `d6-${t}`, { status: "DELIVERED", paymentStatus: "REFUNDED", paymentMethod: "NONE" });
      ok("D · REFUNDED → REFUNDED", ((await confirmCodPaymentReceived({ orderId: refunded.id }, actor, tx)) as { code: string }).code === "REFUNDED");
      const partial = await seedOrder(tx, `d7-${t}`, { status: "DELIVERED", paymentStatus: "PARTIALLY_REFUNDED", paymentMethod: "NONE" });
      ok("D · PARTIALLY_REFUNDED → REFUNDED", ((await confirmCodPaymentReceived({ orderId: partial.id }, actor, tx)) as { code: string }).code === "REFUNDED");
      const weird = await seedOrder(tx, `d8-${t}`, { status: "DELIVERED", paymentStatus: "AWAITING_REVIEW", paymentMethod: "NONE" });
      ok("D · unknown paymentStatus + DELIVERED → INVALID_STATE", ((await confirmCodPaymentReceived({ orderId: weird.id }, actor, tx)) as { code: string }).code === "INVALID_STATE");
      const missing = await confirmCodPaymentReceived({ orderId: "does-not-exist" }, actor, tx);
      ok("D · missing order → NOT_FOUND", missing.ok === false && (missing as { code: string }).code === "NOT_FOUND");
      // no writes on any rejection
      ok("D · no OrderEvent / audit written on any rejected order", (await countEvents(card.id)) === 0 && (await countEvents(gcash.id)) === 0 && (await countEvents(notDelivered.id)) === 0 && (await countEvents(cancelled.id)) === 0 && (await countEvents(refunded.id)) === 0 && (await countAudit(weird.id)) === 0);

      // ── E — concurrency: status-guarded update returns count 0 ───────────
      // Simulate a lost race: seed a COD/DELIVERED/PENDING order, flip its status
      // out from under the write inside the same tx, then confirm. The pre-read
      // sees PENDING+DELIVERED but the guarded updateMany matches 0 rows.
      // (Direct simulation: the core re-reads then writes; to force count 0 we
      // change the row between — do it by giving a second order the same id path
      // is impossible, so instead assert the guard behaviour via a PAID flip.)
      const e = await seedOrder(tx, `e-${t}`, { status: "DELIVERED", paymentStatus: "PENDING", paymentMethod: "NONE" });
      await tx.order.update({ where: { id: e.id }, data: { paymentStatus: "PAID" } }); // concurrent confirm landed first
      const re = await confirmCodPaymentReceived({ orderId: e.id }, actor, tx);
      ok("E · a concurrently-confirmed order → alreadyConfirmed, no new writes", re.ok === true && re.alreadyConfirmed === true && (await countEvents(e.id)) === 0 && (await countAudit(e.id)) === 0);
      // and the true guarded-write miss (status changed to non-DELIVERED after the read is impossible to interleave here;
      // the WHERE clause + `if (res.count !== 1) throw` is covered by the static assertion above).

      // ── F — settlement wiring ────────────────────────────────────────────
      const f = await seed3pDeliveredCod(tx, `f-${t}`, actor);
      let pv = await getSellerSettlementPreview(f.sellerId, tx);
      ok("F · before confirmation: 3P COD order excluded from settlement preview", !pv.eligibleOrders.some((o) => o.orderNumber === f.order.orderNumber) && pv.eligibleOrders.length === 0);
      const rf = await confirmCodPaymentReceived({ orderId: f.order.id }, actor, tx);
      ok("F · confirmCodPaymentReceived succeeds; paymentStatus PAID", rf.ok === true && (await tx.order.findUniqueOrThrow({ where: { id: f.order.id }, select: { paymentStatus: true } })).paymentStatus === "PAID");
      pv = await getSellerSettlementPreview(f.sellerId, tx);
      const row = pv.eligibleOrders.find((o) => o.orderNumber === f.order.orderNumber);
      ok("F · after confirmation: order is settlement-eligible", !!row);
      ok("F · receivable = SellerOrder.total - SellerOrder.commissionAmount (115000 - 15000 = 100000)", row?.receivable === f.so.total - f.so.commissionAmount && row?.receivable === 100000, JSON.stringify(row));

      // ── G — real production order AX-260907-100348 (inspect only) ────────
      const ax = await tx.order.findFirst({ where: { orderNumber: "AX-260907-100348" }, select: { id: true, paymentStatus: true, paymentMethod: true, status: true } });
      if (ax) {
        ok("G · AX-260907-100348 is still PENDING / NONE / DELIVERED (untouched)", ax.paymentStatus === "PENDING" && ax.paymentMethod === "NONE" && ax.status === "DELIVERED", JSON.stringify(ax));
        ok("G · AX-260907-100348 has NO cod_payment_confirmed audit / PAID event", (await tx.adminAuditLog.count({ where: { action: "order.cod_payment_confirmed", targetId: ax.id } })) === 0 && (await tx.orderEvent.count({ where: { orderId: ax.id, status: "PAID" } })) === 0);
        const axSo = await tx.sellerOrder.findFirst({ where: { orderId: ax.id }, select: { sellerId: true } });
        const axPv = axSo ? await getSellerSettlementPreview(axSo.sellerId, tx) : null;
        ok("G · AX-260907-100348 not in settlement preview (still PENDING)", !axPv || !axPv.eligibleOrders.some((o) => o.orderNumber === "AX-260907-100348"));
        // DO NOT call confirmCodPaymentReceived on it.
      } else {
        ok("G · (AX-260907-100348 not in this DB — skipped)", true);
      }

      throw new Rollback();
    }, { timeout: 120_000, maxWait: 15_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("isolation · Order count unchanged after rollback", (await prisma.order.count()) === orderBefore);
  ok("isolation · OrderEvent count unchanged after rollback", (await prisma.orderEvent.count()) === eventBefore);
  ok("isolation · AdminAuditLog count unchanged after rollback", (await prisma.adminAuditLog.count()) === auditBefore);
  ok("isolation · Payment count unchanged after rollback", (await prisma.payment.count()) === paymentBefore);
  ok("isolation · SellerSettlement count unchanged after rollback", (await prisma.sellerSettlement.count()) === settlementBefore);
}

async function main() {
  console.log("\nPHASE 9F-43B — COD cash collection confirmation\n");
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
