/**
 * 9F-49 — rolled-back verification of `confirmCodPaymentAction` /
 * `confirmCodPaymentReceived` against the SHAPE of the real production order
 * AX-260907-100348, ahead of a genuine COD remittance.
 *
 * Follows the 9F-43B pattern: everything runs inside ONE `prisma.$transaction`
 * that ends with `throw new Rollback()`. The real order is NEVER passed to
 * `confirmCodPaymentReceived` — instead a transaction-local CLONE carrying
 * AX-260907-100348's exact values (grandTotal / SellerOrder total / commission /
 * merchandiseSubtotal / deliveredAt) is built and exercised. The real row is
 * only read, and is snapshotted before + after the whole run to prove it is
 * byte-identical.
 *
 * Verifies: PENDING → PAID transition · one OrderEvent{PAID,"Payment received"} ·
 * one AdminAuditLog{order.cod_payment_confirmed} with amountConfirmed =
 * grandTotal · every guard (NOT_FOUND / HAS_ONLINE_PAYMENT / NOT_COD / CANCELLED
 * / REFUNDED / NOT_DELIVERED / INVALID_STATE) · idempotency (2nd call →
 * alreadyConfirmed, no 2nd write) · ZERO Payment / PaymentRefund / WebhookEvent /
 * SellerSettlement creation · settlement wiring (clone stays ineligible until the
 * 30-day return window elapses, then receivable = total − commission).
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f49-cod.ts
 */
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
class Rollback extends Error {}
type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
const DAY = 24 * 60 * 60 * 1000;
const REAL = "AX-260907-100348";

/** Seed a THIRD_PARTY delivered pay-on-delivery order carrying the given values. */
async function seedClone(
  tx: Tx,
  suffix: string,
  v: {
    grandTotal: number;
    merchandiseSubtotal: number;
    shippingFee: number;
    commissionRate: number;
    commissionAmount: number;
    soTotal: number;
    deliveredAt: Date;
    orderStatus?: string;
    paymentStatus?: string;
    paymentMethod?: string;
    withOnlinePayment?: boolean;
  },
) {
  const category = await tx.category.findFirst({ where: { active: true }, select: { id: true } });
  const product = await tx.product.create({
    data: { name: `C49 ${suffix}`, slug: `c49-${suffix}`, shortDescription: "s", description: "d", categoryId: category!.id, status: "ACTIVE", price: v.merchandiseSubtotal },
    select: { id: true },
  });
  const variant = await tx.variant.create({
    data: { productId: product.id, sku: `C49-${suffix}`, price: v.merchandiseSubtotal, status: "ACTIVE", stock: 20 },
    select: { id: true },
  });
  const seller = await tx.seller.create({
    data: { type: "THIRD_PARTY", status: "APPROVED", displayName: `c49-${suffix}`, slug: `c49-${suffix}`, supportEmail: "s@t.test", commissionRate: v.commissionRate },
    select: { id: true, displayName: true, supportEmail: true },
  });
  const offer = await tx.offer.create({
    data: { sellerId: seller.id, variantId: variant.id, price: v.merchandiseSubtotal, condition: "NEW", status: "DRAFT", sellerSku: `${suffix}-s` },
    select: { id: true },
  });
  await tx.offerInventory.create({ data: { offerId: offer.id, quantity: 10, reserved: 0, reorderPoint: 2 } });
  const order = await tx.order.create({
    data: {
      orderNumber: `AX-T49-${suffix}-${Math.random().toString(36).slice(2, 6)}`,
      email: "buyer@example.test",
      status: v.orderStatus ?? "DELIVERED",
      paymentMethod: v.paymentMethod ?? "NONE",
      paymentStatus: v.paymentStatus ?? "PENDING",
      subtotal: v.merchandiseSubtotal,
      grandTotal: v.grandTotal,
      shippingFee: v.shippingFee,
      deliveredAt: v.deliveredAt,
      placedAt: new Date(v.deliveredAt.getTime() - 3 * DAY),
      shippingAddress: JSON.stringify({ firstName: "T", city: "M", country: "PH" }),
    },
    select: { id: true, orderNumber: true, grandTotal: true },
  });
  if (v.withOnlinePayment) {
    await tx.payment.create({
      data: { orderId: order.id, provider: "paymongo", providerObject: "checkout_session", providerId: `ps_test_${suffix}_${Math.random().toString(36).slice(2, 8)}`, status: "AWAITING_PAYMENT", amount: v.grandTotal, currency: "PHP" },
    });
  }
  const effectiveStatus = v.orderStatus ?? "DELIVERED";
  const so = await tx.sellerOrder.create({
    data: {
      orderId: order.id, sellerId: seller.id, sellerName: seller.displayName, sellerType: "THIRD_PARTY",
      supportEmail: seller.supportEmail, commissionRate: v.commissionRate, merchandiseSubtotal: v.merchandiseSubtotal,
      shippingFee: v.shippingFee, total: v.soTotal, commissionAmount: v.commissionAmount,
      status: effectiveStatus === "DELIVERED" ? "DELIVERED" : effectiveStatus === "CANCELLED" ? "CANCELLED" : "PROCESSING",
      settlementStatus: "PENDING_CAPTURE",
    },
    select: { id: true, total: true, commissionAmount: true },
  });
  await tx.orderItem.create({
    data: { orderId: order.id, sellerOrderId: so.id, sellerId: seller.id, offerId: offer.id, productId: product.id, variantId: variant.id, name: "x", unitPrice: v.merchandiseSubtotal, quantity: 1, lineTotal: v.merchandiseSubtotal },
  });
  return { order, so, sellerId: seller.id };
}

