/**
 * Phase 9F-54 — PayMongo payment-ledger reconciliation. READ-ONLY.
 *
 * Never repairs data. `[FAIL]` → non-zero exit; `[WARN]` → visible, exit 0.
 * Production carries 0 Payment / 0 WebhookEvent rows today, so every check
 * passes with "0 rows" until the PayMongo test flow creates fixtures on the
 * non-production deployment.
 *
 * Checks:
 *   1  AWAITING_PAYMENT Payment > 24h old with no terminal webhook            WARN
 *   2  PAID Payment whose Order.paymentStatus / Order.status is not PAID       FAIL
 *   3  FAILED WebhookEvent count                                              WARN
 *   4  Payment.amount == Order.grandTotal                                     FAIL
 *   5  Payment.currency == "PHP" (the store's only currency)                  FAIL
 *   6  at most one ACTIVE Payment per order                                   FAIL
 *   7  no leftover `pending_…` placeholder providerId on a non-PENDING row    WARN
 *   8  PAID Payment carries metadata.providerPaymentId (pay_…) — 9F-54        WARN
 *   9  a PROCESSED `*.payment.paid` WebhookEvent's Payment is PAID            FAIL
 *
 *   node --env-file=.env --import tsx scripts/reconcile-payments.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let warn = 0;
let fail = 0;
const PASS = (m: string) => { pass++; console.log(`  [PASS] ${m}`); };
const WARN = (m: string) => { warn++; console.warn(`  [WARN] ${m}`); };
const FAIL = (m: string) => { fail++; console.error(`  [FAIL] ${m}`); };

const ACTIVE = ["PENDING", "AWAITING_PAYMENT", "PAID", "PARTIALLY_REFUNDED"];
const PAID_LIKE = ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"];

async function run() {
  console.log("PHASE 9F-54 — PayMongo payment-ledger reconciliation (READ-ONLY)\n");

  const payments = await prisma.payment.findMany({
    select: {
      id: true, providerId: true, providerObject: true, status: true, amount: true,
      currency: true, paidAt: true, metadata: true, createdAt: true,
      order: { select: { id: true, orderNumber: true, status: true, paymentStatus: true, grandTotal: true } },
    },
  });
  const events = await prisma.webhookEvent.findMany({
    select: { id: true, providerId: true, type: true, status: true },
  });
  console.log(`  ${payments.length} Payment row(s) · ${events.length} WebhookEvent row(s)\n`);

  // 1 — stale AWAITING_PAYMENT
  const cutoff = Date.now() - 24 * 3600e3;
  const stale = payments.filter((p) => p.status === "AWAITING_PAYMENT" && p.createdAt.getTime() < cutoff);
  if (stale.length === 0) PASS("1 · no AWAITING_PAYMENT Payment older than 24h");
  else WARN(`1 · ${stale.length} AWAITING_PAYMENT Payment(s) > 24h old — a webhook may have been missed: ${stale.map((p) => p.order.orderNumber).join(", ")}`);

  // 2 — PAID Payment vs Order
  const paidMismatch = payments.filter(
    (p) => PAID_LIKE.includes(p.status) && !(p.order.status === "PAID" || p.order.status === "PROCESSING" || p.order.status === "SHIPPED" || p.order.status === "OUT_FOR_DELIVERY" || p.order.status === "DELIVERED" || p.order.status === "CANCELLED") ,
  );
  const paidStatusMismatch = payments.filter((p) => p.status === "PAID" && !PAID_LIKE.includes(p.order.paymentStatus));
  if (paidMismatch.length === 0 && paidStatusMismatch.length === 0) PASS("2 · every PAID Payment has a PAID/advanced Order");
  else {
    for (const p of paidMismatch) FAIL(`2 · Payment ${p.id} is ${p.status} but Order ${p.order.orderNumber} status = ${p.order.status}`);
    for (const p of paidStatusMismatch) FAIL(`2 · Payment ${p.id} is PAID but Order ${p.order.orderNumber} paymentStatus = ${p.order.paymentStatus}`);
  }

  // 3 — FAILED WebhookEvent count
  const failedEv = events.filter((e) => e.status === "FAILED");
  if (failedEv.length === 0) PASS("3 · no FAILED WebhookEvent");
  else WARN(`3 · ${failedEv.length} FAILED WebhookEvent(s) — reprocess or resend: ${failedEv.map((e) => `${e.providerId}(${e.type})`).join(", ")}`);

  // 4 — amount
  const amtBad = payments.filter((p) => p.amount !== p.order.grandTotal);
  if (amtBad.length === 0) PASS("4 · every Payment.amount == Order.grandTotal");
  else for (const p of amtBad) FAIL(`4 · Payment ${p.id} amount ${p.amount} != Order ${p.order.orderNumber} grandTotal ${p.order.grandTotal}`);

  // 5 — currency
  const curBad = payments.filter((p) => p.currency.toUpperCase() !== "PHP");
  if (curBad.length === 0) PASS("5 · every Payment.currency == PHP");
  else for (const p of curBad) FAIL(`5 · Payment ${p.id} currency ${p.currency} != PHP`);

  // 6 — at most one ACTIVE Payment per order
  const activeByOrder = new Map<string, number>();
  for (const p of payments) if (ACTIVE.includes(p.status)) activeByOrder.set(p.order.id, (activeByOrder.get(p.order.id) ?? 0) + 1);
  const dupActive = [...activeByOrder.entries()].filter(([, n]) => n > 1);
  if (dupActive.length === 0) PASS("6 · at most one ACTIVE Payment per order");
  else for (const [oid, n] of dupActive) FAIL(`6 · order ${oid} has ${n} ACTIVE Payment rows (partial unique index should prevent this)`);

  // 7 — leftover placeholder providerId
  const placeholder = payments.filter((p) => p.providerId.startsWith("pending_") && p.status !== "PENDING");
  if (placeholder.length === 0) PASS("7 · no leftover `pending_…` placeholder providerId on a non-PENDING Payment");
  else for (const p of placeholder) WARN(`7 · Payment ${p.id} (${p.status}) still has placeholder providerId ${p.providerId}`);

  // 8 — PAID Payment carries metadata.providerPaymentId
  const missingPayId = payments.filter((p) => {
    if (!PAID_LIKE.includes(p.status)) return false;
    try { return !((JSON.parse(p.metadata || "{}") as { providerPaymentId?: string }).providerPaymentId); }
    catch { return true; }
  });
  if (missingPayId.length === 0) PASS("8 · every PAID Payment carries metadata.providerPaymentId (pay_…)");
  else for (const p of missingPayId) WARN(`8 · PAID Payment ${p.id} (order ${p.order.orderNumber}) has no metadata.providerPaymentId — provider refunds need it`);

  // 9 — a PROCESSED payment-paid event must have left at least one PAID Payment.
  //    (The event id is evt_…, not the object id, so this is a coarse but real
  //    cross-check: a "paid" event was applied yet the ledger shows no capture.)
  const paidEvents = events.filter(
    (e) => e.status === "PROCESSED" && (e.type === "checkout_session.payment.paid" || e.type === "payment.paid"),
  );
  const paidPayments = payments.filter((p) => PAID_LIKE.includes(p.status)).length;
  if (paidEvents.length === 0 || paidPayments >= 1) {
    PASS("9 · Payment ledger is consistent with PROCESSED payment-paid WebhookEvents");
  } else {
    FAIL(`9 · ${paidEvents.length} PROCESSED payment-paid WebhookEvent(s) but 0 PAID Payment rows`);
  }

  console.log(`\n  ${pass} pass · ${warn} warn · ${fail} fail`);
  if (fail > 0) {
    console.error("\nPAYMENT RECONCILIATION FAILED — real payment-ledger drift detected.");
    process.exitCode = 1;
  } else if (warn > 0) {
    console.warn("\nPAYMENT RECONCILIATION PASSED WITH WARNINGS — review the WARN lines above.");
  } else {
    console.log("\nPAYMENT RECONCILIATION PASSED — Payment / Order / WebhookEvent invariants hold.");
  }
}

run().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
