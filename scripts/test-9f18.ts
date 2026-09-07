/**
 * PHASE 9F-18 — Admin/Ops email delivery-failure alerting.
 *
 * `sendEmailFailureAlertOps(failedIdempotencyKey)` raises exactly ONE Ops signal
 * for a FAILED / SKIPPED transactional email: a durable `email.delivery_failed`
 * AdminAuditLog row (written FIRST, present even if SMTP is down) plus one
 * `email_failure_alert_ops` EmailLog keyed `EMAIL_FAILURE_ALERT:<failedLogId>`.
 * The alert flows through the same `renderAndDispatch`; recursion is impossible
 * because that type is always skipped by `maybeScheduleEmailFailureAlert`.
 *
 * Class E: seller notifications that resolved no recipient now write a FAILED
 * EmailLog row (`error: "no_recipient"`) instead of returning silently.
 *
 * DB scenarios run inside one prisma.$transaction and roll back; the alert
 * sender + writeAudit both take the tx client. The local env has no EMAIL_*
 * creds, so a "sent" alert re-records SKIPPED — the assertion is that the alert
 * ROW + audit ROW are created with the right shape, which in a configured
 * runtime would deliver.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f18.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { sendEmailFailureAlertOps, retryEmailByLog, sendSellerOrderReceived } from "../src/lib/email/notifications";

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

const HISTORICAL_SKIPPED_ID = "cmtrjke8f0000kguo0dnbvqnj";

const SHIP_ADDR = {
  firstName: "Del", lastName: "Recipient", phone: "+639170000000", line1: "42 Sample Rd",
  barangay: "Poblacion", city: "Makati", province: "NCR", postalCode: "1210", country: "PH",
};

async function seedFailedLog(
  tx: Tx,
  over: Partial<{ type: string; status: string; error: string | null; recipient: string; orderId: string | null; key: string }> = {},
) {
  const key = over.key ?? `T9F18:${Math.random().toString(36).slice(2)}`;
  const row = await tx.emailLog.create({
    data: {
      type: over.type ?? "order_confirmation",
      recipient: over.recipient ?? "jane.customer@example.com",
      subject: "Your Axiaro order is confirmed",
      idempotencyKey: key,
      status: over.status ?? "FAILED",
      provider: "smtp",
      error: over.error === undefined ? "smtp 550 mailbox unavailable" : over.error,
      attempts: over.status === "SKIPPED" ? 0 : 1,
      orderId: over.orderId ?? null,
    },
    select: { id: true, idempotencyKey: true },
  });
  return row;
}

function alertRow(tx: Tx, failedLogId: string) {
  return tx.emailLog.findUnique({ where: { idempotencyKey: `EMAIL_FAILURE_ALERT:${failedLogId}` } });
}
function auditRows(tx: Tx, failedLogId: string) {
  return tx.adminAuditLog.findMany({ where: { action: "email.delivery_failed", targetId: failedLogId } });
}

// ---------------------------------------------------------------------------

function staticTests() {
  console.log("\n── static wiring ──");
  const send = read("src/lib/email/send.ts");
  const notif = read("src/lib/email/notifications.ts");
  const ops = read("src/lib/email/templates/ops-notifications.ts");
  const audit = read("src/lib/admin/audit.ts");
  const logsRead = read("src/lib/admin/email-logs.ts");
  const table = read("src/components/admin/email/email-logs-table.tsx");

  ok("send.ts · EmailType adds email_failure_alert_ops", /\|\s*"email_failure_alert_ops"/.test(send));
  ok("send.ts · recordEmailFailure takes an optional subject", /recordEmailFailure\(input: \{[\s\S]{0,400}subject\?: string/.test(send));

  ok("renderAndDispatch · alerts on the dispatch result", /const result = await dispatchEmail\(\{ \.\.\.meta, \.\.\.msg \}\);\s*\n\s*maybeScheduleEmailFailureAlert\(meta, result\);/.test(notif));
  ok("renderAndDispatch · alerts on a render failure too", /const failed = await recordEmailFailure\(\{[\s\S]{0,400}\}\);\s*\n\s*maybeScheduleEmailFailureAlert\(meta, failed\);/.test(notif));

  const guard = notif.slice(notif.indexOf("function maybeScheduleEmailFailureAlert"), notif.indexOf("function maybeScheduleEmailFailureAlert") + 600);
  ok("guard · only FAILED / SKIPPED", /result\.status !== "FAILED" && result\.status !== "SKIPPED"\) return;/.test(guard));
  ok("guard · never for the alert type itself (recursion)", /meta\.type === "email_failure_alert_ops"\) return;/.test(guard));
  ok("guard · never on an admin retry", /meta\.retry\) return;/.test(guard));
  ok("guard · never from a test transaction", /meta\.client\) return;/.test(guard));

  ok("sender · idempotency key EMAIL_FAILURE_ALERT:<failedLogId>", /const alertKey = `EMAIL_FAILURE_ALERT:\$\{row\.id\}`;/.test(notif));
  ok("sender · at-most-one guard (prior alert row → DEDUPED)", /priorAlert\) return \{ ok: true, deduped: true, status: "DEDUPED" \};/.test(notif));
  ok("sender · recursion guard on the failed row's own type", /row\.type === "email_failure_alert_ops"\) return \{ ok: true, deduped: true, status: "DEDUPED" \};/.test(notif));
  ok("sender · email_mode_log is not a failure", /row\.error === "email_mode_log"\) return \{ ok: true, skipped: true, status: "SKIPPED" \};/.test(notif));
  ok("sender · smtp_not_configured only alerts in production", /row\.status === "SKIPPED" && row\.error === "smtp_not_configured" && !isProductionRuntime\(\)/.test(notif));
  ok("sender · audit written BEFORE the email attempt", notif.indexOf('action: "email.delivery_failed"') < notif.indexOf('type: "email_failure_alert_ops"'));
  ok("sender · audit is the non-tx-safe writeAudit, threaded with opts.client", /await writeAudit\(\s*\{[\s\S]{0,500}\},\s*opts\.client,\s*\);/.test(notif));
  ok("sender · recipient via getSupportInboxEmail()", /await getStoreBrand\(\), getSiteUrl\(\), await getSupportInboxEmail\(\)\];\s*\n\s*return renderAndDispatch\(\s*\{\s*type: "email_failure_alert_ops"/.test(notif));
  ok("sender · from = SECURITY_FROM (no-reply)", /type: "email_failure_alert_ops",\s*\n\s*to,\s*\n\s*from: SECURITY_FROM,/.test(notif));

  ok("retry · email_failure_alert_ops is explicitly not_retryable", /case "email_failure_alert_ops":\s*\n\s*return \{ ok: false, status: "FAILED", error: "not_retryable" \};/.test(notif));

  ok("Class E · failNoRecipient writes a FAILED row via recordEmailFailure", /async function failNoRecipient\([\s\S]{0,600}recordEmailFailure\(\{[\s\S]{0,300}error: "no_recipient"/.test(notif));
  ok("Class E · failNoRecipient skips the auto-alert under a test tx", /if \(!meta\.client\) scheduleEmail\(\(\) => sendEmailFailureAlertOps\(meta\.idempotencyKey\)\);/.test(notif));
  const failNoRecipientCalls = (notif.match(/return failNoRecipient\(\{/g) ?? []).length;
  ok("Class E · every seller no_recipient early-return now routes through failNoRecipient (>= 11)", failNoRecipientCalls >= 11, `found ${failNoRecipientCalls}`);
  ok("Class E · no bare no_recipient early-return remains", (notif.match(/return \{ ok: false, status: "FAILED", error: "no_recipient" \}/g) ?? []).length === 0);

  ok("template · renderEmailFailureAlertOps exists", /export function renderEmailFailureAlertOps\(/.test(ops));
  const tpl = ops.slice(ops.indexOf("export function renderEmailFailureAlertOps"), ops.indexOf("export function renderEmailFailureAlertOps") + 2200);
  ok("template · subject is '⚠ Email delivery failed — <type>'", /const subject = `⚠ Email delivery failed — \$\{d\.emailType\}`;/.test(tpl));
  ok("template · exposes NO customer name / phone / address / totals / payout", !/(customerName|customerPhone|address|grandTotal|payout|unitPrice|lineTotal|billing)/i.test(tpl));
  ok("template · recipient is the masked form only", /recipientMasked/.test(tpl) && !/d\.recipient\b/.test(tpl));

  ok("audit.ts · writeAudit accepts an optional transaction client", /export async function writeAudit\(\s*input: AuditInput,\s*client: Prisma\.TransactionClient \| typeof prisma = prisma,/.test(audit));
  ok("admin filter list · includes email_failure_alert_ops", /"email_failure_alert_ops",/.test(logsRead));
  ok("admin table label · includes email_failure_alert_ops", /email_failure_alert_ops: "Delivery-failure alert",/.test(table));
}

// ---------------------------------------------------------------------------

async function dbTests() {
  const emailBefore = await prisma.emailLog.count();
  const auditBefore = await prisma.adminAuditLog.count();

  // K — capture the historical row up-front and after.
  const histBefore = await prisma.emailLog.findUnique({ where: { id: HISTORICAL_SKIPPED_ID } });

  try {
    await prisma.$transaction(async (tx) => {
      const support = (await tx.storeSetting.findUnique({ where: { key: "support.inboxEmail" } }))?.value?.trim() || "support@axiaro.shop";

      // ── A — 1P transport failure ──────────────────────────────────────────
      const a = await seedFailedLog(tx, { type: "order_confirmation", error: "smtp 421 temporary failure", recipient: "buyer1p@example.com" });
      const aRes = await sendEmailFailureAlertOps(a.idempotencyKey, { client: tx });
      const aAlert = await alertRow(tx, a.id);
      const aAudit = await auditRows(tx, a.id);
      ok("A · 1P failure → result ok", aRes.ok === true, JSON.stringify(aRes));
      ok("A · exactly one email.delivery_failed audit", aAudit.length === 1);
      ok("A · audit meta carries type/status/error + MASKED recipient (not the full address)", (() => {
        const m = JSON.parse(aAudit[0]?.meta ?? "{}");
        return m.type === "order_confirmation" && m.status === "FAILED" && typeof m.error === "string"
          && typeof m.recipientMasked === "string" && m.recipientMasked.startsWith("b*") && m.recipientMasked.endsWith("@example.com")
          && !JSON.stringify(m).includes("buyer1p@example.com");
      })());
      ok("A · exactly one email_failure_alert_ops row, key EMAIL_FAILURE_ALERT:<id>", !!aAlert && aAlert.type === "email_failure_alert_ops");
      ok("A · alert addressed to the support inbox", aAlert?.recipient === support);
      ok("A · alert subject = '⚠ Email delivery failed — order_confirmation'", aAlert?.subject === "⚠ Email delivery failed — order_confirmation");

      // ── B — 3P transport failure (same mechanism) ─────────────────────────
      const b = await seedFailedLog(tx, { type: "seller_order_received", error: "smtp 550 blocked", recipient: "seller3p@outlook.com" });
      await sendEmailFailureAlertOps(b.idempotencyKey, { client: tx });
      ok("B · 3P failure → one audit + one alert, identical path", (await auditRows(tx, b.id)).length === 1 && (await alertRow(tx, b.id))?.type === "email_failure_alert_ops");

      // ── C — production smtp_not_configured ───────────────────────────────
      const prevVercel = process.env.VERCEL_ENV;
      process.env.VERCEL_ENV = "production";
      const c = await seedFailedLog(tx, { type: "order_processing", status: "SKIPPED", error: "smtp_not_configured" });
      const cRes = await sendEmailFailureAlertOps(c.idempotencyKey, { client: tx });
      if (prevVercel === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = prevVercel;
      ok("C · prod smtp_not_configured → audit + alert", (await auditRows(tx, c.id)).length === 1 && !!(await alertRow(tx, c.id)), JSON.stringify(cRes));

      // ── C2 — NON-production smtp_not_configured stays quiet ──────────────
      const c2 = await seedFailedLog(tx, { type: "order_processing", status: "SKIPPED", error: "smtp_not_configured" });
      const c2Res = await sendEmailFailureAlertOps(c2.idempotencyKey, { client: tx });
      ok("C2 · non-prod smtp_not_configured → no audit, no alert", (await auditRows(tx, c2.id)).length === 0 && !(await alertRow(tx, c2.id)) && c2Res.status === "SKIPPED");

      // ── D — EMAIL_MODE=log ──────────────────────────────────────────────
      const d = await seedFailedLog(tx, { type: "order_shipped", status: "SKIPPED", error: "email_mode_log" });
      const dRes = await sendEmailFailureAlertOps(d.idempotencyKey, { client: tx });
      ok("D · email_mode_log → no alert, no failure audit", (await auditRows(tx, d.id)).length === 0 && !(await alertRow(tx, d.id)) && dRes.status === "SKIPPED");

      // ── E — render/template failure ─────────────────────────────────────
      const e = await seedFailedLog(tx, { type: "order_delivered", error: "render_failed: Cannot read properties of undefined" });
      await sendEmailFailureAlertOps(e.idempotencyKey, { client: tx });
      ok("E · render failure → audit + alert", (await auditRows(tx, e.id)).length === 1 && !!(await alertRow(tx, e.id)));

      // ── F/G — retry does NOT raise a second alert ───────────────────────
      const f = await seedFailedLog(tx, { type: "order_confirmation", error: "smtp 421", orderId: null });
      await sendEmailFailureAlertOps(f.idempotencyKey, { client: tx }); // the automatic first alert
      const fAlertsBefore = (await tx.emailLog.count({ where: { type: "email_failure_alert_ops" } }));
      await retryEmailByLog(f.id, tx); // admin retry — meta.retry === true (and meta.client)
      const fAlertsAfter = (await tx.emailLog.count({ where: { type: "email_failure_alert_ops" } }));
      ok("F/G · admin retry adds no new email_failure_alert_ops row", fAlertsAfter === fAlertsBefore);

      // ── H — fail → failed retry → exactly one alert ─────────────────────
      const h = await seedFailedLog(tx, { type: "order_cancelled", error: "smtp 451" });
      await sendEmailFailureAlertOps(h.idempotencyKey, { client: tx });
      await sendEmailFailureAlertOps(h.idempotencyKey, { client: tx }); // second attempt on the same failure
      const hAlerts = await tx.emailLog.findMany({ where: { idempotencyKey: `EMAIL_FAILURE_ALERT:${h.id}` } });
      const hAudits = await auditRows(tx, h.id);
      ok("H · exactly ONE alert row for the same failure", hAlerts.length === 1);
      ok("H · exactly ONE audit row for the same failure (idempotent)", hAudits.length === 1);

      // ── I — the alert email itself fails → zero recursive alerts ────────
      const i = await tx.emailLog.create({
        data: {
          type: "email_failure_alert_ops", recipient: support, subject: "⚠ Email delivery failed — order_confirmation",
          idempotencyKey: `EMAIL_FAILURE_ALERT:selffail-${Math.random().toString(36).slice(2)}`,
          status: "FAILED", provider: "smtp", error: "smtp 550", attempts: 1,
        },
        select: { id: true, idempotencyKey: true },
      });
      const iRes = await sendEmailFailureAlertOps(i.idempotencyKey, { client: tx });
      ok("I · an alert never alerts on itself (recursion guard → DEDUPED)", iRes.status === "DEDUPED");
      ok("I · no email.delivery_failed audit for the alert row", (await auditRows(tx, i.id)).length === 0);
      ok("I · no nested EMAIL_FAILURE_ALERT:<alertRowId> row", !(await alertRow(tx, i.id)));

      // ── M — a SENT row is not a failure ────────────────────────────────
      const m = await seedFailedLog(tx, { type: "order_confirmation", status: "SENT", error: null });
      const mRes = await sendEmailFailureAlertOps(m.idempotencyKey, { client: tx });
      ok("M · SENT row → DEDUPED, no audit, no alert", mRes.status === "DEDUPED" && (await auditRows(tx, m.id)).length === 0 && !(await alertRow(tx, m.id)));

      // ── J & L — no_recipient seller notification ───────────────────────
      const t = Date.now().toString(36);
      const seller = await tx.seller.create({
        data: { type: "THIRD_PARTY", status: "APPROVED", displayName: `NR ${t}`, slug: `nr9f18-${t}`, supportEmail: `nr-${t}@t.test`, contentStatus: "DRAFT" },
        select: { id: true, displayName: true },
      });
      // NO SellerUser, NO notifyEmail → loadSellerLifecycleEmailContext returns null
      const order = await tx.order.create({
        data: {
          orderNumber: `AX-T9F18-${t}-${Math.random().toString(36).slice(2, 5)}`,
          email: "customer-secret@t.test", phone: "+639999999999", status: "PROCESSING",
          paymentMethod: "NONE", subtotal: 119900, shippingFee: 15000, discountTotal: 0, grandTotal: 134900,
          shippingAddress: JSON.stringify(SHIP_ADDR),
        },
        select: { id: true, orderNumber: true },
      });
      await tx.sellerOrder.create({
        data: {
          orderId: order.id, sellerId: seller.id, sellerName: seller.displayName, sellerType: "THIRD_PARTY",
          supportEmail: `nr-${t}@t.test`, merchandiseSubtotal: 119900, discountAllocated: 0, shippingFee: 15000,
          total: 134900, commissionAmount: 17985, status: "PENDING_PAYMENT", settlementStatus: "PENDING_CAPTURE",
        },
      });
      const key = `SELLER_ORDER_RECEIVED:${order.id}`;

      const nrRes = await sendSellerOrderReceived(order.id, { client: tx });
      const nrRow = await tx.emailLog.findUnique({ where: { idempotencyKey: key } });
      ok("L · no_recipient seller notification now writes a FAILED EmailLog row", !!nrRow && nrRow.status === "FAILED" && nrRow.error === "no_recipient", JSON.stringify(nrRes));
      ok("L · row carries a safe subject + placeholder recipient (no PII)", nrRow?.subject === `New order ${order.orderNumber} — seller notification` && nrRow?.recipient === "(no recipient resolved)");
      ok("L · row is keyed on the notification's own idempotency key", nrRow?.idempotencyKey === key);
      ok("J · under a test tx the auto-alert does NOT fire", !(await tx.emailLog.findUnique({ where: { idempotencyKey: `EMAIL_FAILURE_ALERT:${nrRow?.id}` } })));

      // sender retried → recordEmailFailure skipDuplicates → still exactly one row
      await sendSellerOrderReceived(order.id, { client: tx, idempotencyKey: key });
      ok("L · retried no_recipient send does not create a duplicate row", (await tx.emailLog.count({ where: { idempotencyKey: key } })) === 1);

      // …and the shared alert mechanism DOES pick that FAILED row up when invoked
      const nrAlert = await sendEmailFailureAlertOps(key, { client: tx });
      ok("L · the failure-alert mechanism receives the no_recipient row", nrAlert.ok === true && !!(await alertRow(tx, nrRow!.id)) && (await auditRows(tx, nrRow!.id)).length === 1);

      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }

  // K — historical row + global counts unchanged.
  const histAfter = await prisma.emailLog.findUnique({ where: { id: HISTORICAL_SKIPPED_ID } });
  ok("K · historical SKIPPED row cmtrjke8f… still present + untouched", (() => {
    if (!histBefore || !histAfter) return histBefore === null && histAfter === null; // tolerate absence in a fresh DB
    return histBefore.status === histAfter.status && histBefore.attempts === histAfter.attempts
      && histBefore.updatedAt.getTime() === histAfter.updatedAt.getTime() && histAfter.status === "SKIPPED";
  })());
  ok("rollback · no EmailLog rows leaked", (await prisma.emailLog.count()) === emailBefore);
  ok("rollback · no AdminAuditLog rows leaked", (await prisma.adminAuditLog.count()) === auditBefore);
}

async function main() {
  console.log("\nPHASE 9F-18 — email delivery-failure alerting\n");
  staticTests();
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