const orderSnapshot = (o: unknown) => JSON.stringify(o);

async function main() {
  console.log(`\n9F-49 — rolled-back COD-confirmation verification (shape of ${REAL})\n`);

  // ── BEFORE: real production snapshot ─────────────────────────────────────
  const realBefore = await prisma.order.findFirst({
    where: { orderNumber: REAL },
    select: {
      id: true, orderNumber: true, status: true, paymentStatus: true, paymentMethod: true,
      grandTotal: true, subtotal: true, deliveredAt: true, updatedAt: true,
      sellerOrders: { select: { id: true, status: true, settlementStatus: true, settlementId: true, total: true, commissionAmount: true, commissionRate: true, merchandiseSubtotal: true, shippingFee: true } },
    },
  });
  if (!realBefore) { console.error(`  FAIL  ${REAL} not found in this DB`); process.exit(1); }
  const realSo = realBefore.sellerOrders[0];
  const countsBefore = {
    Order: await prisma.order.count(), OrderEvent: await prisma.orderEvent.count(),
    AdminAuditLog: await prisma.adminAuditLog.count(), Payment: await prisma.payment.count(),
    PaymentRefund: await prisma.paymentRefund.count(), WebhookEvent: await prisma.webhookEvent.count(),
    SellerSettlement: await prisma.sellerSettlement.count(),
    OfferInventory: await prisma.offerInventory.count(), OfferAdjustment: await prisma.offerAdjustment.count(),
    Shipment: await prisma.shipment.count(), EmailLog: await prisma.emailLog.count(),
  };
  const realPaidEventsBefore = await prisma.orderEvent.count({ where: { orderId: realBefore.id, status: "PAID" } });
  const realCodAuditsBefore = await prisma.adminAuditLog.count({ where: { action: "order.cod_payment_confirmed", targetId: realBefore.id } });
  console.log(`  real ${REAL}: status=${realBefore.status} pay=${realBefore.paymentStatus} method=${realBefore.paymentMethod} grand=${realBefore.grandTotal}`);
  console.log(`  real SellerOrder: status=${realSo.status} settle=${realSo.settlementStatus}/${realSo.settlementId ?? "null"} total=${realSo.total} comm=${realSo.commissionAmount} rate=${realSo.commissionRate} merch=${realSo.merchandiseSubtotal} ship=${realSo.shippingFee}`);
  console.log(`  real deliveredAt=${realBefore.deliveredAt?.toISOString()} — return window ends ${new Date((realBefore.deliveredAt?.getTime() ?? 0) + 30 * DAY).toISOString()}\n`);

  ok("pre · real order is DELIVERED / PENDING / NONE (the workflow precondition)",
    realBefore.status === "DELIVERED" && realBefore.paymentStatus === "PENDING" && realBefore.paymentMethod === "NONE");
  ok("pre · real order has 0 PAID OrderEvent + 0 cod_payment_confirmed audit (not yet confirmed)",
    realPaidEventsBefore === 0 && realCodAuditsBefore === 0);

  const V = {
    grandTotal: realBefore.grandTotal,
    merchandiseSubtotal: realSo.merchandiseSubtotal,
    shippingFee: realSo.shippingFee,
    commissionRate: realSo.commissionRate,
    commissionAmount: realSo.commissionAmount,
    soTotal: realSo.total,
    deliveredAt: realBefore.deliveredAt ?? new Date(),
  };

  try {
    await prisma.$transaction(async (tx) => {
      const t = Date.now().toString(36);
      const u = await tx.user.findFirst({ select: { id: true, email: true } });
      if (!u) { ok("skipped — no user in DB", true); throw new Rollback(); }
      const actor = { userId: u.id, email: u.email ?? "actor@test" };
      const evCount = (id: string) => tx.orderEvent.count({ where: { orderId: id, status: "PAID" } });
      const auditCount = (id: string) => tx.adminAuditLog.count({ where: { action: "order.cod_payment_confirmed", targetId: id } });
      const settlementBase = await tx.sellerSettlement.count();

      // ── A — the exact 100348 shape (real deliveredAt) ─────────────────────
      const A = await seedClone(tx, `a-${t}`, V);
      // counts AFTER seeding the clone, BEFORE the confirm — the confirm itself
      // must not move any of these.
      const invA = await tx.offerInventory.count();
      const adjA = await tx.offerAdjustment.count();
      const shipA = await tx.shipment.count();
      const emailA = await tx.emailLog.count();
      const rA = await confirmCodPaymentReceived(
        { orderId: A.order.id, remittanceReference: "  J&T-REMIT-9F49  ", note: "9F-49 rolled-back verification" },
        actor, tx,
      );
      ok("A · confirmation succeeds (ok:true, not alreadyConfirmed)", rA.ok === true && !("alreadyConfirmed" in rA && rA.alreadyConfirmed), orderSnapshot(rA));
      const aAfter = await tx.order.findUniqueOrThrow({ where: { id: A.order.id }, select: { paymentStatus: true, updatedAt: true } });
      ok("A · paymentStatus PENDING → PAID", aAfter.paymentStatus === "PAID");
      ok("A · exactly one OrderEvent{status:PAID}", (await evCount(A.order.id)) === 1);
      const aEvent = await tx.orderEvent.findFirstOrThrow({ where: { orderId: A.order.id, status: "PAID" }, select: { title: true, detail: true } });
      ok("A · the OrderEvent is {title:'Payment received', detail:null}", aEvent.title === "Payment received" && aEvent.detail === null);
      ok("A · exactly one AdminAuditLog order.cod_payment_confirmed", (await auditCount(A.order.id)) === 1);
      const aAudit = await tx.adminAuditLog.findFirstOrThrow({ where: { action: "order.cod_payment_confirmed", targetId: A.order.id }, select: { meta: true, actorUserId: true, summary: true } });
      const m = JSON.parse(aAudit.meta);
      ok("A · audit meta amountConfirmed === grandTotal === 134900", m.amountConfirmed === V.grandTotal && m.grandTotal === V.grandTotal && m.amountConfirmed === 134900);
      ok("A · audit meta from=PENDING to=PAID method=NONE bookkeepingOnly=true", m.from === "PENDING" && m.to === "PAID" && m.paymentMethod === "NONE" && m.bookkeepingOnly === true);
      ok("A · audit meta carries the trimmed reference + note + actor", m.remittanceReference === "J&T-REMIT-9F49" && m.note === "9F-49 rolled-back verification" && aAudit.actorUserId === actor.userId);
      ok("A · NO Payment / PaymentRefund / WebhookEvent row created for the clone",
        (await tx.payment.count({ where: { orderId: A.order.id } })) === 0 &&
        (await tx.paymentRefund.count({ where: { payment: { orderId: A.order.id } } })) === 0 &&
        (await tx.webhookEvent.count()) === countsBefore.WebhookEvent);
      ok("A · NO SellerSettlement created", (await tx.sellerSettlement.count()) === settlementBase);
      ok("A · the confirm moved NO OfferInventory / OfferAdjustment / Shipment / EmailLog row (pure bookkeeping)",
        (await tx.offerInventory.count()) === invA &&
        (await tx.offerAdjustment.count()) === adjA &&
        (await tx.shipment.count()) === shipA &&
        (await tx.emailLog.count()) === emailA);

      // ── B — idempotency (2nd call against the now-PAID clone) ─────────────
      const rB = await confirmCodPaymentReceived({ orderId: A.order.id, note: "again" }, actor, tx);
      ok("B · 2nd call → { ok:true, alreadyConfirmed:true }", rB.ok === true && "alreadyConfirmed" in rB && rB.alreadyConfirmed === true, orderSnapshot(rB));
      ok("B · still exactly one OrderEvent{PAID} and one audit (no 2nd write)", (await evCount(A.order.id)) === 1 && (await auditCount(A.order.id)) === 1);

      // ── C — settlement wiring with the REAL deliveredAt (window NOT elapsed) ─
      const pvA = await getSellerSettlementPreview(A.sellerId, tx);
      ok("C · after confirmation, clone is STILL settlement-ineligible (30-day return window not elapsed) — mirrors real AX-260907-100348",
        pvA.eligibleOrders.length === 0, orderSnapshot(pvA.eligibleOrders.map((o) => o.orderNumber)));

      // ── D — full chain once the window elapses (deliveredAt 40 days ago) ──
      const D = await seedClone(tx, `d-${t}`, { ...V, deliveredAt: new Date(Date.now() - 40 * DAY) });
      const rD = await confirmCodPaymentReceived({ orderId: D.order.id }, actor, tx);
      ok("D · confirmation on the window-elapsed clone succeeds", rD.ok === true);
      const pvD = await getSellerSettlementPreview(D.sellerId, tx);
      const dRow = pvD.eligibleOrders.find((o) => o.orderId === D.order.id);
      ok("D · with the window elapsed + PAID, the clone IS settlement-eligible", !!dRow);
      ok("D · receivable = SellerOrder.total − commissionAmount = 134900 − 17985 = 116915",
        dRow?.receivable === V.soTotal - V.commissionAmount && dRow?.receivable === 116915, orderSnapshot(dRow));
      ok("D · a NOT-yet-confirmed twin stays excluded from the same preview",
        !(await getSellerSettlementPreview(
          (await seedClone(tx, `d2-${t}`, { ...V, deliveredAt: new Date(Date.now() - 40 * DAY) })).sellerId, tx,
        )).eligibleOrders.length);

      // ── E — guards (each on a fresh clone of the 100348 shape) ────────────
      const gCard = await seedClone(tx, `e1-${t}`, { ...V, paymentMethod: "CARD" });
      ok("E · paymentMethod CARD → HAS_ONLINE_PAYMENT", (await confirmCodPaymentReceived({ orderId: gCard.order.id }, actor, tx) as { code?: string }).code === "HAS_ONLINE_PAYMENT");
      const gPay = await seedClone(tx, `e2-${t}`, { ...V, withOnlinePayment: true });
      ok("E · an active Payment row → HAS_ONLINE_PAYMENT", (await confirmCodPaymentReceived({ orderId: gPay.order.id }, actor, tx) as { code?: string }).code === "HAS_ONLINE_PAYMENT");
      const gGcash = await seedClone(tx, `e3-${t}`, { ...V, paymentMethod: "GCASH" });
      ok("E · paymentMethod GCASH → NOT_COD", (await confirmCodPaymentReceived({ orderId: gGcash.order.id }, actor, tx) as { code?: string }).code === "NOT_COD");
      const gProc = await seedClone(tx, `e4-${t}`, { ...V, orderStatus: "PROCESSING" });
      ok("E · status PROCESSING → NOT_DELIVERED", (await confirmCodPaymentReceived({ orderId: gProc.order.id }, actor, tx) as { code?: string }).code === "NOT_DELIVERED");
      const gCanc = await seedClone(tx, `e5-${t}`, { ...V, orderStatus: "CANCELLED" });
      ok("E · status CANCELLED → CANCELLED", (await confirmCodPaymentReceived({ orderId: gCanc.order.id }, actor, tx) as { code?: string }).code === "CANCELLED");
      const gRef = await seedClone(tx, `e6-${t}`, { ...V, paymentStatus: "REFUNDED" });
      ok("E · paymentStatus REFUNDED → REFUNDED", (await confirmCodPaymentReceived({ orderId: gRef.order.id }, actor, tx) as { code?: string }).code === "REFUNDED");
      const gPart = await seedClone(tx, `e7-${t}`, { ...V, paymentStatus: "PARTIALLY_REFUNDED" });
      ok("E · paymentStatus PARTIALLY_REFUNDED → REFUNDED", (await confirmCodPaymentReceived({ orderId: gPart.order.id }, actor, tx) as { code?: string }).code === "REFUNDED");
      const gWeird = await seedClone(tx, `e8-${t}`, { ...V, paymentStatus: "AWAITING_REVIEW" });
      ok("E · unknown paymentStatus + DELIVERED → INVALID_STATE", (await confirmCodPaymentReceived({ orderId: gWeird.order.id }, actor, tx) as { code?: string }).code === "INVALID_STATE");
      const rMissing = await confirmCodPaymentReceived({ orderId: "does-not-exist-9f49" }, actor, tx);
      ok("E · unknown order id → NOT_FOUND", rMissing.ok === false && (rMissing as { code?: string }).code === "NOT_FOUND");
      ok("E · NO OrderEvent / audit written on ANY rejected clone",
        (await evCount(gCard.order.id)) === 0 && (await evCount(gGcash.order.id)) === 0 && (await evCount(gProc.order.id)) === 0 &&
        (await evCount(gCanc.order.id)) === 0 && (await evCount(gRef.order.id)) === 0 && (await evCount(gWeird.order.id)) === 0 &&
        (await auditCount(gCard.order.id)) === 0 && (await auditCount(gPart.order.id)) === 0 && (await auditCount(gPay.order.id)) === 0);

      // ── F — the REAL production order, read-only, inside the tx ────────────
      const realIn = await tx.order.findUniqueOrThrow({ where: { id: realBefore.id }, select: { status: true, paymentStatus: true, paymentMethod: true } });
      ok("F · real AX-260907-100348 still DELIVERED / PENDING / NONE inside the tx", realIn.status === "DELIVERED" && realIn.paymentStatus === "PENDING" && realIn.paymentMethod === "NONE");
      ok("F · real order still has 0 PAID event + 0 cod_payment_confirmed audit",
        (await tx.orderEvent.count({ where: { orderId: realBefore.id, status: "PAID" } })) === 0 &&
        (await tx.adminAuditLog.count({ where: { action: "order.cod_payment_confirmed", targetId: realBefore.id } })) === 0);
      ok("F · real order NOT in the seller's live settlement preview (still PENDING)",
        !(await getSellerSettlementPreview(realSo ? (await tx.sellerOrder.findUniqueOrThrow({ where: { id: realSo.id }, select: { sellerId: true } })).sellerId : "x", tx))
          .eligibleOrders.some((o) => o.orderNumber === REAL));

      throw new Rollback();
    }, { timeout: 120_000, maxWait: 15_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  // ── AFTER: real production snapshot must be byte-identical ────────────────
  const realAfter = await prisma.order.findFirst({
    where: { orderNumber: REAL },
    select: {
      id: true, orderNumber: true, status: true, paymentStatus: true, paymentMethod: true,
      grandTotal: true, subtotal: true, deliveredAt: true, updatedAt: true,
      sellerOrders: { select: { id: true, status: true, settlementStatus: true, settlementId: true, total: true, commissionAmount: true, commissionRate: true, merchandiseSubtotal: true, shippingFee: true } },
    },
  });
  const countsAfter = {
    Order: await prisma.order.count(), OrderEvent: await prisma.orderEvent.count(),
    AdminAuditLog: await prisma.adminAuditLog.count(), Payment: await prisma.payment.count(),
    PaymentRefund: await prisma.paymentRefund.count(), WebhookEvent: await prisma.webhookEvent.count(),
    SellerSettlement: await prisma.sellerSettlement.count(),
    OfferInventory: await prisma.offerInventory.count(), OfferAdjustment: await prisma.offerAdjustment.count(),
    Shipment: await prisma.shipment.count(), EmailLog: await prisma.emailLog.count(),
  };
  ok("isolation · real AX-260907-100348 row byte-identical before/after", orderSnapshot(realBefore) === orderSnapshot(realAfter), orderSnapshot(realAfter));
  ok("isolation · real order updatedAt unchanged", realBefore.updatedAt.getTime() === realAfter?.updatedAt.getTime());
  ok("isolation · Order / OrderEvent / AdminAuditLog counts unchanged", countsAfter.Order === countsBefore.Order && countsAfter.OrderEvent === countsBefore.OrderEvent && countsAfter.AdminAuditLog === countsBefore.AdminAuditLog);
  ok("isolation · Payment / PaymentRefund / WebhookEvent counts unchanged", countsAfter.Payment === countsBefore.Payment && countsAfter.PaymentRefund === countsBefore.PaymentRefund && countsAfter.WebhookEvent === countsBefore.WebhookEvent);
  ok("isolation · SellerSettlement count unchanged (still 0)", countsAfter.SellerSettlement === countsBefore.SellerSettlement && countsAfter.SellerSettlement === 0);
  ok("isolation · OfferInventory / OfferAdjustment / Shipment counts unchanged (COD confirm never touches inventory or shipment)",
    countsAfter.OfferInventory === countsBefore.OfferInventory && countsAfter.OfferAdjustment === countsBefore.OfferAdjustment && countsAfter.Shipment === countsBefore.Shipment);
  ok("isolation · EmailLog count unchanged (COD confirm sends no email)", countsAfter.EmailLog === countsBefore.EmailLog);
  ok("isolation · real order still has 0 PAID event + 0 cod_payment_confirmed audit",
    (await prisma.orderEvent.count({ where: { orderId: realBefore.id, status: "PAID" } })) === realPaidEventsBefore &&
    (await prisma.adminAuditLog.count({ where: { action: "order.cod_payment_confirmed", targetId: realBefore.id } })) === realCodAuditsBefore);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
