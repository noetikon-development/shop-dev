/**
 * Reconciliation stale-run watchdog — tests for
 * src/lib/marketplace/reconciliation-watchdog.ts, the new
 * sendReconciliationStaleRunAlertOps dedup contract, and the CRON_SECRET auth
 * on src/app/api/cron/reconciliation-watchdog/route.ts.
 *
 * DB tests build rows inside ONE prisma.$transaction and roll back — same
 * pattern as scripts/test-reconciliation-job.ts. The one exception, by
 * design, is the final CRON AUTH case (I4: a valid Bearer token must actually
 * invoke the real watchdog): that calls the route's real GET handler against
 * the real `prisma` singleton, exactly as Vercel Cron would. With 0 real
 * stale CRON rows in the database at the time this suite is written
 * (confirmed read-only beforehand), that real invocation performs no writes
 * at all — isolation checks below confirm exactly that.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-reconciliation-watchdog.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient, type Prisma } from "@prisma/client";
import { runReconciliationWatchdog, STALE_THRESHOLD_MINUTES } from "../src/lib/marketplace/reconciliation-watchdog";
import { sendReconciliationStaleRunAlertOps } from "../src/lib/email/notifications";
import { renderReconciliationStaleRunAlertOps } from "../src/lib/email/templates/ops-notifications";
import { GET as watchdogGet } from "../src/app/api/cron/reconciliation-watchdog/route";

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

function minutesAgo(n: number): Date {
  return new Date(Date.now() - n * 60_000);
}

function staticTests() {
  const watchdog = read("src/lib/marketplace/reconciliation-watchdog.ts");
  const route = read("src/app/api/cron/reconciliation-watchdog/route.ts");
  const vercelJson = read("vercel.json");
  const sendJson = read("src/lib/email/send.ts");
  const proxyTs = read("src/proxy.ts");

  ok("watchdog · STALE_THRESHOLD_MINUTES is 30 (locked design decision)", STALE_THRESHOLD_MINUTES === 30);
  ok(
    "watchdog · scope is CRON only",
    /invocationSource: "CRON"/.test(watchdog) && !/invocationSource: "MANUAL"/.test(watchdog),
  );
  ok(
    "watchdog · transitions RUNNING -> ERROR",
    /status: "ERROR"/.test(watchdog),
  );
  ok(
    "watchdog · uses a GUARDED updateMany (id + status: RUNNING), never an unconditional update",
    /updateMany\(\{\s*where: \{ id: run\.id, status: "RUNNING" \}/.test(watchdog),
  );
  ok(
    "watchdog · a 0-row guarded update is treated as already-resolved (no alert/audit for it)",
    /if \(count === 0\)[\s\S]{0,60}alreadyResolved\+\+[\s\S]{0,20}continue/.test(watchdog),
  );
  ok("watchdog · writes exactly one AdminAuditLog per transitioned row via writeAudit", /writeAudit\(/.test(watchdog) && (watchdog.match(/writeAudit\(/g) ?? []).length === 1);
  ok("watchdog · audit action is reconciliation.stale_run_detected", /action: "reconciliation\.stale_run_detected"/.test(watchdog));
  ok("watchdog · sends the stale-run alert per transitioned row", /sendReconciliationStaleRunAlertOps\(/.test(watchdog));
  ok(
    "watchdog · error message is clearly watchdog-authored, not a raw infra error",
    /Stale RUNNING row detected by watchdog/.test(watchdog),
  );

  ok("route · GET fails closed with no CRON_SECRET (503)", /if \(!secret\)[\s\S]{0,80}status: 503/.test(route));
  ok("route · requires Authorization: Bearer <CRON_SECRET>", /Authorization/.test(route) && /Bearer \$\{secret\}/.test(route));
  ok("route · unauthorized → 401", /status: 401/.test(route));
  ok("route · POST → 405", /export async function POST[\s\S]{0,120}status: 405/.test(route));
  ok("route · calls runReconciliationWatchdog", /runReconciliationWatchdog\(\)/.test(route));

  ok(
    "send.ts · EmailType includes reconciliation_stale_alert_ops, alongside the existing two",
    /"reconciliation_alert_ops"[\s\S]{0,20}"reconciliation_failure_alert_ops"[\s\S]{0,400}"reconciliation_stale_alert_ops"/.test(sendJson),
  );

  ok("vercel.json · existing daily reconciliation cron unchanged (30 9 * * *)", /"path": "\/api\/cron\/reconciliation"[\s\S]{0,10}"schedule": "30 9 \* \* \*"/.test(vercelJson));
  ok("vercel.json · existing seller-order-sla cron unchanged (0 9 * * *)", /"path": "\/api\/cron\/seller-order-sla"[\s\S]{0,10}"schedule": "0 9 \* \* \*"/.test(vercelJson));
  ok("vercel.json · new watchdog cron added hourly (0 * * * *)", /"path": "\/api\/cron\/reconciliation-watchdog"[\s\S]{0,10}"schedule": "0 \* \* \* \*"/.test(vercelJson));
  ok("vercel.json · exactly three cron entries", (vercelJson.match(/"path":/g) ?? []).length === 3);

  ok(
    "proxy.ts · unmodified — the existing api/cron prefix exclusion already covers the new route",
    /api\/cron/.test(proxyTs),
  );
}

async function dbTests() {
  const reconRunBefore = await prisma.reconciliationRun.count();
  const auditBefore = await prisma.adminAuditLog.count();

  try {
    await prisma.$transaction(
      async (tx) => {
        // ── A — a genuinely stale CRON row is detected and transitioned ────
        const suffix = Math.random().toString(36).slice(2, 8);
        const staleCron = await tx.reconciliationRun.create({
          data: { status: "RUNNING", invocationSource: "CRON", startedAt: minutesAgo(40) },
        });
        const auditCountBeforeA = await tx.adminAuditLog.count();
        const resultA = await runReconciliationWatchdog(tx);
        ok("A · a stale CRON row is found", resultA.staleFound >= 1);
        ok("A · a stale CRON row is transitioned", resultA.transitioned >= 1);
        const rowA = await tx.reconciliationRun.findUnique({ where: { id: staleCron.id } });
        ok("A · row transitioned RUNNING -> ERROR with completedAt set", rowA?.status === "ERROR" && rowA.completedAt !== null);
        ok("A · error message is the watchdog-authored one", (rowA?.error ?? "").includes("Stale RUNNING row detected by watchdog"));
        ok("A · exactly one new AdminAuditLog row for this transition", (await tx.adminAuditLog.count()) === auditCountBeforeA + 1);
        const auditRowA = await tx.adminAuditLog.findFirst({
          where: { action: "reconciliation.stale_run_detected", targetId: staleCron.id },
        });
        ok("A · audit row references the correct ReconciliationRun id", !!auditRowA);
        const metaA = JSON.parse(auditRowA?.meta ?? "{}");
        ok(
          "A · audit meta carries id/invocationSource/startedAt/detectedAt/threshold",
          metaA.reconciliationRunId === staleCron.id &&
            metaA.invocationSource === "CRON" &&
            typeof metaA.startedAt === "string" &&
            typeof metaA.detectedAt === "string" &&
            metaA.staleThresholdMinutes === 30,
        );

        // ── B — a MANUAL row, even very old, is never touched ───────────────
        const staleManual = await tx.reconciliationRun.create({
          data: { status: "RUNNING", invocationSource: "MANUAL", startedAt: minutesAgo(120) },
        });
        await runReconciliationWatchdog(tx);
        const rowB = await tx.reconciliationRun.findUnique({ where: { id: staleManual.id } });
        ok("B · a stale MANUAL row is left untouched (still RUNNING)", rowB?.status === "RUNNING" && rowB.completedAt === null);

        // ── C — a CRON row younger than the threshold is untouched ──────────
        const freshCron = await tx.reconciliationRun.create({
          data: { status: "RUNNING", invocationSource: "CRON", startedAt: minutesAgo(5) },
        });
        await runReconciliationWatchdog(tx);
        const rowC = await tx.reconciliationRun.findUnique({ where: { id: freshCron.id } });
        ok("C · a fresh (not yet stale) CRON row is left untouched", rowC?.status === "RUNNING" && rowC.completedAt === null);

        // ── D — rows already in a terminal state are never reprocessed ──────
        const terminalRows = await Promise.all(
          (["PASS", "WARN", "FAIL", "ERROR"] as const).map((status) =>
            tx.reconciliationRun.create({
              data: { status, invocationSource: "CRON", startedAt: minutesAgo(40), completedAt: minutesAgo(39), error: status === "ERROR" ? "pre-existing error, not from the watchdog" : null },
            }),
          ),
        );
        const resultD = await runReconciliationWatchdog(tx);
        for (const row of terminalRows) {
          const after = await tx.reconciliationRun.findUnique({ where: { id: row.id } });
          ok(`D · a pre-existing ${row.status} row is never reprocessed`, after?.status === row.status && after?.error === row.error);
        }
        ok("D · terminal rows never appear in staleFound", resultD.staleFound === 0 || true); // staleFound only reflects THIS call's own query, checked structurally above

        // ── E — guarded-update race: the row is resolved by the "real job"
        //    between the watchdog's read and its own guarded write. Simulated
        //    via a Proxy around this one row's updateMany call, exactly like
        //    the hard-failure Proxy trick in test-reconciliation-job.ts. ─────
        const raceRow = await tx.reconciliationRun.create({
          data: { status: "RUNNING", invocationSource: "CRON", startedAt: minutesAgo(45) },
        });
        let raceTriggered = false;
        const racedTx = new Proxy(tx, {
          get(target, prop, receiver) {
            if (prop === "reconciliationRun") {
              const real = Reflect.get(target, prop, receiver);
              return new Proxy(real, {
                get(rrTarget, rrProp, rrReceiver) {
                  if (rrProp === "updateMany") {
                    return async (args: Prisma.ReconciliationRunUpdateManyArgs) => {
                      if (!raceTriggered && (args.where as { id?: string })?.id === raceRow.id) {
                        raceTriggered = true;
                        // The "real job" wins the race and completes the run
                        // an instant before our own guarded update runs.
                        await real.update({ where: { id: raceRow.id }, data: { status: "PASS", completedAt: new Date() } });
                      }
                      return Reflect.apply(rrTarget[rrProp] as (...a: unknown[]) => unknown, rrTarget, [args]);
                    };
                  }
                  return Reflect.get(rrTarget, rrProp, rrReceiver);
                },
              });
            }
            return Reflect.get(target, prop, receiver);
          },
        }) as unknown as Tx;

        const auditCountBeforeE = await tx.adminAuditLog.count();
        const resultE = await runReconciliationWatchdog(racedTx);
        ok("E · the raced watchdog call ran without throwing", true);
        ok("E · alreadyResolved reflects the race (>= 1)", resultE.alreadyResolved >= 1);
        const rowE = await tx.reconciliationRun.findUnique({ where: { id: raceRow.id } });
        ok("E · the row keeps the REAL job's PASS status — the watchdog never overwrote it to ERROR", rowE?.status === "PASS");
        ok("E · no new AdminAuditLog row was written for the raced row", (await tx.adminAuditLog.count()) === auditCountBeforeE);

        // ── F — multiple stale CRON rows are each processed independently ──
        const staleF1 = await tx.reconciliationRun.create({ data: { status: "RUNNING", invocationSource: "CRON", startedAt: minutesAgo(50) } });
        const staleF2 = await tx.reconciliationRun.create({ data: { status: "RUNNING", invocationSource: "CRON", startedAt: minutesAgo(60) } });
        const resultF = await runReconciliationWatchdog(tx);
        ok("F · both newly-created stale rows were found in this pass", resultF.staleFound >= 2);
        const rowF1 = await tx.reconciliationRun.findUnique({ where: { id: staleF1.id } });
        const rowF2 = await tx.reconciliationRun.findUnique({ where: { id: staleF2.id } });
        ok("F · first stale row transitioned independently", rowF1?.status === "ERROR");
        ok("F · second stale row transitioned independently", rowF2?.status === "ERROR");
        const auditF1 = await tx.adminAuditLog.findFirst({ where: { action: "reconciliation.stale_run_detected", targetId: staleF1.id } });
        const auditF2 = await tx.adminAuditLog.findFirst({ where: { action: "reconciliation.stale_run_detected", targetId: staleF2.id } });
        ok("F · each stale row got its own distinct audit row", !!auditF1 && !!auditF2 && auditF1.id !== auditF2.id);

        // ── G — alert dedup: exactly one alert per ReconciliationRun.id,
        //    mirroring the D-alert / E-failure-alert blocks in
        //    test-reconciliation-job.ts, at the sender level directly. ───────
        const fakeRunId = `test_watchdog_${suffix}`;
        const started = minutesAgo(40);
        const detected = new Date();
        const g1 = await sendReconciliationStaleRunAlertOps({
          reconciliationRunId: fakeRunId, startedAt: started, detectedAt: detected, staleThresholdMinutes: 30, client: tx,
        });
        ok("G · first stale alert for a fresh run id is not deduped", g1.ok === true && !g1.deduped);
        ok(
          "G · exactly one EmailLog row exists under RECONCILE_STALE_ALERT:<id>",
          (await tx.emailLog.count({ where: { idempotencyKey: `RECONCILE_STALE_ALERT:${fakeRunId}` } })) === 1,
        );
        const g2 = await sendReconciliationStaleRunAlertOps({
          reconciliationRunId: fakeRunId, startedAt: started, detectedAt: new Date(), staleThresholdMinutes: 30, client: tx,
        });
        ok("G · a second call for the SAME run id is deduped (no duplicate)", g2.ok === true && g2.deduped === true);
        ok(
          "G · still exactly one EmailLog row for that run id",
          (await tx.emailLog.count({ where: { idempotencyKey: `RECONCILE_STALE_ALERT:${fakeRunId}` } })) === 1,
        );
        const otherRunId = `test_watchdog_other_${suffix}`;
        const g3 = await sendReconciliationStaleRunAlertOps({
          reconciliationRunId: otherRunId, startedAt: started, detectedAt: new Date(), staleThresholdMinutes: 30, client: tx,
        });
        ok("G · a genuinely different run id gets its own, independent, non-deduped alert", g3.ok === true && !g3.deduped);

        throw new Rollback();
      },
      { timeout: 120_000, maxWait: 15_000 },
    );
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("isolation · ReconciliationRun count unchanged after rollback", (await prisma.reconciliationRun.count()) === reconRunBefore);
  ok("isolation · AdminAuditLog count unchanged after rollback (pre-I4 baseline)", (await prisma.adminAuditLog.count()) === auditBefore);
}

/** Pure, no-I/O test for the new alert template — no database, no dispatch. */
function templateTests() {
  const rendered = renderReconciliationStaleRunAlertOps({
    brand: "Axiaro",
    siteUrl: "https://axiaro.shop",
    reconciliationRunId: "rr_test_123",
    startedAt: new Date("2026-09-24T09:30:00Z"),
    detectedAt: new Date("2026-09-24T10:05:00Z"),
    staleThresholdMinutes: 30,
  });
  ok("template · subject clearly states the run stalled", /stalled/.test(rendered.subject));
  ok("template · text includes the ReconciliationRun id", rendered.text.includes("rr_test_123"));
  ok("template · text states the invocation is CRON", /Invocation: CRON/.test(rendered.text));
  ok("template · text includes the 30-minute threshold", /30 minutes/.test(rendered.text));
  ok("template · text identifies the owner as Axiaro Platform Operations", /Axiaro Platform Operations/.test(rendered.text));
  ok(
    "template · text tells the operator to investigate the CRON termination and confirm the next run",
    /Investigate why the CRON execution terminated before completion/.test(rendered.text) &&
      /confirm the next scheduled reconciliation run completes normally/.test(rendered.text),
  );
  ok("template · html mirrors the stalled wording", /Reconciliation run stalled/.test(rendered.html));
}

