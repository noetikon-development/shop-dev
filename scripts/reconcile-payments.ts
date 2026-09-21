/**
 * Phase 9F-54 — PayMongo payment-ledger reconciliation. READ-ONLY.
 *
 * The rule set now lives in `src/lib/marketplace/reconcile-payments-core.ts`
 * (shared with the scheduled `/api/cron/reconciliation` job) — this script is
 * a thin CLI wrapper: same console output, same exit-code behavior as before
 * this extraction.
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
 * 9F-59 — seller-aware refund attribution foundation:
 *  10  Σ PaymentRefund(live) amount <= Payment.amount, per payment            FAIL
 *  11  SUCCEEDED PaymentRefund aggregate matches Payment.status               FAIL
 *  12  ReturnRequest.refundAmount == its linked PaymentRefund.amount          FAIL
 *  13  Σ seller-scoped PaymentRefund(live) <= SellerOrder.total, per seller   FAIL
 *  14  Σ seller-attributed PaymentRefund(live) <= Payment.amount, per payment FAIL
 *  15  a bookkeeping-labelled ReturnRequest never has a PaymentRefund row     FAIL
 *
 * 9F-60 — PAID seller-cancellation refund trigger:
 *  16  no PENDING PaymentRefund older than 24h (provider call never landed)   WARN
 *
 *   node --env-file=.env --import tsx scripts/reconcile-payments.ts
 */
import { PrismaClient } from "@prisma/client";
import { runPaymentsReconciliation } from "../src/lib/marketplace/reconcile-payments-core";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

runPaymentsReconciliation(prisma)
  .then((result) => {
    if (result.fail > 0) process.exitCode = 1;
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
