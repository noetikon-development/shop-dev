/**
 * Seller Onboarding — Ops notification for a new self-service application (9F-62).
 *
 * Goal: Axiaro staff get their own signal that a new application landed,
 * separate from the applicant's existing acknowledgement. New sender
 * `sendSellerAccountSubmittedOps` (mirrors the established
 * `sendSellerProductRequestResubmittedOps` Ops-notice pattern: recipient =
 * `getSupportInboxEmail()`, `from: ORDERS_FROM`, own idempotency key, own CMS
 * template registered with `audience: "ops"`), wired ONLY into the
 * self-service action (`submitSellerApplicationAction`) — never into
 * `createSellerAction` (admin-created path), since an admin who just typed
 * the seller in with their own hands doesn't need Axiaro to alert Axiaro
 * about it.
 *
 * `getSupportInboxEmail()` reads the LIVE `support.inboxEmail` StoreSetting
 * via the module-level `prisma` client (not `opts.client`) — same as every
 * other existing Ops sender (e.g. `sendSellerProductRequestResubmittedOps`,
 * `sendEmailFailureAlertOps`), so a rolled-back transaction's own writes to
 * that setting would NOT be visible to it. This file therefore reads the
 * REAL, currently-committed setting (read-only, never mutated) to predict the
 * expected recipient, exactly the same non-destructive technique used
 * throughout this test family for state a rolled-back tx can't influence.
 * `getEmailTemplateOverride`, by contrast, DOES accept `opts.client`, so the
 * CMS-override test below creates a real (rolled-back) `ContentBlock` row and
 * observes it take effect via `EmailLog.subject`.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-seller-onboarding-p4e.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { submitSellerApplication } from "../src/lib/seller-onboarding/repository";
import { createSeller } from "../src/lib/admin/sellers/repository";
import { sendSellerAccountSubmitted, sendSellerAccountSubmittedOps } from "../src/lib/email/notifications";

const prisma = new PrismaClient();

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
class Rollback extends Error {}
type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

// Mirrors notifications.ts's own EMAIL_RE / SUPPORT_INBOX_FALLBACK exactly —
// used only to PREDICT what the real, live getSupportInboxEmail() will
// return, never to mutate anything.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SUPPORT_INBOX_FALLBACK = "support@axiaro.shop";

function seedUser(tx: Tx, tag: string, email?: string) {
  return tx.user.create({
    data: { email: email ?? `p4e-${tag}-${Math.random().toString(36).slice(2, 8)}@t.test`, name: "P4E User" },
    select: { id: true, email: true },
  });
}
function validInput(tag: string) {
  return {
    displayName: `P4E Store ${tag}`,
    slug: `p4e-store-${tag}-${Math.random().toString(36).slice(2, 7)}`,
    supportEmail: `p4e-support-${tag}@t.test`,
  };
}

async function main() {
  console.log("\nSeller Onboarding — new-application Ops notification (9F-62)\n");

  // ── static: wiring, scope, and the deliberate self-service-only decision ──
  const notifSrc = read("src/lib/email/notifications.ts");
  const opsFnMatch = notifSrc.match(/export async function sendSellerAccountSubmittedOps[\s\S]*?\r?\n  \}\r?\n\}/);
  ok("static · sendSellerAccountSubmittedOps was matched", !!opsFnMatch);
  const opsFnSrc = opsFnMatch ? opsFnMatch[0] : "";

  ok("static · recipient comes from getSupportInboxEmail(), never a hard-coded address or Seller.supportEmail as the `to`",
    /await getSupportInboxEmail\(\)/.test(opsFnSrc) && !/to: seller\.supportEmail/.test(opsFnSrc));
  ok("static · idempotency key is SELLER_ACCOUNT_SUBMITTED_OPS:<sellerId>, distinct from the applicant ack's key",
    /`SELLER_ACCOUNT_SUBMITTED_OPS:\$\{sellerId\}`/.test(opsFnSrc));
  ok("static · templateKey is the new dedicated seller_account_submitted_ops key",
    /templateKey: "seller_account_submitted_ops"/.test(opsFnSrc));
  ok("static · no mutation anywhere in this function (Ops notice is read + send only)",
    !/\.(create|update|updateMany|upsert|delete|deleteMany)\(/.test(opsFnSrc));

  const submittedFnMatch = notifSrc.match(/export async function sendSellerAccountSubmitted\(/);
  const submittedFnFull = notifSrc.slice(submittedFnMatch ? submittedFnMatch.index! : 0, (submittedFnMatch ? submittedFnMatch.index! : 0) + 1200);
  ok("static · the existing applicant acknowledgement (sendSellerAccountSubmitted) is untouched — still resolves via loadSellerApplicationEmailContext/Seller.supportEmail only",
    /loadSellerApplicationEmailContext\(sellerId, opts\.client\)/.test(submittedFnFull) &&
      /templateKey: "seller_account_submitted"/.test(submittedFnFull) &&
      !/getSupportInboxEmail/.test(submittedFnFull));

  const onboardingActionsSrc = read("src/lib/seller-onboarding/actions.ts");
  ok("static · the self-service action schedules BOTH the applicant ack AND the new Ops notice",
    /scheduleEmail\(\(\) => sendSellerAccountSubmitted\(res\.sellerId\)\)/.test(onboardingActionsSrc) &&
      /scheduleEmail\(\(\) => sendSellerAccountSubmittedOps\(res\.sellerId\)\)/.test(onboardingActionsSrc));

  const adminActionsSrc = read("src/lib/admin/sellers/actions.ts");
  ok("static · the admin-created path (createSellerAction) does NOT call the new Ops notice — deliberate, documented decision",
    !/sendSellerAccountSubmittedOps/.test(adminActionsSrc));
  ok("static · the admin-created path's own applicant-ack call is unchanged",
    /scheduleEmail\(\(\) => sendSellerAccountSubmitted\(res\.sellerId\)\)/.test(adminActionsSrc));

  const registrySrc = read("src/lib/email/template-registry.ts");
  ok("static · seller_account_submitted_ops is registered with audience: \"ops\"",
    /t\("seller_account_submitted_ops", "New seller application \(Ops notice\)", "seller_lifecycle",[\s\S]{0,200}\{ audience: "ops" \}\)/.test(registrySrc));

  const sendSrc = read("src/lib/email/send.ts");
  ok("static · seller_account_submitted_ops is a distinct EmailType from seller_account_submitted",
    /\| "seller_account_submitted_ops"/.test(sendSrc) && /\| "seller_account_submitted"/.test(sendSrc));

  // ── DB (rolled back) ─────────────────────────────────────────────────────
  try {
    await prisma.$transaction(async (tx) => {
      const t = Date.now().toString(36);

      // Read-only: predict what the REAL, live getSupportInboxEmail() will
      // resolve to, without writing anything.
      const liveSetting = await tx.storeSetting.findUnique({ where: { key: "support.inboxEmail" }, select: { value: true } });
      const liveVal = (liveSetting?.value ?? "").trim();
      const expectedOpsInbox = (EMAIL_RE.test(liveVal) ? liveVal : SUPPORT_INBOX_FALLBACK).toLowerCase();

      // A — self-service submission: both notifications fire, to different
      // recipients, with different idempotency keys.
      const applicantA = await seedUser(tx, `a-${t}`, `applicant-a-${t}@t.test`);
      const inputA = validInput(`a-${t}`);
      const createdA = await submitSellerApplication(applicantA.id, inputA, tx);
      if (!createdA.ok) throw new Error(`fixture setup failed (A): ${JSON.stringify(createdA)}`);

      const ackA = await sendSellerAccountSubmitted(createdA.sellerId, { client: tx });
      const opsA = await sendSellerAccountSubmittedOps(createdA.sellerId, { client: tx });
      ok("A · applicant acknowledgement dispatches successfully (unchanged)", ackA.status === "SENT" || ackA.status === "SKIPPED", JSON.stringify(ackA));
      ok("A · Ops notification dispatches successfully", opsA.status === "SENT" || opsA.status === "SKIPPED", JSON.stringify(opsA));

      const logAck = await tx.emailLog.findUnique({ where: { idempotencyKey: `SELLER_ACCOUNT_SUBMITTED:${createdA.sellerId}` } });
      const logOps = await tx.emailLog.findUnique({ where: { idempotencyKey: `SELLER_ACCOUNT_SUBMITTED_OPS:${createdA.sellerId}` } });
      ok("A · applicant ack EmailLog row exists, recipient is Seller.supportEmail (unchanged)",
        !!logAck && logAck.recipient === inputA.supportEmail.toLowerCase(), logAck?.recipient);
      ok("A · Ops EmailLog row exists, recipient is the support/ops inbox — never the applicant or Seller.supportEmail",
        !!logOps && logOps.recipient === expectedOpsInbox &&
          logOps.recipient !== inputA.supportEmail.toLowerCase() && logOps.recipient !== applicantA.email.toLowerCase(),
        logOps?.recipient);
      ok("A · the two notifications have distinct idempotency keys and are two distinct EmailLog rows",
        !!logAck && !!logOps && logAck.id !== logOps.id);
      ok("A · exactly one applicant-ack row and one Ops row exist for this seller",
        (await tx.emailLog.count({ where: { idempotencyKey: `SELLER_ACCOUNT_SUBMITTED:${createdA.sellerId}` } })) === 1 &&
          (await tx.emailLog.count({ where: { idempotencyKey: `SELLER_ACCOUNT_SUBMITTED_OPS:${createdA.sellerId}` } })) === 1);

      // B — replay: neither notification duplicates.
      const ackA2 = await sendSellerAccountSubmitted(createdA.sellerId, { client: tx });
      const opsA2 = await sendSellerAccountSubmittedOps(createdA.sellerId, { client: tx });
      ok("B · replaying the applicant ack is deduped, not re-dispatched", ackA2.status === "DEDUPED", JSON.stringify(ackA2));
      ok("B · replaying the Ops notice is deduped, not re-dispatched", opsA2.status === "DEDUPED", JSON.stringify(opsA2));
      ok("B · still exactly one row each after replay — no duplicates",
        (await tx.emailLog.count({ where: { idempotencyKey: `SELLER_ACCOUNT_SUBMITTED:${createdA.sellerId}` } })) === 1 &&
          (await tx.emailLog.count({ where: { idempotencyKey: `SELLER_ACCOUNT_SUBMITTED_OPS:${createdA.sellerId}` } })) === 1);

      // C — admin-created seller: the applicant ack behaves exactly as before
      // (unaffected by the new Ops sender's existence). The claim that
      // createSellerAction never CALLS the Ops sender is proven statically
      // above; this proves the shared applicant-ack function itself has no
      // behavior change for the admin-created case either.
      const inputC = validInput(`c-${t}`);
      const createdC = await createSeller(inputC, tx);
      if (!createdC.ok) throw new Error(`fixture setup failed (C): ${JSON.stringify(createdC)}`);
      const ackC = await sendSellerAccountSubmitted(createdC.sellerId, { client: tx });
      const logAckC = await tx.emailLog.findUnique({ where: { idempotencyKey: `SELLER_ACCOUNT_SUBMITTED:${createdC.sellerId}` } });
      ok("C · admin-created seller's applicant-ack recipient is still Seller.supportEmail, unchanged",
        ackC.status !== "FAILED" && !!logAckC && logAckC.recipient === inputC.supportEmail.toLowerCase());

      // D — the Ops sender itself is not seller-origin-specific (the
      // self-service-only RULE lives in the action layer, proven statically);
      // calling it directly for the SAME admin-created seller still works and
      // still resolves the ops inbox as recipient and reports the applicant
      // account as "—" (admin-created sellers have no applicantUserId).
      const opsC = await sendSellerAccountSubmittedOps(createdC.sellerId, { client: tx });
      const logOpsC = await tx.emailLog.findUnique({ where: { idempotencyKey: `SELLER_ACCOUNT_SUBMITTED_OPS:${createdC.sellerId}` } });
      ok("D · Ops notice for an admin-created seller (called directly) still resolves the ops inbox correctly",
        opsC.status !== "FAILED" && !!logOpsC && logOpsC.recipient === expectedOpsInbox);

      // E — missing/whatever the ops inbox setting currently is: the live
      // resolution never fails no_recipient (existing getSupportInboxEmail
      // fallback safety, exercised for real, not re-implemented).
      const applicantE = await seedUser(tx, `e-${t}`, `applicant-e-${t}@t.test`);
      const createdE = await submitSellerApplication(applicantE.id, validInput(`e-${t}`), tx);
      if (!createdE.ok) throw new Error(`fixture setup failed (E): ${JSON.stringify(createdE)}`);
      const opsE = await sendSellerAccountSubmittedOps(createdE.sellerId, { client: tx });
      ok("E · Ops notice never fails no_recipient regardless of the live support-inbox setting (existing fallback safety)",
        opsE.status !== "FAILED", JSON.stringify(opsE));
      const logOpsE = await tx.emailLog.findUnique({ where: { idempotencyKey: `SELLER_ACCOUNT_SUBMITTED_OPS:${createdE.sellerId}` } });
      ok("E · resolves to the predicted live/fallback ops inbox address",
        !!logOpsE && logOpsE.recipient === expectedOpsInbox);

      // F — CMS override: getEmailTemplateOverride DOES accept opts.client,
      // so a rolled-back ContentBlock row is visible to this same tx. A
      // distinctive custom subject proves the override actually rendered
      // (EmailLog.subject is the one render-output field persisted).
      const applicantF = await seedUser(tx, `f-${t}`, `applicant-f-${t}@t.test`);
      const createdF = await submitSellerApplication(applicantF.id, validInput(`f-${t}`), tx);
      if (!createdF.ok) throw new Error(`fixture setup failed (F): ${JSON.stringify(createdF)}`);
      const overrideSubject = `P4E OVERRIDE ${t}`;
      await tx.contentBlock.create({
        data: {
          key: "email.seller_account_submitted_ops",
          area: "global",
          type: "email_template",
          status: "PUBLISHED",
          data: JSON.stringify({ subject: overrideSubject, heading: "", body: "Custom ops body.", extraMessage: "", actionLabel: "" }),
        },
      });
      const opsF = await sendSellerAccountSubmittedOps(createdF.sellerId, { client: tx });
      ok("F · CMS override dispatch succeeds", opsF.status !== "FAILED", JSON.stringify(opsF));
      const logOpsF = await tx.emailLog.findUnique({ where: { idempotencyKey: `SELLER_ACCOUNT_SUBMITTED_OPS:${createdF.sellerId}` } });
      ok("F · the published CMS override's custom subject was actually used (proves the override wiring works for this new template)",
        !!logOpsF && logOpsF.subject === overrideSubject, logOpsF?.subject);

      // G — no SellerInvite/SellerUser side effects from any Ops call above.
      const allSellerIds = [createdA.sellerId, createdC.sellerId, createdE.sellerId, createdF.sellerId];
      ok("G · zero SellerInvite rows created by any of the above",
        (await tx.sellerInvite.count({ where: { sellerId: { in: allSellerIds } } })) === 0);
      ok("G · zero SellerUser rows created by any of the above",
        (await tx.sellerUser.count({ where: { sellerId: { in: allSellerIds } } })) === 0);

      throw new Rollback();
    }, { timeout: 30_000, maxWait: 15_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("isolation · no fixture User leaked", (await prisma.user.count({ where: { email: { contains: "p4e-" } } })) === 0);
  ok("isolation · no fixture Seller leaked", (await prisma.seller.count({ where: { displayName: { startsWith: "P4E Store " } } })) === 0);
  ok("isolation · no fixture EmailLog leaked",
    (await prisma.emailLog.count({ where: { idempotencyKey: { contains: "SELLER_ACCOUNT_SUBMITTED" }, recipient: { contains: "t.test" } } })) === 0);
  ok("isolation · no ContentBlock override leaked", (await prisma.contentBlock.count({ where: { key: "email.seller_account_submitted_ops" } })) === 0);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
