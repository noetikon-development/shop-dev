/**
 * Automated reconciliation scheduling/alerting — tests for
 * src/lib/marketplace/reconciliation-job.ts, the alert dedup contract in
 * src/lib/email/notifications.ts (sendReconciliationAlertOps), and the
 * CRON_SECRET auth on src/app/api/cron/reconciliation/route.ts.
 *
 * DB tests build rows inside ONE prisma.$transaction and roll back — same
 * pattern as scripts/test-9f43b.ts. The one exception, by design, is the
 * final CRON AUTH case (D4: a valid Bearer token must actually invoke the
 * real job): that calls the route's real GET handler against the real
 * `prisma` singleton, exactly as Vercel Cron would. Its only write is the ONE
 * AdminAuditLog row the task explicitly sanctions as an acceptable
 * Production write (a log record, not business data) — isolation checks
 * below account for that single +1 row rather than pretending it didn't
 * happen.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-reconciliation-job.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient, type Prisma } from "@prisma/client";
import { runReconciliationJob } from "../src/lib/marketplace/reconciliation-job";
import {
  sendReconciliationAlertOps,
  sendReconciliationFailureAlertOps,
  sanitizeReconciliationError,
} from "../src/lib/email/notifications";
import { renderReconciliationFailureAlertOps } from "../src/lib/email/templates/ops-notifications";
import { GET as cronGet } from "../src/app/api/cron/reconciliation/route";

// This whole file dispatches email through the real sender functions — safe
// everywhere in this suite (not just the new block below) because
// getEmailConfig().configured is false under this exact invocation
// (`--env-file=.env --conditions=react-server`, confirmed read-only before
// writing these tests): no EMAIL_HOST/EMAIL_USER/EMAIL_PASSWORD are set in
// .env, so every dispatchEmail() call here resolves to EmailLog status
// SKIPPED, never a real SMTP attempt.

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

// subtotal/grandTotal are 0 deliberately: this order has NO SellerOrder /
// OrderItem (it exists only as a Payment-reconciliation fixture), and the
// marketplace cross-seller aggregation rules (I/L) compare Order money
// fields against the SUM over its SellerOrders — which is 0 for an order
// with none. Keeping Order money fields at 0 avoids spuriously tripping
// those unrelated rules while testing the Payments-only rules below.
async function seedOrder(tx: Tx, suffix: string) {
  return tx.order.create({
    data: {
      orderNumber: `AX-TRECJ-${suffix}-${Math.random().toString(36).slice(2, 6)}`,
      email: "buyer@example.test",
      status: "PENDING_PAYMENT",
      paymentMethod: "CARD",
      paymentStatus: "PENDING",
      subtotal: 0,
      grandTotal: 0,
      placedAt: new Date(),
      shippingAddress: JSON.stringify({ firstName: "T", city: "M", country: "PH" }),
    },
    select: { id: true, orderNumber: true },
  });
}

function staticTests() {
  const route = read("src/app/api/cron/reconciliation/route.ts");
  const job = read("src/lib/marketplace/reconciliation-job.ts");
  const vercelJson = read("vercel.json");
  const cliPayments = read("scripts/reconcile-payments.ts");
  const cliMarketplace = read("scripts/reconcile-marketplace.ts");
  const sendJson = read("src/lib/email/send.ts");

  ok("route · GET fails closed with no CRON_SECRET (503)", /if \(!secret\)[\s\S]{0,80}status: 503/.test(route));
  ok("route · requires Authorization: Bearer <CRON_SECRET>", /Authorization/.test(route) && /Bearer \$\{secret\}/.test(route));
  ok("route · unauthorized → 401", /status: 401/.test(route));
  ok("route · POST → 405", /export async function POST[\s\S]{0,120}status: 405/.test(route));
  ok("route · calls runReconciliationJob", /runReconciliationJob\(\)/.test(route));
  ok("route · logs failures with console.error", /console\.error\("\[cron\] reconciliation failed"/.test(route));
  ok(
    "route · catch block sends a failure alert before returning 500 (error still logged, not swallowed)",
    /catch \(err\)[\s\S]{0,60}console\.error\("\[cron\] reconciliation failed", err\)[\s\S]{0,300}sendReconciliationFailureAlertOps\([\s\S]{0,300}status: 500/.test(
      route,
    ),
  );
  ok("route · imports sendReconciliationFailureAlertOps from notifications.ts", /import \{ sendReconciliationFailureAlertOps \} from "@\/lib\/email\/notifications"/.test(route));

  ok(
    "send.ts · EmailType includes reconciliation_failure_alert_ops",
    /"reconciliation_alert_ops"\s*\n\s*\|\s*"reconciliation_failure_alert_ops"/.test(sendJson),
  );

  ok("vercel.json · seller-order-sla cron unchanged (0 9 * * *)", /"path": "\/api\/cron\/seller-order-sla"[\s\S]{0,40}"schedule": "0 9 \* \* \*"/.test(vercelJson));
  ok("vercel.json · reconciliation cron added at 09:30 UTC", /"path": "\/api\/cron\/reconciliation"[\s\S]{0,40}"schedule": "30 9 \* \* \*"/.test(vercelJson));
  ok("vercel.json · exactly two cron entries", (vercelJson.match(/"path":/g) ?? []).length === 2);

  // Precise on purpose: the job's OWN doc comment mentions "reconcile:9e3d" in
  // prose (explaining what it deliberately excludes) — a bare substring check
  // would false-positive on that explanation. Check for an actual import/call
  // instead, exactly the same lesson as the 9F-43B "unconfirm" false positive.
  ok(
    "job · runs payments + marketplace core, NOT reconcile:9e3d",
    /runPaymentsReconciliation/.test(job) &&
      /runMarketplaceReconciliation/.test(job) &&
      !/from ["'].*9e3d.*["']|reconcile9e3d\(|require\([^)]*9e3d/i.test(job),
  );
  ok("job · FAIL if any fail>0, else WARN if any warn>0, else PASS", /fail > 0[\s\S]{0,40}"FAIL"[\s\S]{0,60}warn > 0[\s\S]{0,40}"WARN"/.test(job));
  ok("job · alert only sent when status !== PASS", /if \(status !== "PASS"\)/.test(job));
  ok("job · writes exactly one AdminAuditLog per run via writeAudit", /writeAudit\(/.test(job) && (job.match(/writeAudit\(/g) ?? []).length === 1);

  ok("CLI · reconcile:payments still calls runPaymentsReconciliation", /runPaymentsReconciliation\(prisma\)/.test(cliPayments));
  ok("CLI · reconcile:payments still exits 1 only on fail>0", /if \(result\.fail > 0\) process\.exitCode = 1/.test(cliPayments));
  ok("CLI · reconcile:marketplace still calls runMarketplaceReconciliation", /runMarketplaceReconciliation\(prisma\)/.test(cliMarketplace));
  ok("CLI · reconcile:marketplace still exits 1 only on fail>0", /if \(result\.fail > 0\) process\.exitCode = 1/.test(cliMarketplace));
}

/** Pure, no-I/O tests for sanitizeReconciliationError + the failure-alert
 *  template — no database, no email dispatch, nothing to roll back. */
