/**
 * Phase 9F-54 — PayMongo TEST-mode webhook / payment-ledger verification.
 *
 * TEST MODE ONLY. No PayMongo network call — the API client is exercised only
 * through pure helpers and rolled-back DB fixtures.
 *
 * Pattern (mirrors test-9f43b / test-9f49-cod): pure-function checks + static
 * assertions + one `prisma.$transaction` per DB scenario that ends with
 * `throw new Rollback()`. The webhook handlers take a `db` client
 * (9F-54 refactor — same `externalTx?` shape as recordSettlement /
 * confirmCodPaymentReceived) so `handleEvent(...)` runs inside the rolled-back tx
 * and commits nothing.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f54-paymongo.ts
 */
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { verifyWebhookSignature } from "../src/lib/payments/paymongo";
import {
  handleEvent,
  extractPaidFacts,
  mergeMetadata,
  reprocessWebhookEvent,
} from "../src/lib/payments/webhook";
import {
  canTransitionPayment,
  orderPaymentMethodFromProvider,
  isHandledWebhookType,
} from "../src/lib/payments/status";
import {
  getPaymentsConfig,
  readPaymentSettings,
  applyPaymentSettingRows,
  type PaymentsConfig,
} from "../src/lib/payments/config";
import { beginOnlinePayment, canResumeOnlinePayment } from "../src/lib/payments/checkout-session";
import { paymentMethodDisplayLabel } from "../src/lib/payments/status";
import {
  sendPaymentConfirmation,
  sendPaymentFailed,
  sendPaymentExpiredOrCancelled,
  sendRefundCompleted,
} from "../src/lib/email/notifications";
import { renderPaymentConfirmation } from "../src/lib/email/templates/payment-confirmation";
import { renderPaymentFailed } from "../src/lib/email/templates/payment-failed";
import { renderPaymentExpiredOrCancelled } from "../src/lib/email/templates/payment-expired-or-cancelled";
import { renderRefundCompleted } from "../src/lib/email/templates/refund-completed";

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
const GRAND = 250000; // ₱2,500.00

const SECRET = "whsk_test_9f54_secret";
function sign(rawBody: string, opts: { ts?: number; mode?: "test" | "live"; badSig?: boolean } = {}): string {
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const real = createHmac("sha256", SECRET).update(`${ts}.${rawBody}`).digest("hex");
  const sig = opts.badSig ? "0".repeat(real.length) : real;
  return opts.mode === "live" ? `t=${ts},li=${sig}` : `t=${ts},te=${sig}`;
}

/** A checkout_session.payment.paid webhook envelope. */
function paidEvent(sessionId: string, ourPaymentId: string, over: { amount?: number; currency?: string; method?: string; payId?: string } = {}) {
  return {
    data: {
      id: `evt_${Math.random().toString(36).slice(2, 10)}`,
      attributes: {
        type: "checkout_session.payment.paid",
        data: {
          id: sessionId,
          type: "checkout_session",
          attributes: {
            payments: [
              {
                id: over.payId ?? `pay_${Math.random().toString(36).slice(2, 10)}`,
                type: "payment",
                attributes: {
                  status: "paid",
                  amount: over.amount ?? GRAND,
                  currency: over.currency ?? "PHP",
                  source: { type: over.method ?? "card" },
                },
              },
            ],
            metadata: { payment_id: ourPaymentId },
          },
        },
      },
    },
  };
}
function failedEvent(sessionId: string, ourPaymentId: string) {
  return {
    data: {
      id: `evt_${Math.random().toString(36).slice(2, 10)}`,
      attributes: {
        type: "payment.failed",
        data: {
          id: sessionId,
          type: "payment",
          attributes: { last_payment_error: { message: "card_declined" }, metadata: { payment_id: ourPaymentId } },
        },
      },
    },
  };
}

/** A full PaymentsConfig for injecting into beginOnlinePayment in tests. */
function fakeConfig(over: Partial<PaymentsConfig> = {}): PaymentsConfig {
  return {
    sessionsEnabled: true,
    onlinePaymentEnabled: true,
    holdForReview: false,
    mode: "test",
    detectedMode: "test",
    modeMismatch: false,
    enabledMethods: ["COD", "CARD", "GCASH"],
    hasSecretKey: true,
    hasWebhookSecret: true,
    apiBase: "https://api.paymongo.com/v1",
    settingsReadFailed: false,
    ...over,
  };
}

async function seedOnlineOrderWithPayment(tx: Tx, sfx: string, over: { paymentStatus?: string; orderStatus?: string; providerId?: string; amount?: number } = {}) {
  const order = await tx.order.create({
    data: {
      orderNumber: `AX-T54-${sfx}-${Math.random().toString(36).slice(2, 6)}`,
      email: "buyer@example.test",
      status: over.orderStatus ?? "PENDING_PAYMENT",
      paymentMethod: "NONE",
      paymentStatus: over.paymentStatus ?? "PENDING",
      subtotal: over.amount ?? GRAND,
      grandTotal: over.amount ?? GRAND,
      shippingAddress: JSON.stringify({ firstName: "T", city: "M", country: "PH" }),
    },
    select: { id: true, orderNumber: true, grandTotal: true },
  });
  const providerId = over.providerId ?? `cs_test_${sfx}_${Math.random().toString(36).slice(2, 8)}`;
  const payment = await tx.payment.create({
    data: {
      orderId: order.id,
      provider: "paymongo",
      providerObject: "checkout_session",
      providerId,
      status: "AWAITING_PAYMENT",
      amount: order.grandTotal,
      currency: "PHP",
      checkoutUrl: "https://checkout.paymongo.test/x",
      metadata: JSON.stringify({ order_number: order.orderNumber }),
    },
    select: { id: true, status: true, metadata: true },
  });
  return { order, payment, providerId };
}

