/**
 * Phase 9F-54 — PayMongo payment-ledger reconciliation. READ-ONLY.
 *
 * This is the exact rule set from `scripts/reconcile-payments.ts`, extracted
 * so it can be imported both by that CLI script (unchanged behavior) and by
 * `src/lib/marketplace/reconciliation-job.ts` (the scheduled cron path).
 * Nothing about what is checked, how a check is scored, or its severity
 * changed in this extraction — only where the code lives and how its caller
 * obtains a Prisma client.
 *
 * Never repairs data. Checks 1–16 exactly as documented in the CLI script.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { ReconciliationCheckResult, ReconciliationLine } from "./reconciliation-types";

type Client = Prisma.TransactionClient | PrismaClient;

const ACTIVE = ["PENDING", "AWAITING_PAYMENT", "PAID", "PARTIALLY_REFUNDED"];
const PAID_LIKE = ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"];

export async function runPaymentsReconciliation(prisma: Client): Promise<ReconciliationCheckResult> {
  let pass = 0;
  let warn = 0;
  let fail = 0;
  const lines: ReconciliationLine[] = [];
  const PASS = (m: string) => {
    pass++;
    lines.push({ level: "PASS", message: m });
    console.log(`  [PASS] ${m}`);
  };
  const WARN = (m: string) => {
    warn++;
    lines.push({ level: "WARN", message: m });
    console.warn(`  [WARN] ${m}`);
  };
  const FAIL = (m: string) => {
    fail++;
    lines.push({ level: "FAIL", message: m });
    console.error(`  [FAIL] ${m}`);
  };

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

  // ── 9F-59 — seller-aware refund attribution foundation (all read-only) ──
  const LIVE_REFUND = ["PENDING", "PROCESSING", "SUCCEEDED"];
  const refunds = await prisma.paymentRefund.findMany({
    select: {
      id: true, paymentId: true, sellerOrderId: true, returnRequestId: true,
      amount: true, status: true, createdAt: true,
      payment: { select: { id: true, amount: true, status: true } },
    },
  });
  console.log(`  ${refunds.length} PaymentRefund row(s)\n`);

  // 10 — Σ live refunds <= Payment.amount, per payment.
  const byPayment = new Map<string, { amount: number; live: number }>();
  for (const r of refunds) {
    const e = byPayment.get(r.paymentId) ?? { amount: r.payment.amount, live: 0 };
    if (LIVE_REFUND.includes(r.status)) e.live += r.amount;
    byPayment.set(r.paymentId, e);
  }
  const overPayment = [...byPayment.entries()].filter(([, e]) => e.live > e.amount);
  if (overPayment.length === 0) PASS("10 · Σ PaymentRefund(live) amount <= Payment.amount, per payment");
  else for (const [pid, e] of overPayment) FAIL(`10 · Payment ${pid}: Σ live refunds ${e.live} > amount ${e.amount}`);

  // 11 — SUCCEEDED aggregate must match the Payment.status the webhook derives.
  const succeededByPayment = new Map<string, number>();
  for (const r of refunds) {
    if (r.status !== "SUCCEEDED") continue;
    succeededByPayment.set(r.paymentId, (succeededByPayment.get(r.paymentId) ?? 0) + r.amount);
  }
  let statusBad = 0;
  for (const [pid, succeeded] of succeededByPayment) {
    const payment = refunds.find((r) => r.paymentId === pid)!.payment;
    const expected = succeeded >= payment.amount ? "REFUNDED" : "PARTIALLY_REFUNDED";
    if (payment.status !== expected) {
      statusBad++;
      FAIL(`11 · Payment ${pid}: Σ SUCCEEDED refunds ${succeeded}/${payment.amount} implies ${expected} but status is ${payment.status}`);
    }
  }
  if (statusBad === 0) PASS("11 · SUCCEEDED PaymentRefund aggregate is consistent with Payment.status");

  // 12 — ReturnRequest.refundAmount must match its linked PaymentRefund.
  const returnsWithRefund = await prisma.returnRequest.findMany({
    where: { paymentRefund: { isNot: null } },
    select: { id: true, returnNumber: true, refundAmount: true, paymentRefund: { select: { amount: true } } },
  });
  const amountMismatch = returnsWithRefund.filter((r) => r.refundAmount !== r.paymentRefund?.amount);
  if (amountMismatch.length === 0) PASS("12 · ReturnRequest.refundAmount is consistent with its PaymentRefund amount where applicable");
  else for (const r of amountMismatch) FAIL(`12 · Return ${r.returnNumber}: refundAmount ${r.refundAmount} != PaymentRefund.amount ${r.paymentRefund?.amount}`);

  // 13 — Σ live seller-scoped refunds <= SellerOrder.total, per seller.
  const bySeller = new Map<string, number>();
  for (const r of refunds) {
    if (!r.sellerOrderId || !LIVE_REFUND.includes(r.status)) continue;
    bySeller.set(r.sellerOrderId, (bySeller.get(r.sellerOrderId) ?? 0) + r.amount);
  }
  let sellerCapBad = 0;
  for (const [sellerOrderId, live] of bySeller) {
    const so = await prisma.sellerOrder.findUnique({ where: { id: sellerOrderId }, select: { total: true } });
    if (so && live > so.total) {
      sellerCapBad++;
      FAIL(`13 · SellerOrder ${sellerOrderId}: Σ live seller-scoped refunds ${live} > total ${so.total}`);
    }
  }
  if (sellerCapBad === 0) PASS("13 · no seller-scoped PaymentRefund total exceeds SellerOrder.total");

  // 14 — Σ live seller-attributed refunds (across every seller sharing one
  //      Payment) <= that Payment.amount — distinct from #10 (which sums ALL
  //      refunds regardless of attribution): this isolates just the
  //      seller-attributed subset, so a future multi-seller-per-payment
  //      scenario can't silently let per-seller caps individually pass while
  //      their sum still overruns the shared Payment.
  const sellerAttributedByPayment = new Map<string, number>();
  for (const r of refunds) {
    if (!r.sellerOrderId || !LIVE_REFUND.includes(r.status)) continue;
    sellerAttributedByPayment.set(r.paymentId, (sellerAttributedByPayment.get(r.paymentId) ?? 0) + r.amount);
  }
  let crossSellerBad = 0;
  for (const [pid, live] of sellerAttributedByPayment) {
    const amount = byPayment.get(pid)?.amount ?? 0;
    if (live > amount) {
      crossSellerBad++;
      FAIL(`14 · Payment ${pid}: Σ seller-attributed live refunds ${live} > amount ${amount}`);
    }
  }
  if (crossSellerBad === 0) PASS("14 · total refunds across all SellerOrders never exceed the Payment refundable balance");

  // 15 — a bookkeeping-labelled refund (refundMethod not "... via PayMongo")
  //      must never have a PaymentRefund row — the two paths stay separate.
  const refundedReturns = await prisma.returnRequest.findMany({
    where: { refundAmount: { not: null } },
    select: { id: true, returnNumber: true, refundMethod: true, paymentRefund: { select: { id: true } } },
  });
  const leaked = refundedReturns.filter(
    (r) => r.paymentRefund && !/via PayMongo$/.test(r.refundMethod ?? ""),
  );
  if (leaked.length === 0) PASS("15 · existing bookkeeping-only refunds remain separate from PaymentRefund rows");
  else for (const r of leaked) FAIL(`15 · Return ${r.returnNumber} looks bookkeeping (refundMethod "${r.refundMethod}") but has a PaymentRefund row`);

  // 16 — 9F-60: a PENDING PaymentRefund older than 24h means the provider call
  //      never landed (network timeout, crash between commit and the call, a
  //      failed process before callProviderForRefund ran) — mirrors rule 1's
  //      shape exactly (same cutoff, same WARN-not-FAIL severity: it's an
  //      ops-visibility signal, not a ledger-integrity violation).
  const stalePendingRefunds = refunds.filter(
    (r) => r.status === "PENDING" && r.createdAt.getTime() < cutoff,
  );
  if (stalePendingRefunds.length === 0) PASS("16 · no PENDING PaymentRefund older than 24h");
  else WARN(`16 · ${stalePendingRefunds.length} PENDING PaymentRefund(s) > 24h old — the provider call may never have landed: ${stalePendingRefunds.map((r) => r.id).join(", ")}`);

  console.log(`\n  ${pass} pass · ${warn} warn · ${fail} fail`);
  if (fail > 0) {
    console.error("\nPAYMENT RECONCILIATION FAILED — real payment-ledger drift detected.");
  } else if (warn > 0) {
    console.warn("\nPAYMENT RECONCILIATION PASSED WITH WARNINGS — review the WARN lines above.");
  } else {
    console.log("\nPAYMENT RECONCILIATION PASSED — Payment / Order / WebhookEvent invariants hold.");
  }

  return { name: "payments", pass, warn, fail, lines };
}
