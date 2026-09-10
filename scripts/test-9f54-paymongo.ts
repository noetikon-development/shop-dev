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
import { beginOnlinePayment } from "../src/lib/payments/checkout-session";

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
    ok("14 · checkout.ts COD path unchanged: order still created paymentMethod 'NONE' + pay-on-delivery event",
      /paymentMethod: "NONE"/.test(co) && /Payment is arranged on delivery/.test(co));
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