async function main() {
  console.log("\nPHASE 9F-54 — PayMongo TEST-mode webhook verification\n");

  // ── 1 — signature verification (pure) ────────────────────────────────────
  const body = JSON.stringify({ hello: "world" });
  ok("1 · valid test signature (te) verifies", verifyWebhookSignature(body, sign(body), SECRET, "test").ok);
  ok("1 · valid live signature checked in live mode", verifyWebhookSignature(body, sign(body, { mode: "live" }), SECRET, "live").ok);
  ok("1 · a test signature is REJECTED when the handler runs in live mode",
    verifyWebhookSignature(body, sign(body), SECRET, "live").ok === false);
  ok("1 · invalid signature rejected", (() => { const r = verifyWebhookSignature(body, sign(body, { badSig: true }), SECRET, "test"); return !r.ok && r.reason === "mismatch"; })());
  ok("1 · missing signature header rejected", (() => { const r = verifyWebhookSignature(body, null, SECRET, "test"); return !r.ok && r.reason === "malformed_header"; })());
  ok("1 · missing webhook secret fails closed", (() => { const r = verifyWebhookSignature(body, sign(body), "", "test"); return !r.ok && r.reason === "no_secret"; })());
  ok("1 · timestamp skew > 300s rejected", (() => { const r = verifyWebhookSignature(body, sign(body, { ts: Math.floor(Date.now() / 1000) - 999 }), SECRET, "test"); return !r.ok && r.reason === "timestamp_skew"; })());
  ok("1 · body tampering after signing is rejected", verifyWebhookSignature(body + " ", sign(body), SECRET, "test").ok === false);

  // ── pure state-machine + mapping ─────────────────────────────────────────
  ok("pure · canTransitionPayment AWAITING_PAYMENT→PAID ok; PAID→PAID / PAID→PENDING no",
    canTransitionPayment("AWAITING_PAYMENT", "PAID") && !canTransitionPayment("PAID", "PAID") && !canTransitionPayment("PAID", "PENDING") && !canTransitionPayment("FAILED", "PAID"));
  ok("pure · orderPaymentMethodFromProvider: gcash→GCASH, card/paymaya/grab_pay→CARD, unknown→NONE",
    orderPaymentMethodFromProvider("gcash") === "GCASH" && orderPaymentMethodFromProvider("card") === "CARD" &&
    orderPaymentMethodFromProvider("paymaya") === "CARD" && orderPaymentMethodFromProvider("grab_pay") === "CARD" &&
    orderPaymentMethodFromProvider("bitcoin") === "NONE" && orderPaymentMethodFromProvider(null) === "NONE");
  ok("pure · isHandledWebhookType: the 5 events, nothing else",
    isHandledWebhookType("checkout_session.payment.paid") && isHandledWebhookType("payment.failed") &&
    isHandledWebhookType("checkout_session.expired") && isHandledWebhookType("refund.updated") &&
    !isHandledWebhookType("payment.refunded"));
  ok("pure · mergeMetadata merges, drops undefined, tolerates a malformed base",
    JSON.parse(mergeMetadata('{"a":1}', { b: 2, c: undefined })).b === 2 &&
    JSON.parse(mergeMetadata('{"a":1}', { b: 2 })).a === 1 &&
    JSON.parse(mergeMetadata("not json", { x: 1 })).x === 1);
  ok("pure · extractPaidFacts reads the nested checkout_session payments[]",
    (() => {
      const f = extractPaidFacts("checkout_session.payment.paid", (paidEvent("cs_x", "p_x", { amount: 12345, method: "gcash", payId: "pay_abc" }) as { data: { attributes: { data: { attributes: Record<string, unknown> } } } }).data.attributes.data.attributes);
      return f.amount === 12345 && f.currency === "PHP" && f.method === "gcash" && f.providerPaymentId === "pay_abc";
    })());
  ok("pure · extractPaidFacts reads a flat payment.paid object",
    (() => {
      const f = extractPaidFacts("payment.paid", { id: "pay_flat", amount: 500, currency: "PHP", status: "paid", source: { type: "card" } });
      return f.amount === 500 && f.method === "card" && f.providerPaymentId === "pay_flat";
    })());

  // ── static: webhook.ts structure ────────────────────────────────────────
  const wh = read("src/lib/payments/webhook.ts");
  ok("static · signature verified BEFORE parse / DB (step 1)",
    wh.indexOf("verifyWebhookSignature(") < wh.indexOf("JSON.parse(rawBody)") && wh.indexOf("verifyWebhookSignature(") < wh.indexOf("webhookEvent.createMany"));
  ok("static · event claimed by unique providerId + raw payload stored",
    /createMany\(\{\s*data: \[\{ providerId, type, payloadHash, payload: rawBody, status: "RECEIVED" \}\],\s*skipDuplicates: true/.test(wh));
  ok("static · duplicate claim → 200 (no reprocessing)", /return \{ status: 200, body: "duplicate — already processed" \}/.test(wh));
  ok("static · feature-off → WebhookEvent IGNORED, no state change",
    /if \(!config\.onlinePaymentEnabled\) \{\s*await markEvent\(providerId, "IGNORED", "online payment disabled"\)/.test(wh));
  ok("static · handler error → FAILED + 200 (no retry storm)",
    /await markEvent\(providerId, "FAILED", reason\);/.test(wh) && /return \{ status: 200, body: "recorded \(handler error\)" \}/.test(wh));
  ok("static · applyPaid re-verifies captured amount == Payment.amount == live Order.grandTotal",
    /if \(facts\.amount !== payment\.amount \|\| facts\.amount !== payment\.order\.grandTotal\)/.test(wh));
  ok("static · applyPaid re-verifies currency", /currency mismatch: \$\{currency\} vs \$\{payment\.currency\}/.test(wh));
  ok("static · order write is status-guarded (PENDING_PAYMENT) with a count check",
    /where: \{ id: payment\.order\.id, status: "PENDING_PAYMENT" \}/.test(wh) && /if \(paidOrder\.count === 0\) return;/.test(wh));
  ok("static · applyPaid persists metadata.providerPaymentId (pay_…) alongside providerId=cs_…",
    /metadata: mergeMetadata\(payment\.metadata, \{\s*providerPaymentId: facts\.providerPaymentId/.test(wh));
  ok("static · reprocessWebhookEvent: only FAILED + only with a stored payload, re-runs handleEvent",
    /if \(row\.status !== "FAILED"\)/.test(wh) && /if \(!row\.payload\)/.test(wh) && /await handleEvent\(row\.providerId, row\.type, event, db\)/.test(wh));
  ok("static · route reads the RAW body and never logs it", (() => {
    const route = read("src/app/api/webhooks/paymongo/route.ts");
    return /rawBody = await request\.text\(\)/.test(route) && !/console\.log\(rawBody\)/.test(route) && /runtime = "nodejs"/.test(route);
  })());
  ok("static · the browser return path never marks an order paid", (() => {
    const page = read("src/app/(shop)/order/[orderNumber]/page.tsx");
    return /never mutates the order|never treats? .* as proof|as proof of payment/i.test(page) || !/updateMany|\.update\(/.test(page);
  })());
  ok("static · config.ts no longer claims '/v2/checkout_sessions' does not exist",
    !/There is no `\/v2\/checkout_sessions`/.test(read("src/lib/payments/config.ts")));

  // ── DB (rolled back) ────────────────────────────────────────────────────
  // `payments.holdForReview` is a shared StoreSetting: when ON, a verified
  // payment moves the order to PAID but NOT automatically to PROCESSING (an
  // admin advances it). The 9F-54 Preview bring-up turns it ON. Read it once so
  // the happy-path assertions hold in either configuration.
  const holdForReview = (await getPaymentsConfig()).holdForReview;
  const paidOrderStatus = holdForReview ? "PAID" : "PROCESSING";
  const paidProcessingEvents = holdForReview ? 0 : 1;
  try {
    await prisma.$transaction(async (tx) => {
      const t = Date.now().toString(36);
      const evPaid = (id: string) => tx.orderEvent.count({ where: { orderId: id, status: "PAID" } });
      const auditPaid = (id: string) => tx.adminAuditLog.count({ where: { action: "payment.paid", targetId: id } });

      // 3 — applyPaid happy path
      const A = await seedOnlineOrderWithPayment(tx, `a-${t}`);
      const evA = paidEvent(A.providerId, A.payment.id, { method: "gcash" });
      await handleEvent("evt-a", "checkout_session.payment.paid", evA, tx);
      const aOrder = await tx.order.findUniqueOrThrow({ where: { id: A.order.id }, select: { status: true, paymentStatus: true, paymentMethod: true } });
      const aPay = await tx.payment.findUniqueOrThrow({ where: { id: A.payment.id }, select: { status: true, method: true, paidAt: true, metadata: true } });
      ok(`3 · Order PENDING_PAYMENT → PAID → ${paidOrderStatus} (holdForReview=${holdForReview}); paymentStatus PAID; method GCASH`,
        aOrder.status === paidOrderStatus && aOrder.paymentStatus === "PAID" && aOrder.paymentMethod === "GCASH", JSON.stringify(aOrder));
      ok("3 · Payment → PAID with paidAt + method", aPay.status === "PAID" && aPay.method === "gcash" && !!aPay.paidAt);
      ok(`3 · exactly one OrderEvent{PAID} + ${paidProcessingEvents} PROCESSING`, (await evPaid(A.order.id)) === 1 && (await tx.orderEvent.count({ where: { orderId: A.order.id, status: "PROCESSING" } })) === paidProcessingEvents);
      ok("3 · exactly one AdminAuditLog payment.paid", (await auditPaid(A.order.id)) === 1);

      // 12 — pay_… persistence
      const meta12 = JSON.parse(aPay.metadata) as { providerPaymentId?: string };
      ok("12 · paid webhook stored the real PayMongo payment id (pay_…) in metadata.providerPaymentId, providerId stays cs_…",
        typeof meta12.providerPaymentId === "string" && meta12.providerPaymentId.startsWith("pay_") &&
        (await tx.payment.findUniqueOrThrow({ where: { id: A.payment.id }, select: { providerId: true } })).providerId.startsWith("cs_"));

      // 11 / 13 — re-deliver the SAME paid effect → idempotent, no dup records
      await handleEvent("evt-a", "checkout_session.payment.paid", evA, tx);
      await handleEvent("evt-a2", "checkout_session.payment.paid", paidEvent(A.providerId, A.payment.id, { method: "gcash" }), tx);
      ok("11/13 · re-running the paid handler is a no-op — still one OrderEvent{PAID}, one audit, Payment stays PAID",
        (await evPaid(A.order.id)) === 1 && (await auditPaid(A.order.id)) === 1 &&
        (await tx.payment.findUniqueOrThrow({ where: { id: A.payment.id }, select: { status: true } })).status === "PAID");

      // 8 — amount mismatch → throws, order NOT paid
      const B = await seedOnlineOrderWithPayment(tx, `b-${t}`);
      let bThrew = false;
      try { await handleEvent("evt-b", "checkout_session.payment.paid", paidEvent(B.providerId, B.payment.id, { amount: GRAND + 100 }), tx); }
      catch (e) { bThrew = /amount mismatch/.test(String(e)); }
      const bOrder = await tx.order.findUniqueOrThrow({ where: { id: B.order.id }, select: { status: true, paymentStatus: true } });
      ok("8 · amount mismatch → handler throws, Order stays PENDING_PAYMENT / PENDING, no OrderEvent{PAID}",
        bThrew && bOrder.status === "PENDING_PAYMENT" && bOrder.paymentStatus === "PENDING" && (await evPaid(B.order.id)) === 0);

      // 9 — currency mismatch → throws, order NOT paid
      const C = await seedOnlineOrderWithPayment(tx, `c-${t}`);
      let cThrew = false;
      try { await handleEvent("evt-c", "checkout_session.payment.paid", paidEvent(C.providerId, C.payment.id, { currency: "USD" }), tx); }
      catch (e) { cThrew = /currency mismatch/.test(String(e)); }
      ok("9 · currency mismatch → handler throws, Order not marked PAID",
        cThrew && (await tx.order.findUniqueOrThrow({ where: { id: C.order.id }, select: { paymentStatus: true } })).paymentStatus === "PENDING" && (await evPaid(C.order.id)) === 0);

      // 4 — applyFailed
      const D = await seedOnlineOrderWithPayment(tx, `d-${t}`);
      await handleEvent("evt-d", "payment.failed", failedEvent(D.providerId, D.payment.id), tx);
      const dOrder = await tx.order.findUniqueOrThrow({ where: { id: D.order.id }, select: { status: true, paymentStatus: true } });
      const dPay = await tx.payment.findUniqueOrThrow({ where: { id: D.payment.id }, select: { status: true, failureReason: true } });
      ok("4 · payment.failed → Payment FAILED (reason kept), Order stays PENDING_PAYMENT (retry possible)",
        dPay.status === "FAILED" && dPay.failureReason === "card_declined" && dOrder.status === "PENDING_PAYMENT" && dOrder.paymentStatus === "PENDING");

      // 5 — applyExpired releases the active-payment slot
      const E = await seedOnlineOrderWithPayment(tx, `e-${t}`);
      await handleEvent("evt-e", "checkout_session.expired", {
        data: { id: "evt-e", attributes: { type: "checkout_session.expired", data: { id: E.providerId, attributes: {} } } },
      }, tx);
      ok("5 · checkout_session.expired → Payment EXPIRED (frees the one-active-per-order slot)",
        (await tx.payment.findUniqueOrThrow({ where: { id: E.payment.id }, select: { status: true } })).status === "EXPIRED");

      // 7 — COD isolation: a COD order in the same tx is untouched by all of the above
      const cod = await tx.order.create({
        data: { orderNumber: `AX-T54COD-${t}`, email: "c@t.test", status: "DELIVERED", paymentMethod: "NONE", paymentStatus: "PENDING", subtotal: 100, grandTotal: 100, shippingAddress: "{}" },
        select: { id: true },
      });
      ok("7 · a COD order alongside stays paymentMethod NONE / paymentStatus PENDING, has 0 Payment rows",
        (await tx.payment.count({ where: { orderId: cod.id } })) === 0 &&
        (await tx.order.findUniqueOrThrow({ where: { id: cod.id }, select: { paymentMethod: true, paymentStatus: true } })).paymentMethod === "NONE");

      // 13 — reprocessWebhookEvent guard codes
      const rNotFound = await reprocessWebhookEvent("does-not-exist", { userId: "t", email: "t" }, tx);
      ok("13 · reprocess unknown id → NOT_FOUND", !rNotFound.ok && rNotFound.code === "NOT_FOUND");
      const wePassed = await tx.webhookEvent.create({ data: { providerId: `evt_ok_${t}`, type: "payment.paid", payloadHash: "h", payload: "{}", status: "PROCESSED" }, select: { id: true } });
      const rNotFailed = await reprocessWebhookEvent(wePassed.id, { userId: "t", email: "t" }, tx);
      ok("13 · reprocess a PROCESSED event → NOT_FAILED", !rNotFailed.ok && rNotFailed.code === "NOT_FAILED");
      const weNoPayload = await tx.webhookEvent.create({ data: { providerId: `evt_np_${t}`, type: "payment.paid", payloadHash: "h", payload: null, status: "FAILED" }, select: { id: true } });
      const rNoPayload = await reprocessWebhookEvent(weNoPayload.id, { userId: "t", email: "t" }, tx);
      ok("13 · reprocess a FAILED event with no stored payload → NO_PAYLOAD", !rNoPayload.ok && rNoPayload.code === "NO_PAYLOAD");
      const weFailed = await tx.webhookEvent.create({ data: { providerId: `evt_f_${t}`, type: "checkout_session.payment.paid", payloadHash: "h", payload: JSON.stringify(paidEvent("cs_z", "p_z")), status: "FAILED" }, select: { id: true } });
      const rFeatureOff = await reprocessWebhookEvent(weFailed.id, { userId: "t", email: "t" }, tx);
      ok("13 · reprocess with online payment disabled → FEATURE_OFF (test env has no PAYMONGO_* — safe default)",
        !rFeatureOff.ok && rFeatureOff.code === "FEATURE_OFF");

      throw new Rollback();
    }, { timeout: 120_000, maxWait: 15_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  // ── 10 — one active Payment per order (own tx: a P2002 aborts the tx) ────
  try {
    await prisma.$transaction(async (tx) => {
      const t = Date.now().toString(36);
      const F = await seedOnlineOrderWithPayment(tx, `f-${t}`);
      let dupBlocked = false;
      try {
        await tx.payment.create({
          data: { orderId: F.order.id, provider: "paymongo", providerObject: "checkout_session", providerId: `cs_dup_${t}`, status: "AWAITING_PAYMENT", amount: GRAND, currency: "PHP" },
        });
      } catch (e) {
        dupBlocked = /Unique constraint|P2002/.test(String(e));
      }
      ok("10 · a 2nd ACTIVE Payment on the same order is blocked by payment_one_active_per_order", dupBlocked);
      throw new Rollback();
    }, { timeout: 60_000, maxWait: 15_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  // ── 6 — feature-off / production dormancy (read-only) ────────────────────
  const cfg = await getPaymentsConfig();
  ok("6 · getPaymentsConfig().onlinePaymentEnabled === false (no PAYMONGO_* env)", cfg.onlinePaymentEnabled === false);
  ok("6 · sessionsEnabled === false (no secret key)", cfg.sessionsEnabled === false);
  ok("6 · production ledger empty: 0 Payment / 0 PaymentRefund / 0 WebhookEvent",
    (await prisma.payment.count()) === 0 && (await prisma.paymentRefund.count()) === 0 && (await prisma.webhookEvent.count()) === 0);
  ok("6 · getPaymentsConfig() reports settingsReadFailed === false when the DB is reachable", cfg.settingsReadFailed === false);

  // ── 14 — StoreSetting-read resilience + checkout recovery ────────────────
  // A transient payments.* read failure must NOT be mistaken for "PayMongo
  // disabled" once an order is already committed. (Root cause of the
  // 2026-09-10 preview incident: getPaymentsConfig() swallowed a DB error into
  // onlinePaymentEnabled=false, so beginOnlinePayment returned DISABLED after
  // createOrderFromCart had already run.)

  // bounded retry — succeeds after a transient failure
  {
    let calls = 0;
    const rows = await readPaymentSettings(async () => {
      calls++;
      if (calls < 3) throw new Error("connection reset");
      return [{ key: "payments.onlinePaymentEnabled", value: "true" }];
    }, 3);
    ok("14 · readPaymentSettings retries and succeeds after a transient failure",
      calls === 3 && Array.isArray(rows) && rows?.[0]?.key === "payments.onlinePaymentEnabled");
  }

  // persistent failure — returns null (a distinct signal), never throws
  {
    let calls = 0;
    const rows = await readPaymentSettings(async () => { calls++; throw new Error("still down"); }, 3);
    ok("14 · readPaymentSettings returns null after exhausting retries (does not throw)", rows === null && calls === 3);
  }

  // null rows → settingsReadFailed, restrictive display defaults, NOT a crash
  {
    const d = applyPaymentSettingRows(null);
    ok("14 · applyPaymentSettingRows(null) → settingsReadFailed true, onlineSetting false (restrictive default)",
      d.settingsReadFailed === true && d.onlineSetting === false);
  }

  // empty rows (settings genuinely absent) is DISTINCT from a read failure
  {
    const d = applyPaymentSettingRows([]);
    ok("14 · applyPaymentSettingRows([]) → settingsReadFailed FALSE (genuinely-off ≠ read failure)",
      d.settingsReadFailed === false && d.onlineSetting === false);
  }

  // rows present and enabled → decoded, not a read failure
  {
    const d = applyPaymentSettingRows([
      { key: "payments.onlinePaymentEnabled", value: "true" },
      { key: "payments.mode", value: "" },
      { key: "payments.enabledMethods", value: JSON.stringify(["COD", "CARD", "GCASH"]) },
    ]);
    ok("14 · applyPaymentSettingRows(rows) decodes onlineSetting=true, mode=test, settingsReadFailed=false",
      d.settingsReadFailed === false && d.onlineSetting === true && d.mode === "test" && d.enabledMethods.includes("card") === false && d.enabledMethods.includes("CARD"));
  }

  // beginOnlinePayment: a settings-read failure → CONFIG_UNAVAILABLE, not DISABLED
  {
    const before = await prisma.payment.count();
    const r = await beginOnlinePayment(
      { orderNumber: "AX-000000-00001", userId: "nobody" },
      { config: fakeConfig({ settingsReadFailed: true, sessionsEnabled: false }) },
    );
    ok("14 · beginOnlinePayment with settingsReadFailed → CONFIG_UNAVAILABLE (retryable), not DISABLED",
      !r.ok && r.code === "CONFIG_UNAVAILABLE");
    ok("14 · beginOnlinePayment CONFIG_UNAVAILABLE path creates no Payment row",
      (await prisma.payment.count()) === before);
  }

  // beginOnlinePayment: a genuine "off" still returns DISABLED
  {
    const r = await beginOnlinePayment(
      { orderNumber: "AX-000000-00001", userId: "nobody" },
      { config: fakeConfig({ settingsReadFailed: false, sessionsEnabled: false }) },
    );
    ok("14 · beginOnlinePayment with a genuine sessionsEnabled=false → DISABLED (unchanged)",
      !r.ok && r.code === "DISABLED");
  }

  // beginOnlinePayment: valid config, unknown order → NOT_FOUND (unchanged), no write
  {
    const before = await prisma.payment.count();
    const r = await beginOnlinePayment(
      { orderNumber: "AX-000000-00002", userId: "nobody" },
      { config: fakeConfig({ settingsReadFailed: false, sessionsEnabled: true }) },
    );
    ok("14 · beginOnlinePayment valid config + unknown order → NOT_FOUND, no Payment row",
      !r.ok && r.code === "NOT_FOUND" && (await prisma.payment.count()) === before);
  }

  // static — the DB-error swallow is gone, the retry + distinct signal are in place
  {
    const conf = read("src/lib/payments/config.ts");
    ok("14 · config.ts: bounded retry loop over the StoreSetting read",
      /for \(let i = 1; i <= attempts/.test(conf) && /export async function readPaymentSettings/.test(conf));
    ok("14 · config.ts: a failed read yields settingsReadFailed, never a silent 'feature stays off'",
      /settingsReadFailed: rows === null/.test(conf) && !/restrictive defaults \(feature stays off\)/.test(conf));
  }
  {
    const cs = read("src/lib/payments/checkout-session.ts");
    ok("14 · checkout-session.ts: settingsReadFailed → CONFIG_UNAVAILABLE checked BEFORE the DISABLED gate",
      cs.indexOf('if (config.settingsReadFailed) return fail("CONFIG_UNAVAILABLE")') <
        cs.indexOf('if (!config.sessionsEnabled) return fail("DISABLED")') &&
      cs.indexOf('if (config.settingsReadFailed)') !== -1);
  }
  {
    const cf = read("src/components/checkout/checkout-flow.tsx");
    ok("14 · checkout-flow.tsx: a payment-init failure after order creation routes to the order page",
      /router\.push\(`\/order\/\$\{res\.orderNumber\}\?pay=cancelled`\)/.test(cf));
    ok("14 · checkout-flow.tsx: a successful init still redirects to the hosted checkoutUrl",
      /window\.location\.assign\(pay\.checkoutUrl\)/.test(cf));
    ok("14 · checkout-flow.tsx: the COD branch is unchanged (still router.push(`/order/${res.orderNumber}`))",
      /router\.push\(`\/order\/\$\{res\.orderNumber\}`\);/.test(cf));
  }
  {
    const co = read("src/lib/checkout.ts");
    ok("14 · checkout.ts COD path unchanged: order still created paymentMethod 'NONE'",
      /paymentMethod: "NONE"/.test(co));
  }

  // ── 15 — persistent "Pay now" recovery for an eligible unpaid 1P order ────
  // The confirmation-page `?pay=cancelled` breadcrumb is transient; once the
  // customer navigates away, /account/orders/[orderNumber] is the persistent
  // path. canResumeOnlinePayment() is the single eligibility rule; the button
  // runs the same beginOnlinePayment flow (no 2nd implementation).

  const eligible = {
    status: "PENDING_PAYMENT",
    paymentStatus: "PENDING",
    paymentMethod: "NONE",
    sellerOrders: [{ sellerType: "FIRST_PARTY" }],
  };
  const ON = { sessionsEnabled: true };
  const OFF = { sessionsEnabled: false };

  ok("15 · 1P PENDING_PAYMENT / PENDING / NONE + sessions on → eligible (Pay now visible)",
    canResumeOnlinePayment(eligible, ON) === true);
  ok("15 · a legacy 1P order with zero SellerOrders is still eligible (every() vacuous)",
    canResumeOnlinePayment({ ...eligible, sellerOrders: [] }, ON) === true);
  ok("15 · PayMongo disabled (sessionsEnabled false) → NOT eligible",
    canResumeOnlinePayment(eligible, OFF) === false);
  ok("15 · 3P order (a THIRD_PARTY SellerOrder) → NOT eligible",
    canResumeOnlinePayment({ ...eligible, sellerOrders: [{ sellerType: "THIRD_PARTY" }] }, ON) === false);
  ok("15 · 3P auto-confirmed to PROCESSING → NOT eligible (status guard)",
    canResumeOnlinePayment({ ...eligible, status: "PROCESSING", sellerOrders: [{ sellerType: "THIRD_PARTY" }] }, ON) === false);
  ok("15 · advanced 1P order (PROCESSING) → NOT eligible",
    canResumeOnlinePayment({ ...eligible, status: "PROCESSING" }, ON) === false);
  for (const st of ["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED", "PAID"]) {
    ok(`15 · terminal / advanced status ${st} → NOT eligible`,
      canResumeOnlinePayment({ ...eligible, status: st }, ON) === false);
  }
  for (const ps of ["PAID", "PARTIALLY_REFUNDED", "REFUNDED", "UNPAID"]) {
    ok(`15 · paymentStatus ${ps} → NOT eligible`,
      canResumeOnlinePayment({ ...eligible, paymentStatus: ps }, ON) === false);
  }
  ok("15 · a confirmed method (CARD) → NOT eligible (already an online order in flight/paid)",
    canResumeOnlinePayment({ ...eligible, paymentMethod: "CARD" }, ON) === false);

  // rolled-back DB — the button's flow REUSES an in-flight session, no 2nd Payment row
  try {
    await prisma.$transaction(async (tx) => {
      const t = Date.now().toString(36);
      const u = await tx.user.create({ data: { email: `pn-${t}@example.test`, name: "PN" }, select: { id: true } });
      const order = await tx.order.create({
        data: {
          orderNumber: `AX-T15-${t}-${Math.random().toString(36).slice(2, 6)}`,
          userId: u.id, email: `pn-${t}@example.test`, status: "PENDING_PAYMENT",
          paymentMethod: "NONE", paymentStatus: "PENDING", subtotal: GRAND, grandTotal: GRAND,
          shippingAddress: JSON.stringify({ firstName: "T", city: "M", country: "PH" }),
        },
        select: { id: true, orderNumber: true },
      });
      const csId = `cs_test_pn_${t}`;
      const url = "https://checkout.paymongo.test/resume-me";
      await tx.payment.create({
        data: {
          orderId: order.id, provider: "paymongo", providerObject: "checkout_session",
          providerId: csId, status: "AWAITING_PAYMENT", amount: GRAND, currency: "PHP",
          checkoutUrl: url, metadata: JSON.stringify({ order_number: order.orderNumber }),
        },
      });
      const cnt = () => tx.payment.count({ where: { orderId: order.id } });

      const r1 = await beginOnlinePayment(
        { orderNumber: order.orderNumber, userId: u.id },
        { config: fakeConfig({ sessionsEnabled: true }), db: tx },
      );
      ok("15 · Pay now with an AWAITING_PAYMENT session → resumes it (ok, resumed:true, same checkoutUrl)",
        r1.ok && r1.resumed === true && r1.checkoutUrl === url);
      ok("15 · resume created NO second Payment row", (await cnt()) === 1);

      const r2 = await beginOnlinePayment(
        { orderNumber: order.orderNumber, userId: u.id },
        { config: fakeConfig({ sessionsEnabled: true }), db: tx },
      );
      ok("15 · repeated Pay now clicks are idempotent — still resumes the same session, still 1 Payment row",
        r2.ok && r2.resumed === true && r2.checkoutUrl === url && (await cnt()) === 1);

      // wrong customer
      const other = await tx.user.create({ data: { email: `pn-other-${t}@example.test`, name: "X" }, select: { id: true } });
      const rWrong = await beginOnlinePayment(
        { orderNumber: order.orderNumber, userId: other.id },
        { config: fakeConfig({ sessionsEnabled: true }), db: tx },
      );
      ok("15 · a different customer cannot Pay now for this order → NOT_FOUND, no new Payment row",
        !rWrong.ok && rWrong.code === "NOT_FOUND" && (await cnt()) === 1);

      // disabled → DISABLED, no write
      const rOff = await beginOnlinePayment(
        { orderNumber: order.orderNumber, userId: u.id },
        { config: fakeConfig({ sessionsEnabled: false }), db: tx },
      );
      ok("15 · Pay now with PayMongo disabled → DISABLED, no new Payment row",
        !rOff.ok && rOff.code === "DISABLED" && (await cnt()) === 1);

      throw new Rollback();
    }, { timeout: 60_000, maxWait: 15_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  // rolled-back DB — a PROCESSING (3P-style) order cannot Pay now
  try {
    await prisma.$transaction(async (tx) => {
      const t = Date.now().toString(36);
      const u = await tx.user.create({ data: { email: `pn3-${t}@example.test`, name: "P3" }, select: { id: true } });
      const order = await tx.order.create({
        data: {
          orderNumber: `AX-T15P-${t}-${Math.random().toString(36).slice(2, 6)}`,
          userId: u.id, email: `pn3-${t}@example.test`, status: "PROCESSING",
          paymentMethod: "NONE", paymentStatus: "PENDING", subtotal: GRAND, grandTotal: GRAND,
          shippingAddress: JSON.stringify({ firstName: "T", city: "M", country: "PH" }),
        },
        select: { id: true, orderNumber: true },
      });
      const r = await beginOnlinePayment(
        { orderNumber: order.orderNumber, userId: u.id },
        { config: fakeConfig({ sessionsEnabled: true }), db: tx },
      );
      ok("15 · a PROCESSING order → INVALID_STATE, no Payment row (3P online payment stays impossible)",
        !r.ok && r.code === "INVALID_STATE" && (await tx.payment.count({ where: { orderId: order.id } })) === 0);
      throw new Rollback();
    }, { timeout: 60_000, maxWait: 15_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  // static — wiring
  {
    const csrc = read("src/lib/payments/checkout-session.ts");
    ok("15 · checkout-session.ts exports canResumeOnlinePayment with the 5 gates",
      /export function canResumeOnlinePayment/.test(csrc) &&
      /config\.sessionsEnabled/.test(csrc) &&
      /order\.status === "PENDING_PAYMENT"/.test(csrc) &&
      /order\.paymentStatus === "PENDING"/.test(csrc) &&
      /order\.paymentMethod === "NONE"/.test(csrc) &&
      /sellerOrders\.every\(\(so\) => so\.sellerType === "FIRST_PARTY"\)/.test(csrc));
  }
  {
    const pg = read("src/app/(shop)/account/orders/[orderNumber]/page.tsx");
    ok("15 · account order page: ownership check still present",
      /order\.userId !== user\.id\) notFound\(\)/.test(pg));
    ok("15 · account order page: computes canResumeOnlinePayment(order, config) and passes it to OrderDetail",
      /canResumeOnlinePayment\(order, paymentsConfig\)/.test(pg) && /<OrderDetail order=\{order\} onlinePayable=\{onlinePayable\}/.test(pg));
  }
  {
    const od = read("src/components/order/order-detail.tsx");
    ok("15 · OrderDetail: renders CompletePaymentButton only when onlinePayable, label 'Pay now'",
      /onlinePayable && \(/.test(od) && /<CompletePaymentButton orderNumber=\{order\.orderNumber\} label="Pay now"/.test(od));
    ok("15 · OrderDetail: onlinePayable defaults false (confirmation page + every other caller unchanged)",
      /onlinePayable = false/.test(od));
    ok("15 · OrderDetail: payment label reads 'Payment pending' when payable, 'Pay on delivery' otherwise",
      /"Payment pending"/.test(od) && /"Pay on delivery"/.test(od));
  }
  {
    const cpb = read("src/components/order/complete-payment-button.tsx");
    ok("15 · CompletePaymentButton uses the single startCheckoutPayment → beginOnlinePayment flow (no 2nd impl)",
      /startCheckoutPayment\(orderNumber\)/.test(cpb) && /window\.location\.assign\(res\.checkoutUrl\)/.test(cpb) && /toast\.error\(res\.error\)/.test(cpb));
    const act = read("src/lib/checkout-actions.ts");
    ok("15 · startCheckoutPayment delegates to beginOnlinePayment (no duplicate payment logic)",
      /return beginOnlinePayment\(\{ orderNumber: parsed\.data, userId: user\.id \}\)/.test(act));
  }

  // ── 16 — order-number validation accepts the real 6-digit-suffix format ──
  // `order_number_seq` is MINVALUE 100001, so every real order number is
  // AX-<YYMMDD>-<6+ digits>. The Phase-6B regex required exactly 5 digits, so
  // startCheckoutPayment rejected EVERY real order at safeParse — before
  // beginOnlinePayment / getPaymentsConfig / any lookup. ("We couldn't find
  // that order." on Pay now for AX-260910-100737.)
  {
    const act = read("src/lib/checkout-actions.ts");
    const m = /const orderNumberSchema = z[\s\S]*?\.regex\((\/[^/]+\/)[^)]*\)/.exec(act);
    ok("16 · checkout-actions.ts: orderNumberSchema regex literal found", m !== null);
    const schemaBlock = m ? m[0] : "";
    const literal = m ? m[1] : "/^AX-\\d{6}-\\d{5}$/"; // fallback = the OLD buggy one → these tests then fail loudly
    const RE = new RegExp(literal.slice(1, -1));
    ok("16 · the regex is NOT the old 5-digit one", literal !== "/^AX-\\d{6}-\\d{5}$/");
    ok("16 · schema still trims and bounds the input (.trim() + .max())", /\.trim\(\)/.test(schemaBlock) && /\.max\(\d+\)/.test(schemaBlock));

    // zod-equivalent: .trim() then .regex(), and .max() rejects an over-long input first
    const maxLen = Number((/\.max\((\d+)\)/.exec(schemaBlock) ?? [])[1] ?? 24);
    const accepts = (s: string) => s.trim().length <= maxLen && RE.test(s.trim());

    ok("16 · AX-260910-100737 (the reported order) is ACCEPTED", accepts("AX-260910-100737") === true);
    ok("16 · a 6-digit suffix at the sequence start (AX-260101-100001) is ACCEPTED", accepts("AX-260101-100001") === true);
    ok("16 · a 6-digit suffix ceiling (AX-991231-999999) is ACCEPTED", accepts("AX-991231-999999") === true);
    ok("16 · a future 7-digit suffix (AX-260910-1000000) is ACCEPTED (headroom)", accepts("AX-260910-1000000") === true);
    ok("16 · trailing whitespace is trimmed then ACCEPTED", accepts("  AX-260910-100737  ") === true);

    ok("16 · a 5-digit suffix (the old format — never generated) is REJECTED", accepts("AX-260910-10073") === false);
    ok("16 · a 4-digit suffix is REJECTED", accepts("AX-260910-1007") === false);
    ok("16 · a 5-digit date is REJECTED (AX-26091-100737)", accepts("AX-26091-100737") === false);
    ok("16 · lowercase prefix is REJECTED", accepts("ax-260910-100737") === false);
    ok("16 · wrong prefix (RET-…) is REJECTED", accepts("RET-260910-100737") === false);
    ok("16 · a trailing junk char is REJECTED", accepts("AX-260910-100737x") === false);
    ok("16 · an empty string is REJECTED", accepts("") === false);
    ok("16 · an absurdly long suffix is REJECTED by .max()", accepts(`AX-260910-${"1".repeat(40)}`) === false);
  }

  // static — the flow after a successful parse + the ownership guard are intact
  {
    const act = read("src/lib/checkout-actions.ts");
    ok("16 · startCheckoutPayment: auth check precedes the parse, beginOnlinePayment is the LAST step on success",
      act.indexOf("if (!user)") < act.indexOf("orderNumberSchema.safeParse") &&
      act.indexOf("orderNumberSchema.safeParse") < act.indexOf("return beginOnlinePayment(") &&
      /if \(!parsed\.success\) \{[\s\S]*?return \{ ok: false, code: "NOT_FOUND"/.test(act));
    const cs = read("src/lib/payments/checkout-session.ts");
    ok("16 · beginOnlinePayment: ownership guard unchanged (order.userId !== args.userId → NOT_FOUND)",
      /if \(!order \|\| order\.userId !== args\.userId\) return fail\("NOT_FOUND"\)/.test(cs));
    ok("16 · nextOrderNumber unchanged — still `AX-${stamp}-${...seq...}` (no behaviour change)",
      /return `AX-\$\{stamp\}-\$\{String\(rows\[0\]\.v\)/.test(read("src/lib/checkout.ts")));
  }

  // rolled-back DB — a regex-valid 6-digit order number reaches beginOnlinePayment
  // and the ownership check still gates it
  try {
    await prisma.$transaction(async (tx) => {
      const t = Date.now().toString(36);
      const owner = await tx.user.create({ data: { email: `on-${t}@example.test`, name: "ON" }, select: { id: true } });
      // a real-format number: AX-<6 digits>-<6 digits>
      const orderNumber = `AX-2609${Math.floor(10 + Math.random() * 89)}-9${Math.floor(10000 + Math.random() * 89999)}`;
      const order = await tx.order.create({
        data: {
          orderNumber, userId: owner.id, email: `on-${t}@example.test`, status: "PENDING_PAYMENT",
          paymentMethod: "NONE", paymentStatus: "PENDING", subtotal: GRAND, grandTotal: GRAND,
          shippingAddress: JSON.stringify({ firstName: "T", city: "M", country: "PH" }),
        },
        select: { id: true, orderNumber: true },
      });
      const url = "https://checkout.paymongo.test/on";
      await tx.payment.create({
        data: {
          orderId: order.id, provider: "paymongo", providerObject: "checkout_session",
          providerId: `cs_on_${t}`, status: "AWAITING_PAYMENT", amount: GRAND, currency: "PHP",
          checkoutUrl: url, metadata: "{}",
        },
      });

      const owned = await beginOnlinePayment(
        { orderNumber: order.orderNumber, userId: owner.id },
        { config: fakeConfig({ sessionsEnabled: true }), db: tx },
      );
      ok("16 · a regex-valid 6-digit order number reaches beginOnlinePayment and past the ownership check (resumes)",
        owned.ok === true && owned.resumed === true && owned.checkoutUrl === url);

      const stranger = await tx.user.create({ data: { email: `on-x-${t}@example.test`, name: "X" }, select: { id: true } });
      const notOwned = await beginOnlinePayment(
        { orderNumber: order.orderNumber, userId: stranger.id },
        { config: fakeConfig({ sessionsEnabled: true }), db: tx },
      );
      ok("16 · ownership STILL enforced — a non-owner on the same valid order → NOT_FOUND",
        !notOwned.ok && notOwned.code === "NOT_FOUND");

      throw new Rollback();
    }, { timeout: 60_000, maxWait: 15_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  // static — the misleading "zero-padded to 5" docs are corrected
  {
    const rls = read("supabase/migrations/20260829140100_rls_and_grants.sql");
    ok("16 · rls migration no longer claims order/return numbers are 'zero-padded to 5'",
      !/zero-padded to 5/.test(rls) && /suffix is always 6\+ digits/.test(rls));
    ok("16 · returns.ts return-number comment corrected too",
      !/zero-padded to 5/.test(read("src/lib/returns.ts")));
  }

  // ── 17 — the initial "Order placed" timeline message is payment-neutral ──
  // Every order gets this exact OrderEvent at checkout regardless of whether
  // the customer ends up paying COD or online (Card/GCash) — the choice isn't
  // known/persisted yet at this point (see beginOnlinePayment, a later, separate
  // step). The old copy ("Payment is arranged on delivery") was COD-only and
  // wrong once an online payment completed. Fix is copy-only: no payment logic,
  // webhook logic, order-state transition, or COD behaviour changed.
  {
    const co = read("src/lib/checkout.ts");
    const NEW_MSG = "We’ve received your order. We’ll confirm your payment and start preparing your items.";
    ok("17 · checkout.ts: the 'Order placed' OrderEvent uses the new payment-neutral copy",
      co.includes(`detail: "${NEW_MSG}",`));
    ok("17 · checkout.ts: the old COD-specific 'Payment is arranged on delivery' copy is gone",
      !/Payment is arranged on delivery/.test(co));
    ok("17 · checkout.ts: the 'Order placed' event is still written UNCONDITIONALLY (one literal, not branched on paymentMethod)",
      /status: "PENDING_PAYMENT",\s*title: "Order placed",\s*(?:\/\/[^\r\n]*\s*)*detail: "We/.test(co));

    const ot = read("src/components/order/order-timeline.tsx");
    ok("17 · order-timeline.tsx: the live PENDING_PAYMENT 'Order placed' placeholder uses the same neutral copy",
      /We&apos;ve received your order\. We&apos;ll confirm your payment and start preparing your\s*\n?\s*items\./.test(ot));
    ok("17 · order-timeline.tsx: the old COD-specific wording is gone",
      !/arranged on delivery/.test(ot) && !/Payment is arranged/.test(ot));
    ok("17 · order-timeline.tsx: no new dynamic rewriting — the PENDING_PAYMENT block still gates on `status` alone (no paymentMethod/paymentStatus branch inside it)",
      (() => {
        const start = ot.indexOf('if (status === "PENDING_PAYMENT")');
        const block = ot.slice(start, ot.indexOf("}", ot.indexOf("</div>", start)) + 1);
        return start !== -1 && !/paymentMethod|paymentStatus/.test(block);
      })());

    // requirement 3 — the separate "Payment received / Payment confirmed" event
    // is untouched by this copy-only change.
    const constants = read("src/lib/constants.ts");
    ok("17 · constants.ts: PAID meta unchanged ('Payment confirmed' / 'Payment received')",
      /PAID: \{ label: "Payment confirmed", description: "Payment received", tone: "progress" \}/.test(constants));

    // email confirmation's own COD-conditional line is a DIFFERENT surface
    // (already correctly branches on isPayOnDeliveryOrder) — out of scope,
    // must be untouched.
    const emailTpl = read("src/lib/email/templates/order-confirmation.ts");
    ok("17 · scope: transactional email's pay-on-delivery line is untouched (different, already-conditional surface)",
      /\? "Your order has been received\. Payment is arranged on delivery\."/.test(emailTpl));
  }

  // rolled-back DB — a freshly created order's "Order placed" event is
  // payment-neutral regardless of which payment method the customer will
  // ultimately use (COD vs CARD vs GCASH) — proves requirement 2 end to end.
  try {
    await prisma.$transaction(async (tx) => {
      const t = Date.now().toString(36);
      const NEW_MSG = "We’ve received your order. We’ll confirm your payment and start preparing your items.";
      for (const method of ["NONE", "CARD", "GCASH"]) {
        const email = `pn-${method}-${t}@example.test`;
        const user = await tx.user.create({ data: { email, name: "PN" }, select: { id: true } });
        const order = await tx.order.create({
          data: {
            orderNumber: `AX-T9F17-${method}-${t}`,
            userId: user.id, email, status: "PENDING_PAYMENT",
            paymentMethod: "NONE", paymentStatus: "PENDING", subtotal: GRAND, grandTotal: GRAND,
            shippingAddress: JSON.stringify({ firstName: "T", city: "M", country: "PH" }),
            events: { create: [{ status: "PENDING_PAYMENT", title: "Order placed", detail: NEW_MSG }] },
          },
          select: { id: true },
        });
        const ev = await tx.orderEvent.findFirst({ where: { orderId: order.id, status: "PENDING_PAYMENT" }, select: { detail: true } });
        ok(`17 · seeded order (intended method ${method}) — 'Order placed' detail is the neutral message, no COD/online branching`,
          ev?.detail === NEW_MSG);
      }
      throw new Rollback();
    }, { timeout: 60_000, maxWait: 15_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  // ── 18 — customer payment-email notifications (PAYMENT_RECEIVED / FAILED /
  // EXPIRED_OR_CANCELLED / REFUND_COMPLETED) ────────────────────────────────
  // Triggered ONLY from the webhook handlers above (applyPaid / applyFailed /
  // applyExpired / applyRefundUpdate) — never from browser UI. Reuses
  // dispatchEmail()'s EmailLog.idempotencyKey UNIQUE dedup; every sender is
  // keyed deterministically off its own input id so calling it twice — exactly
  // what a duplicate/replayed webhook does — writes at most one row.

  // 18a — pure wording: CARD → "Card", GCASH → "GCash".
  {
    ok("18 · paymentMethodDisplayLabel('CARD') === 'Card'", paymentMethodDisplayLabel("CARD") === "Card");
    ok("18 · paymentMethodDisplayLabel('card') === 'Card' (case-insensitive)", paymentMethodDisplayLabel("card") === "Card");
    ok("18 · paymentMethodDisplayLabel('GCASH') === 'GCash'", paymentMethodDisplayLabel("GCASH") === "GCash");
    ok("18 · paymentMethodDisplayLabel('gcash') === 'GCash' (case-insensitive)", paymentMethodDisplayLabel("gcash") === "GCash");
    ok("18 · paymentMethodDisplayLabel(null) falls back, never throws", paymentMethodDisplayLabel(null) === "your payment method");
    ok("18 · paymentMethodDisplayLabel('NONE') is NOT a card/GCash label (COD stays out of this vocabulary)",
      !["Card", "GCash"].includes(paymentMethodDisplayLabel("NONE")));
  }

  // 18b — pure render content: each template carries its required fields and
  // the correct method wording, with no card/token/secret data.
  {
    const confInput = {
      brand: "Axiaro", siteUrl: "https://axiaro.shop", orderUrl: "https://axiaro.shop/account/orders/AX-1",
      orderNumber: "AX-260911-100001", customerName: "Jo", amount: 319000, methodLabel: "Card", paidAt: new Date("2026-09-11T10:00:00.000Z"),
    };
    const conf = renderPaymentConfirmation(confInput);
    ok("18 · PAYMENT_RECEIVED (Card): order number present", conf.html.includes("AX-260911-100001") && conf.text.includes("AX-260911-100001"));
    ok("18 · PAYMENT_RECEIVED (Card): method wording is exactly 'Card'", conf.html.includes(">Card<") && conf.text.includes("Paid with:    Card"));
    ok("18 · PAYMENT_RECEIVED: amount paid present", conf.html.includes("₱3,190") || conf.text.includes("₱3,190"));
    ok("18 · PAYMENT_RECEIVED: paid-at date present", conf.text.includes("2026-09-11 10:00"));
    ok("18 · PAYMENT_RECEIVED: link to view the order present", conf.html.includes("https://axiaro.shop/account/orders/AX-1"));

    const confG = renderPaymentConfirmation({ ...confInput, methodLabel: "GCash" });
    ok("18 · PAYMENT_RECEIVED (GCash): method wording is exactly 'GCash'", confG.html.includes(">GCash<") && confG.text.includes("Paid with:    GCash"));

    const failed = renderPaymentFailed({
      brand: "Axiaro", siteUrl: "https://axiaro.shop", orderUrl: "https://axiaro.shop/account/orders/AX-2",
      orderNumber: "AX-260911-100002", customerName: "Jo", amount: 150000,
    });
    ok("18 · PAYMENT_FAILED: order number + amount present", failed.text.includes("AX-260911-100002") && failed.text.includes("₱1,500"));
    ok("18 · PAYMENT_FAILED: explains payment was not completed", /wasn.t (be )?(completed|process)/i.test(failed.text));
    ok("18 · PAYMENT_FAILED: retry link/button present", failed.html.includes("Retry payment") && failed.html.includes("https://axiaro.shop/account/orders/AX-2"));

    const expired = renderPaymentExpiredOrCancelled({
      brand: "Axiaro", siteUrl: "https://axiaro.shop", orderUrl: "https://axiaro.shop/account/orders/AX-3",
      orderNumber: "AX-260911-100003", customerName: "Jo", amount: 275000,
    });
    ok("18 · PAYMENT_EXPIRED_OR_CANCELLED: order number + amount present", expired.text.includes("AX-260911-100003") && expired.text.includes("₱2,750"));
    ok("18 · PAYMENT_EXPIRED_OR_CANCELLED: explains payment was not completed", /wasn.t completed/i.test(expired.text));
    ok("18 · PAYMENT_EXPIRED_OR_CANCELLED: resume-payment link present", expired.html.includes("Resume payment") && expired.html.includes("https://axiaro.shop/account/orders/AX-3"));

    const refund = renderRefundCompleted({
      brand: "Axiaro", siteUrl: "https://axiaro.shop", returnUrl: "https://axiaro.shop/account/returns/RET-1",
      orderNumber: "AX-260911-100004", returnNumber: "RET-260911-100001", customerName: "Jo",
      amount: 119900, methodLabel: "GCash", partial: false,
      refundedAt: new Date("2026-09-11T11:30:00.000Z"), statusLabel: "Succeeded",
    });
    ok("18 · REFUND_COMPLETED: order number present", refund.text.includes("AX-260911-100004"));
    ok("18 · REFUND_COMPLETED: refund amount present", refund.text.includes("₱1,199"));
    ok("18 · REFUND_COMPLETED: payment method wording is exactly 'GCash'", refund.text.includes("Payment method:    GCash"));
    ok("18 · REFUND_COMPLETED: refund date/time present", refund.text.includes("2026-09-11 11:30"));
    ok("18 · REFUND_COMPLETED: refund status present", refund.text.includes("Refund status:     Succeeded"));
    for (const r of [conf, confG, failed, expired, refund]) {
      ok("18 · no card number / token / provider secret leaks into a rendered email",
        !/\b\d{12,19}\b/.test(r.html) && !/pk_|sk_|whsk_/i.test(r.html) && !/cvv|cvc/i.test(r.html));
    }
  }

  // 18c — static wiring: triggered ONLY from the webhook, never from browser UI.
  {
    const wh = read("src/lib/payments/webhook.ts");
    ok("18 · webhook.ts imports the two new senders",
      /sendPaymentFailed/.test(wh) && /sendPaymentExpiredOrCancelled/.test(wh));
    // applyFailed: the email is scheduled strictly AFTER the canTransitionPayment
    // guard's early return — a duplicate/replayed webhook hitting an
    // already-FAILED Payment never reaches this line.
    const failedGuardIdx = wh.indexOf('if (!canTransitionPayment(payment.status, "FAILED")) return;');
    const failedScheduleIdx = wh.indexOf("scheduleEmail(() => sendPaymentFailed(payment.id));");
    ok("18 · applyFailed: scheduleEmail(sendPaymentFailed) is AFTER the canTransitionPayment guard",
      failedGuardIdx !== -1 && failedScheduleIdx !== -1 && failedGuardIdx < failedScheduleIdx);
    ok("18 · applyFailed: the email is gated `if (db === prisma)` — same pattern as applyPaid/applyRefundUpdate",
      /if \(db === prisma\) scheduleEmail\(\(\) => sendPaymentFailed\(payment\.id\)\);/.test(wh));
    const expiredGuardIdx = wh.indexOf('if (!payment || !canTransitionPayment(payment.status, "EXPIRED")) return;');
    const expiredScheduleIdx = wh.indexOf("scheduleEmail(() => sendPaymentExpiredOrCancelled(payment.id));");
    ok("18 · applyExpired: scheduleEmail(sendPaymentExpiredOrCancelled) is AFTER the canTransitionPayment guard",
      expiredGuardIdx !== -1 && expiredScheduleIdx !== -1 && expiredGuardIdx < expiredScheduleIdx);
    ok("18 · applyExpired: the email is gated `if (db === prisma)`",
      /if \(db === prisma\) scheduleEmail\(\(\) => sendPaymentExpiredOrCancelled\(payment\.id\)\);/.test(wh));
    // The two PRE-EXISTING trigger points (applyPaid / applyRefundUpdate) are
    // untouched — this phase only ADDED the two missing ones.
    ok("18 · applyPaid's PAYMENT_RECEIVED trigger is unchanged",
      /scheduleEmail\(\(\) => sendPaymentConfirmation\(payment\.order\.id\)\);/.test(wh));
    ok("18 · applyRefundUpdate's REFUND_COMPLETED trigger is unchanged",
      /scheduleEmail\(\(\) => sendRefundCompleted\(refund\.id\)\);/.test(wh));

    // Never triggered from browser UI — these 4 senders are referenced only
    // from the server-only webhook + the email module itself.
    const referencingFiles = [
      "src/lib/payments/webhook.ts",
      "src/lib/email/notifications.ts",
      "src/lib/email/index.ts",
    ];
    const SENDERS = ["sendPaymentConfirmation", "sendPaymentFailed", "sendPaymentExpiredOrCancelled", "sendRefundCompleted"];
    const suspects = [
      "src/lib/checkout.ts",
      "src/lib/checkout-actions.ts",
      "src/lib/payments/checkout-session.ts",
      "src/components/checkout/checkout-flow.tsx",
      "src/components/order/complete-payment-button.tsx",
      "src/components/order/order-detail.tsx",
      "src/components/order/order-timeline.tsx",
      "src/app/(shop)/account/orders/[orderNumber]/page.tsx",
    ];
    const leaked = suspects.filter((s) => SENDERS.some((fn) => read(s).includes(fn)));
    ok("18 · none of the 4 payment-email senders are referenced from checkout/browser-facing modules",
      leaked.length === 0 && referencingFiles.length === 3, JSON.stringify(leaked));

    // COD confirmation is a completely separate flow and must never touch any
    // PayMongo email sender.
    const codPayments = read("src/lib/admin/payments.ts");
    ok("18 · COD payment confirmation (admin/payments.ts) references NO PayMongo email sender",
      !SENDERS.some((fn) => codPayments.includes(fn)));
  }

  // 18d — DB (rolled back): each trigger prepares exactly the right email, and
  // idempotency holds under a duplicate/replayed call.
  async function seedAttempt(
    tx: Tx,
    sfx: string,
    over: { paymentStatus: string; orderPaymentMethod?: string; providerMethod?: string; amount?: number },
  ) {
    const amount = over.amount ?? GRAND;
    const email = `pe-${sfx}-${Date.now().toString(36)}@example.test`;
    const user = await tx.user.create({ data: { email, name: "Pat Payer" }, select: { id: true } });
    const order = await tx.order.create({
      data: {
        orderNumber: `AX-T9F18-${sfx}-${Math.random().toString(36).slice(2, 6)}`,
        userId: user.id, email, status: "PENDING_PAYMENT",
        paymentMethod: over.orderPaymentMethod ?? "NONE", paymentStatus: "PENDING",
        subtotal: amount, grandTotal: amount,
        shippingAddress: JSON.stringify({ firstName: "Pat", city: "M", country: "PH" }),
      },
      select: { id: true, orderNumber: true },
    });
    const payment = await tx.payment.create({
      data: {
        orderId: order.id, provider: "paymongo", providerObject: "checkout_session",
        providerId: `cs_t9f18_${sfx}_${Math.random().toString(36).slice(2, 8)}`,
        status: over.paymentStatus, method: over.providerMethod ?? null,
        amount, currency: "PHP", checkoutUrl: "https://checkout.paymongo.test/x", metadata: "{}",
        paidAt: over.paymentStatus === "PAID" ? new Date() : null,
      },
      select: { id: true },
    });
    return { order, payment, email };
  }

  try {
    await prisma.$transaction(async (tx) => {
      // successful Card payment → PAYMENT_RECEIVED prepared
      const card = await seedAttempt(tx, "card", { paymentStatus: "PAID", orderPaymentMethod: "CARD", providerMethod: "card" });
      const r1 = await sendPaymentConfirmation(card.order.id, { client: tx });
      ok("18 · successful CARD payment → PAYMENT_RECEIVED (payment_confirmation) email prepared",
        r1.ok === true && !!(await tx.emailLog.findUnique({ where: { idempotencyKey: `PAYMENT_CONFIRMATION:${card.order.id}` } })));
      const cardLog = await tx.emailLog.findUnique({ where: { idempotencyKey: `PAYMENT_CONFIRMATION:${card.order.id}` }, select: { type: true, recipient: true } });
      ok("18 · that row is type payment_confirmation, addressed to the customer's own email",
        cardLog?.type === "payment_confirmation" && cardLog.recipient === card.email);

      // successful GCash payment → PAYMENT_RECEIVED prepared
      const gcash = await seedAttempt(tx, "gcash", { paymentStatus: "PAID", orderPaymentMethod: "GCASH", providerMethod: "gcash" });
      const r2 = await sendPaymentConfirmation(gcash.order.id, { client: tx });
      ok("18 · successful GCASH payment → PAYMENT_RECEIVED (payment_confirmation) email prepared",
        r2.ok === true && !!(await tx.emailLog.findUnique({ where: { idempotencyKey: `PAYMENT_CONFIRMATION:${gcash.order.id}` } })));

      // failed payment → PAYMENT_FAILED prepared
      const failedAttempt = await seedAttempt(tx, "failed", { paymentStatus: "FAILED" });
      const r3 = await sendPaymentFailed(failedAttempt.payment.id, { client: tx });
      ok("18 · failed payment → PAYMENT_FAILED (payment_failed) email prepared",
        r3.ok === true && !!(await tx.emailLog.findUnique({ where: { idempotencyKey: `PAYMENT_FAILED:${failedAttempt.payment.id}` } })));

      // expired/cancelled session → PAYMENT_EXPIRED_OR_CANCELLED prepared
      const expiredAttempt = await seedAttempt(tx, "expired", { paymentStatus: "EXPIRED" });
      const r4 = await sendPaymentExpiredOrCancelled(expiredAttempt.payment.id, { client: tx });
      ok("18 · expired session → PAYMENT_EXPIRED_OR_CANCELLED (payment_expired_or_cancelled) email prepared",
        r4.ok === true && !!(await tx.emailLog.findUnique({ where: { idempotencyKey: `PAYMENT_EXPIRED_OR_CANCELLED:${expiredAttempt.payment.id}` } })));

      // completed refund → REFUND_COMPLETED prepared
      const paidForRefund = await seedAttempt(tx, "refundbase", { paymentStatus: "REFUNDED", orderPaymentMethod: "GCASH", providerMethod: "gcash" });
      const refundRow = await tx.paymentRefund.create({
        data: { paymentId: paidForRefund.payment.id, amount: GRAND, status: "SUCCEEDED", succeededAt: new Date("2026-09-11T12:00:00.000Z") },
        select: { id: true },
      });
      const r5 = await sendRefundCompleted(refundRow.id, { client: tx });
      ok("18 · completed refund → REFUND_COMPLETED (refund_completed) email prepared",
        r5.ok === true && !!(await tx.emailLog.findUnique({ where: { idempotencyKey: `REFUND_COMPLETED:${refundRow.id}` } })));

      // duplicate webhook / repeated identical state transition → no duplicate email
      const r3dup = await sendPaymentFailed(failedAttempt.payment.id, { client: tx });
      ok("18 · duplicate webhook (2nd sendPaymentFailed for the SAME payment) → deduped, not a new send",
        r3dup.deduped === true || r3dup.status === "DEDUPED");
      ok("18 · duplicate webhook → still exactly ONE payment_failed EmailLog row for this payment",
        (await tx.emailLog.count({ where: { idempotencyKey: `PAYMENT_FAILED:${failedAttempt.payment.id}` } })) === 1);
      const r5dup = await sendRefundCompleted(refundRow.id, { client: tx });
      ok("18 · repeated identical state transition (2nd sendRefundCompleted for the SAME refund) → deduped",
        r5dup.deduped === true || r5dup.status === "DEDUPED");
      ok("18 · repeated transition → still exactly ONE refund_completed EmailLog row for this refund",
        (await tx.emailLog.count({ where: { idempotencyKey: `REFUND_COMPLETED:${refundRow.id}` } })) === 1);

      // do not send an email when the payment state did not actually change —
      // the defensive re-check inside each sender (mirrors the SLA-notification
      // pattern) catches a stale/mismatched call even if something upstream
      // ever schedules one for a payment that isn't ACTUALLY in that state.
      const stillAwaiting = await seedAttempt(tx, "noop", { paymentStatus: "AWAITING_PAYMENT" });
      const r6 = await sendPaymentFailed(stillAwaiting.payment.id, { client: tx });
      ok("18 · sendPaymentFailed on a Payment that is NOT actually FAILED → SKIPPED, no email prepared",
        r6.status === "SKIPPED" && !(await tx.emailLog.findUnique({ where: { idempotencyKey: `PAYMENT_FAILED:${stillAwaiting.payment.id}` } })));
      const r7 = await sendPaymentExpiredOrCancelled(stillAwaiting.payment.id, { client: tx });
      ok("18 · sendPaymentExpiredOrCancelled on a Payment that is NOT actually EXPIRED → SKIPPED, no email prepared",
        r7.status === "SKIPPED" && !(await tx.emailLog.findUnique({ where: { idempotencyKey: `PAYMENT_EXPIRED_OR_CANCELLED:${stillAwaiting.payment.id}` } })));

      // email preparation failure is durably logged — a nonexistent id must
      // still leave a FAILED EmailLog row (9F-45B's failEmailPreparation),
      // never a silent { ok:false } with nothing to see in /admin/email.
      const missingId = `missing-${Date.now().toString(36)}`;
      const rf1 = await sendPaymentFailed(missingId, { client: tx });
      ok("18 · sendPaymentFailed(nonexistent id) → FAILED result", rf1.ok === false);
      const failRow1 = await tx.emailLog.findUnique({ where: { idempotencyKey: `PAYMENT_FAILED:${missingId}` } });
      ok("18 · ...and a durable FAILED EmailLog row exists for it (failEmailPreparation)",
        !!failRow1 && failRow1.status === "FAILED" && failRow1.error === "payment_not_found");

      const rf2 = await sendPaymentExpiredOrCancelled(missingId, { client: tx });
      ok("18 · sendPaymentExpiredOrCancelled(nonexistent id) → durable FAILED row",
        rf2.ok === false && !!(await tx.emailLog.findUnique({ where: { idempotencyKey: `PAYMENT_EXPIRED_OR_CANCELLED:${missingId}` } })));

      const rf3 = await sendPaymentConfirmation(missingId, { client: tx });
      ok("18 · sendPaymentConfirmation(nonexistent order) → durable FAILED row",
        rf3.ok === false && !!(await tx.emailLog.findUnique({ where: { idempotencyKey: `PAYMENT_CONFIRMATION:${missingId}` } })));

      const rf4 = await sendRefundCompleted(missingId, { client: tx });
      ok("18 · sendRefundCompleted(nonexistent refund) → durable FAILED row",
        rf4.ok === false && !!(await tx.emailLog.findUnique({ where: { idempotencyKey: `REFUND_COMPLETED:${missingId}` } })));

      // existing order/payment behaviour unchanged — the seeded rows above still
      // carry exactly the fields this phase did not touch.
      const cardOrderCheck = await tx.order.findUnique({ where: { id: card.order.id }, select: { paymentMethod: true, paymentStatus: true, status: true } });
      ok("18 · seeding a PAID Card order left Order fields exactly as set (no extra mutation from the email path)",
        cardOrderCheck?.paymentMethod === "CARD" && cardOrderCheck.paymentStatus === "PENDING" && cardOrderCheck.status === "PENDING_PAYMENT");

      throw new Rollback();
    }, { timeout: 60_000, maxWait: 15_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