function sanitizerAndTemplateTests() {
  const pgUrl = "postgresql://myuser:sup3rSecret@db.example.supabase.co:5432/postgres";
  ok(
    "sanitize · Postgres connection-string credentials are redacted",
    !sanitizeReconciliationError(new Error(`connect failed: ${pgUrl}`)).includes("sup3rSecret") &&
      sanitizeReconciliationError(new Error(`connect failed: ${pgUrl}`)).includes("***:***@"),
  );
  ok(
    "sanitize · a Bearer token is redacted",
    !sanitizeReconciliationError(new Error("upstream said: Authorization: Bearer abc123.def456-XYZ")).includes(
      "abc123.def456-XYZ",
    ),
  );
  ok(
    "sanitize · a PayMongo-style sk_live_/pk_test_ key is redacted",
    !sanitizeReconciliationError(new Error("bad key sk_live_51H8x9nQwErTyUiOp")).includes("51H8x9nQwErTyUiOp") &&
      !sanitizeReconciliationError(new Error("bad key pk_test_9zZ8yYwWvVuUtT")).includes("9zZ8yYwWvVuUtT"),
  );
  ok(
    "sanitize · a secret/token/apikey query-string param is redacted",
    !sanitizeReconciliationError(new Error("GET /x?apikey=abcdef123&other=1 failed")).includes("abcdef123") &&
      !sanitizeReconciliationError(new Error("GET /x?token=zzz999 failed")).includes("zzz999"),
  );
  ok(
    "sanitize · an ordinary error message passes through unredacted (no over-redaction)",
    sanitizeReconciliationError(new Error("connect ECONNREFUSED 127.0.0.1:5432")) ===
      "connect ECONNREFUSED 127.0.0.1:5432",
  );
  ok(
    "sanitize · a long message is truncated with an ellipsis",
    sanitizeReconciliationError(new Error("x".repeat(1000))).length <= 401 &&
      sanitizeReconciliationError(new Error("x".repeat(1000))).endsWith("…"),
  );
  ok(
    "sanitize · a non-Error thrown value (e.g. a string) does not crash and returns a string",
    typeof sanitizeReconciliationError("plain string throw") === "string",
  );
  ok(
    "sanitize · never reads .stack (a stack-only marker never appears in the output)",
    (() => {
      const e = new Error("boom");
      e.stack = "boom\n    at STACK_ONLY_MARKER (file.ts:1:1)";
      return !sanitizeReconciliationError(e).includes("STACK_ONLY_MARKER");
    })(),
  );

  const rendered = renderReconciliationFailureAlertOps({
    brand: "Axiaro",
    siteUrl: "https://axiaro.shop",
    failedAt: new Date("2026-09-23T09:30:00Z"),
    route: "GET /api/cron/reconciliation",
    errorMessage: "connect ECONNREFUSED 127.0.0.1:5432",
  });
  ok("template · subject clearly states the job FAILED to run", /FAILED to run/.test(rendered.subject));
  ok(
    "template · text explicitly distinguishes execution failure from a detected mismatch",
    /job execution failure, not a detected reconciliation mismatch/.test(rendered.text),
  );
  ok("template · text tells the operator to investigate job/database/Vercel logs", /Investigate the job, the database connection, and the Vercel function logs/.test(rendered.text));
  ok("template · includes the (already-sanitized) error message", rendered.text.includes("connect ECONNREFUSED 127.0.0.1:5432"));
  ok("template · html mirrors the same FAILED wording", /did not complete/.test(rendered.html) && /Reconciliation job FAILED to run/.test(rendered.html));
}