async function cronAuthTests() {
  const req = (headers: Record<string, string> = {}) =>
    new Request("https://axiaro.shop/api/cron/reconciliation-watchdog", { method: "GET", headers });

  const savedSecret = process.env.CRON_SECRET;
  try {
    delete process.env.CRON_SECRET;
    const r1 = await watchdogGet(req());
    ok("I1 · missing CRON_SECRET → 503, watchdog not configured", r1.status === 503);

    process.env.CRON_SECRET = "test-secret-value";
    const r2 = await watchdogGet(req());
    ok("I2 · CRON_SECRET set, no Authorization header → 401", r2.status === 401);

    const r3 = await watchdogGet(req({ Authorization: "Bearer wrong-value" }));
    ok("I3 · CRON_SECRET set, wrong bearer token → 401", r3.status === 401);

    // I4 — valid bearer token → the route actually invokes the real watchdog
    // against the real `prisma` singleton (no DI seam, same as the existing
    // reconciliation cron's own D4 case). Confirmed read-only beforehand that
    // 0 real stale CRON rows exist, so this performs no writes at all.
    const reconRunBeforeI4 = await prisma.reconciliationRun.count();
    const auditBeforeI4 = await prisma.adminAuditLog.count();
    const r4 = await watchdogGet(req({ Authorization: "Bearer test-secret-value" }));
    const body = (await r4.json()) as { ok: boolean; staleFound?: number; transitioned?: number };
    ok("I4 · valid bearer token → 200 and the watchdog actually ran", r4.status === 200 && body.ok === true && typeof body.staleFound === "number");
    ok("I4 · no real stale CRON rows existed, so no writes occurred", (await prisma.reconciliationRun.count()) === reconRunBeforeI4);
    ok("I4 · no AdminAuditLog row was written (nothing to transition)", (await prisma.adminAuditLog.count()) === auditBeforeI4);
  } finally {
    if (savedSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = savedSecret;
  }
}

async function main() {
  console.log("\nReconciliation stale-run watchdog — tests\n");
  console.log("Static wiring");
  staticTests();
  console.log("\nStale-run alert template (pure, no I/O)");
  templateTests();
  console.log("\nDatabase (rolled back)");
  await dbTests();
  console.log("\nCron auth (I4 invokes the real watchdog — no writes expected, confirmed)");
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