async function dbTests() {
  const orderBefore = await prisma.order.count();
  const paymentBefore = await prisma.payment.count();
  const auditBefore = await prisma.adminAuditLog.count();

  try {
    await prisma.$transaction(async (tx) => {
      // ── A — PASS: no drift injected, real committed data is already clean ──
      const auditCountBeforeA = await tx.adminAuditLog.count();
      const a = await runReconciliationJob(tx);
      ok("A · PASS run reports status PASS", a.status === "PASS", JSON.stringify({ p: a.payments.fail, m: a.marketplace.fail }));
      ok("A · a durable AdminAuditLog row was written", (await tx.adminAuditLog.count()) === auditCountBeforeA + 1);
      const auditRowA = await tx.adminAuditLog.findFirst({ where: { action: "reconciliation.run" }, orderBy: { createdAt: "desc" } });
      ok("A · audit row action is reconciliation.run with a PASS summary", !!auditRowA && /PASS/.test(auditRowA.summary ?? ""));
      ok("A · no alert sent for a clean PASS", a.alertSent === false && a.alertDeduped === false);

      // ── B — WARN: a stale AWAITING_PAYMENT Payment (rule 1) ──────────────
      const orderB = await seedOrder(tx, "b");
      await tx.payment.create({
        data: {
          orderId: orderB.id, provider: "paymongo", providerObject: "checkout_session",
          providerId: `ps_trecj_b_${Math.random().toString(36).slice(2, 8)}`,
          status: "AWAITING_PAYMENT", amount: 0, currency: "PHP",
          createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000), // 25h ago
        },
      });
      const b = await runReconciliationJob(tx);
      ok("B · WARN run reports status WARN", b.status === "WARN", JSON.stringify({ p: b.payments, m: b.marketplace.fail }));
      ok("B · payments check recorded the WARN", b.payments.warn > 0);

      // ── C — FAIL: Payment.amount != Order.grandTotal (rule 4) ───────────
      const orderC = await seedOrder(tx, "c");
      await tx.payment.create({
        data: {
          orderId: orderC.id, provider: "paymongo", providerObject: "checkout_session",
          providerId: `ps_trecj_c_${Math.random().toString(36).slice(2, 8)}`,
          status: "PAID", amount: 150000, currency: "PHP",
        },
      });
      // Order must look PAID-consistent for rule 2 not to also fire — set order.paymentStatus to PAID.
      await tx.order.update({ where: { id: orderC.id }, data: { status: "PROCESSING", paymentStatus: "PAID" } });
      const c = await runReconciliationJob(tx);
      ok("C · FAIL run reports status FAIL", c.status === "FAIL", JSON.stringify({ p: c.payments, m: c.marketplace.fail }));
      ok("C · payments check recorded a FAIL (amount mismatch)", c.payments.fail > 0);

      // ── Alert dedup contract — direct calls with distinct fake dateKeys so
      //    each scenario's alert isn't deduped by an EARLIER scenario's alert
      //    in this same test run (the real per-day key is intentionally
      //    coarse — see reconciliation-job.ts's own comment on this).
      const warnKey = "2099-06-01";
      const r1 = await sendReconciliationAlertOps({
        status: "WARN", runAt: new Date(), dateKey: warnKey,
        payments: { pass: 1, warn: 1, fail: 0 }, marketplace: { pass: 1, warn: 0, fail: 0 },
        details: ["[payments] [WARN] test line"], truncatedCount: 0, client: tx,
      });
      ok("D-alert · first WARN alert for a fresh dateKey is not deduped", r1.ok === true && !r1.deduped);
      const emailCountAfterFirst = await tx.emailLog.count({ where: { idempotencyKey: `RECONCILE_ALERT:${warnKey}` } });
      ok("D-alert · exactly one EmailLog row exists for that key", emailCountAfterFirst === 1);
      const r2 = await sendReconciliationAlertOps({
        status: "WARN", runAt: new Date(), dateKey: warnKey,
        payments: { pass: 1, warn: 1, fail: 0 }, marketplace: { pass: 1, warn: 0, fail: 0 },
        details: ["[payments] [WARN] test line"], truncatedCount: 0, client: tx,
      });
      ok("D-alert · a second call with the SAME dateKey is deduped", r2.ok === true && r2.deduped === true);
      ok("D-alert · still exactly one EmailLog row for that key (no duplicate)", (await tx.emailLog.count({ where: { idempotencyKey: `RECONCILE_ALERT:${warnKey}` } })) === 1);

      const failKey = "2099-06-02";
      const r3 = await sendReconciliationAlertOps({
        status: "FAIL", runAt: new Date(), dateKey: failKey,
        payments: { pass: 1, warn: 0, fail: 1 }, marketplace: { pass: 1, warn: 0, fail: 0 },
        details: ["[payments] [FAIL] test line"], truncatedCount: 0, client: tx,
      });
      ok("D-alert · a different day's FAIL alert is its own, independent, non-deduped send", r3.ok === true && !r3.deduped);
      const r4 = await sendReconciliationAlertOps({
        status: "FAIL", runAt: new Date(), dateKey: failKey,
        payments: { pass: 1, warn: 0, fail: 1 }, marketplace: { pass: 1, warn: 0, fail: 0 },
        details: ["[payments] [FAIL] test line"], truncatedCount: 0, client: tx,
      });
      ok("D-alert · repeating the SAME FAIL dateKey is deduped too", r4.ok === true && r4.deduped === true);

      // ── Failure-alert dedup contract — mirrors the D-alert block above
      //    exactly, under the failure alert's OWN idempotency-key prefix
      //    (RECONCILE_FAILURE_ALERT:), so it can be proven independent of the
      //    existing RECONCILE_ALERT: dedup rather than merely assumed.
      const failureKey = "2099-06-03";
      const f1 = await sendReconciliationFailureAlertOps({
        failedAt: new Date(), dateKey: failureKey, route: "GET /api/cron/reconciliation",
        error: new Error("simulated DB timeout"), client: tx,
      });
      ok("E-failure-alert · first failure alert for a fresh dateKey is not deduped", f1.ok === true && !f1.deduped);
      ok(
        "E-failure-alert · exactly one EmailLog row exists under RECONCILE_FAILURE_ALERT:",
        (await tx.emailLog.count({ where: { idempotencyKey: `RECONCILE_FAILURE_ALERT:${failureKey}` } })) === 1,
      );
      const f2 = await sendReconciliationFailureAlertOps({
        failedAt: new Date(), dateKey: failureKey, route: "GET /api/cron/reconciliation",
        error: new Error("simulated DB timeout"), client: tx,
      });
      ok("E-failure-alert · a second call with the SAME dateKey is deduped", f2.ok === true && f2.deduped === true);
      ok(
        "E-failure-alert · still exactly one EmailLog row for that key (no duplicate)",
        (await tx.emailLog.count({ where: { idempotencyKey: `RECONCILE_FAILURE_ALERT:${failureKey}` } })) === 1,
      );

      // ── Independence from the existing WARN/FAIL alert dedup — the SAME
      //    calendar dateKey must not collide across the two alert kinds; each
      //    gets its own EmailLog row under its own key prefix.
      const sharedDateKey = "2099-06-04";
      const warnAlert = await sendReconciliationAlertOps({
        status: "WARN", runAt: new Date(), dateKey: sharedDateKey,
        payments: { pass: 1, warn: 1, fail: 0 }, marketplace: { pass: 1, warn: 0, fail: 0 },
        details: ["[payments] [WARN] test line"], truncatedCount: 0, client: tx,
      });
      const failureAlert = await sendReconciliationFailureAlertOps({
        failedAt: new Date(), dateKey: sharedDateKey, route: "GET /api/cron/reconciliation",
        error: new Error("simulated crash"), client: tx,
      });
      ok(
        "E-failure-alert · a WARN/FAIL alert and a failure alert on the SAME calendar day do not collide/dedupe each other",
        warnAlert.ok === true && !warnAlert.deduped && failureAlert.ok === true && !failureAlert.deduped,
      );
      ok(
        "E-failure-alert · both EmailLog rows exist independently (distinct idempotency keys)",
        (await tx.emailLog.count({ where: { idempotencyKey: `RECONCILE_ALERT:${sharedDateKey}` } })) === 1 &&
          (await tx.emailLog.count({ where: { idempotencyKey: `RECONCILE_FAILURE_ALERT:${sharedDateKey}` } })) === 1,
      );

      throw new Rollback();
    }, { timeout: 120_000, maxWait: 15_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("isolation · Order count unchanged after rollback", (await prisma.order.count()) === orderBefore);
  ok("isolation · Payment count unchanged after rollback", (await prisma.payment.count()) === paymentBefore);
  ok("isolation · AdminAuditLog count unchanged after rollback (pre-D4 baseline)", (await prisma.adminAuditLog.count()) === auditBefore);
}

async function cronAuthTests() {
  const req = (headers: Record<string, string> = {}) =>
    new Request("https://axiaro.shop/api/cron/reconciliation", { method: "GET", headers });

  const savedSecret = process.env.CRON_SECRET;
  try {
    delete process.env.CRON_SECRET;
    const r1 = await cronGet(req());
    ok("D1 · missing CRON_SECRET → 503, job not configured", r1.status === 503);

    process.env.CRON_SECRET = "test-secret-value";
    const r2 = await cronGet(req());
    ok("D2 · CRON_SECRET set, no Authorization header → 401", r2.status === 401);

    const r3 = await cronGet(req({ Authorization: "Bearer wrong-value" }));
    ok("D3 · CRON_SECRET set, wrong bearer token → 401", r3.status === 401);

    // D4 — valid bearer token → the route actually invokes the real job
    // against the real `prisma` singleton (the route has no DI seam for a
    // test transaction). This is the ONE sanctioned real write in this test:
    // exactly one new AdminAuditLog row (a log record, not business data).
    const auditBeforeD4 = await prisma.adminAuditLog.count();
    const r4 = await cronGet(req({ Authorization: "Bearer test-secret-value" }));
    const body = (await r4.json()) as { ok: boolean; status?: string; auditLogId?: string | null };
    ok("D4 · valid bearer token → 200 and the job actually ran", r4.status === 200 && body.ok === true && ["PASS", "WARN", "FAIL"].includes(body.status ?? ""));
    ok("D4 · exactly one new (real) AdminAuditLog row was written", (await prisma.adminAuditLog.count()) === auditBeforeD4 + 1);
  } finally {
    if (savedSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = savedSecret;
  }
}

async function main() {
  console.log("\nAutomated reconciliation scheduling/alerting — tests\n");
  console.log("Static wiring");
  staticTests();
  console.log("\nFailure-alert sanitizer + template (pure, no I/O)");
  sanitizerAndTemplateTests();
  console.log("\nDatabase (rolled back, except the one sanctioned D4 write below)");
  await dbTests();
  console.log("\nCron auth (D4 performs one real, sanctioned AdminAuditLog write)");
  await cronAuthTests();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
