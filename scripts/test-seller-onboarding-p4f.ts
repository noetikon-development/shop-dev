/**
 * Seller Onboarding — CMS support for seller_account_suspended/closed (9F-63).
 *
 * Bug/gap: every other seller-lifecycle email (submitted, approved, rejected,
 * reopened, the new submitted_ops) is CMS-editable via the existing
 * `ContentBlock`/`EMAIL_TEMPLATES` mechanism — suspended/closed were never
 * registered and their senders never even attempted an override lookup
 * (`renderAndDispatch` only calls `getEmailTemplateOverride` when
 * `meta.templateKey` is set). Fix: register both in `EMAIL_TEMPLATES`
 * (`seller_lifecycle` category, `actionButton: false` — the hardcoded
 * templates have never had a CTA button, only "reply to this email") and
 * pass `templateKey`/`templateTokens` through in both senders, mirroring
 * exactly how `sendSellerAccountApproved` already does it. Recipient
 * resolution, idempotency keys, audit handling and the hardcoded fallback
 * templates themselves are all untouched.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-seller-onboarding-p4f.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { EMAIL_TEMPLATES } from "../src/lib/email/template-registry";
import { getStoreBrand } from "../src/lib/site-settings";
import { submitSellerApplication } from "../src/lib/seller-onboarding/repository";
import { createSeller } from "../src/lib/admin/sellers/repository";
import { sendSellerAccountSuspended, sendSellerAccountClosed } from "../src/lib/email/notifications";

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

function seedUser(tx: Tx, tag: string, email?: string) {
  return tx.user.create({
    data: { email: email ?? `p4f-${tag}-${Math.random().toString(36).slice(2, 8)}@t.test`, name: "P4F User" },
    select: { id: true, email: true },
  });
}
function validInput(tag: string) {
  return {
    displayName: `P4F Store ${tag}`,
    slug: `p4f-store-${tag}-${Math.random().toString(36).slice(2, 7)}`,
    supportEmail: `p4f-support-${tag}@t.test`,
  };
}
function auditRow(tx: Tx, action: string, actorUserId: string, sellerId: string) {
  return tx.adminAuditLog.create({
    data: { actorUserId, action, targetType: "seller", targetId: sellerId, summary: "test fixture" },
    select: { id: true },
  });
}

async function main() {
  console.log("\nSeller Onboarding — CMS support for suspended/closed (9F-63)\n");

  // ── A/B — registry ───────────────────────────────────────────────────────
  const suspendedDef = EMAIL_TEMPLATES.find((d) => d.key === "seller_account_suspended");
  const closedDef = EMAIL_TEMPLATES.find((d) => d.key === "seller_account_closed");
  ok("A · seller_account_suspended is registered in EMAIL_TEMPLATES", !!suspendedDef);
  ok("A · seller_account_suspended is in the seller_lifecycle category", suspendedDef?.category === "seller_lifecycle");
  ok("A · seller_account_suspended audience is \"seller\" (not ops/customer)", suspendedDef?.audience === "seller");
  ok("A · seller_account_suspended has no action button (matches the hardcoded template, which has never had one)",
    suspendedDef?.hasActionButton === false);
  ok("B · seller_account_closed is registered in EMAIL_TEMPLATES", !!closedDef);
  ok("B · seller_account_closed is in the seller_lifecycle category", closedDef?.category === "seller_lifecycle");
  ok("B · seller_account_closed audience is \"seller\"", closedDef?.audience === "seller");
  ok("B · seller_account_closed has no action button", closedDef?.hasActionButton === false);

  // ── C — both senders pass their template keys ───────────────────────────
  const notifSrc = read("src/lib/email/notifications.ts");
  const suspendedFn = notifSrc.match(/export async function sendSellerAccountSuspended[\s\S]*?\r?\n  \}\r?\n\}/);
  const closedFn = notifSrc.match(/export async function sendSellerAccountClosed[\s\S]*?\r?\n  \}\r?\n\}/);
  ok("C · sendSellerAccountSuspended was matched", !!suspendedFn);
  ok("C · sendSellerAccountClosed was matched", !!closedFn);
  const suspendedSrc = suspendedFn ? suspendedFn[0] : "";
  const closedSrc = closedFn ? closedFn[0] : "";

  ok("C · sendSellerAccountSuspended passes templateKey: \"seller_account_suspended\"",
    /templateKey: "seller_account_suspended"/.test(suspendedSrc));
  ok("C · sendSellerAccountClosed passes templateKey: \"seller_account_closed\"",
    /templateKey: "seller_account_closed"/.test(closedSrc));
  ok("C · neither sender introduces a templateActionUrl (preserves the no-button default)",
    !/templateActionUrl/.test(suspendedSrc) && !/templateActionUrl/.test(closedSrc));

  // ── E (structural) / F / G — recipient + idempotency untouched ──────────
  ok("F · sendSellerAccountSuspended's recipient is still ctx.recipients (loadSellerLifecycleEmailContext, unchanged)",
    /to: ctx\.recipients,/.test(suspendedSrc));
  ok("F · sendSellerAccountClosed's recipient is still ctx.recipients",
    /to: ctx\.recipients,/.test(closedSrc));
  ok("G · sendSellerAccountSuspended's idempotency key format is unchanged",
    /`SELLER_ACCOUNT_SUSPENDED:\$\{sellerId\}:\$\{auditLogId\}`/.test(suspendedSrc));
  ok("G · sendSellerAccountClosed's idempotency key format is unchanged",
    /`SELLER_ACCOUNT_CLOSED:\$\{sellerId\}:\$\{auditLogId\}`/.test(closedSrc));
  ok("· neither sender's failNoRecipient/audit-adjacent structure changed (still exactly one renderAndDispatch call each)",
    (suspendedSrc.match(/renderAndDispatch\(/g) ?? []).length === 1 &&
      (closedSrc.match(/renderAndDispatch\(/g) ?? []).length === 1);

  // ── I — the five OTHER seller lifecycle templates are untouched ─────────
  ok("I · sendSellerAccountApproved's own actionUrl/9F-61 CTA logic is untouched",
    /let actionUrl = ctx\.portalUrl;/.test(notifSrc) &&
      /if \(!activeMembership\) actionUrl = `\$\{ctx\.siteUrl\}\/sell-on-axiaro\/status`;/.test(notifSrc));
  ok("I · sendSellerAccountRejected still has no templateActionUrl (unchanged)",
    (() => {
      const m = notifSrc.match(/export async function sendSellerAccountRejected[\s\S]*?\r?\n  \}\r?\n\}/);
      return !!m && !/templateActionUrl/.test(m[0]) && /templateKey: "seller_account_rejected"/.test(m[0]);
    })());
  ok("I · sendSellerAccountReopened still has no templateActionUrl (unchanged)",
    (() => {
      const m = notifSrc.match(/export async function sendSellerAccountReopened[\s\S]*?\r?\n  \}\r?\n\}/);
      return !!m && !/templateActionUrl/.test(m[0]) && /templateKey: "seller_account_reopened"/.test(m[0]);
    })());
  ok("I · sendSellerAccountSubmitted still resolves via Seller.supportEmail only (untouched)",
    (() => {
      const m = notifSrc.match(/export async function sendSellerAccountSubmitted\(/);
      const slice = m ? notifSrc.slice(m.index!, m.index! + 1200) : "";
      return /loadSellerApplicationEmailContext\(sellerId, opts\.client\)/.test(slice) && !/getSupportInboxEmail/.test(slice);
    })());
  ok("I · sendSellerAccountSubmittedOps still resolves via getSupportInboxEmail (untouched)",
    (() => {
      const m = notifSrc.match(/export async function sendSellerAccountSubmittedOps[\s\S]*?\r?\n  \}\r?\n\}/);
      return !!m && /await getSupportInboxEmail\(\)/.test(m[0]);
    })());
  ok("I · the registry entries for the other five templates are unchanged (still present, same categories)",
    EMAIL_TEMPLATES.find((d) => d.key === "seller_account_submitted")?.hasActionButton === false &&
      EMAIL_TEMPLATES.find((d) => d.key === "seller_account_approved")?.hasActionButton === true &&
      EMAIL_TEMPLATES.find((d) => d.key === "seller_account_rejected")?.requiresReason === true &&
      EMAIL_TEMPLATES.find((d) => d.key === "seller_account_reopened")?.requiresReason === true &&
      EMAIL_TEMPLATES.find((d) => d.key === "seller_account_submitted_ops")?.audience === "ops");

  // ── DB (rolled back) ─────────────────────────────────────────────────────
  try {
    await prisma.$transaction(async (tx) => {
      const t = Date.now().toString(36);
      const admin = await seedUser(tx, `admin-${t}`);
      const brand = await getStoreBrand();

      // ── D — no CMS override: hardcoded subject/content still renders ────
      // (SUSPENDED) — a seller with an existing ACTIVE member (normal case).
      const applicantSusD = await seedUser(tx, `sus-d-${t}`);
      const memberSusD = await seedUser(tx, `sus-d-member-${t}`, `member-sus-d-${t}@t.test`);
      const createdSusD = await submitSellerApplication(applicantSusD.id, validInput(`sus-d-${t}`), tx);
      if (!createdSusD.ok) throw new Error(`fixture setup failed (D-suspended): ${JSON.stringify(createdSusD)}`);
      await tx.sellerUser.create({ data: { sellerId: createdSusD.sellerId, userId: memberSusD.id, role: "OWNER", status: "ACTIVE" } });
      await tx.seller.update({ where: { id: createdSusD.sellerId }, data: { status: "SUSPENDED" } });
      const auditSusD = await auditRow(tx, "seller.suspended", admin.id, createdSusD.sellerId);
      const resSusD = await sendSellerAccountSuspended(createdSusD.sellerId, auditSusD.id, { client: tx });
      ok("D · suspended dispatch succeeds with no override present", resSusD.status !== "FAILED", JSON.stringify(resSusD));
      const logSusD = await tx.emailLog.findUnique({
        where: { idempotencyKey: `SELLER_ACCOUNT_SUSPENDED:${createdSusD.sellerId}:${auditSusD.id}` },
      });
      ok("D · no-override subject is byte-identical to the existing hardcoded copy",
        !!logSusD && logSusD.subject === `Your ${brand} seller account has been suspended`, logSusD?.subject);
      ok("F · suspended recipient is the existing ACTIVE member — precedence unchanged",
        !!logSusD && logSusD.recipient === memberSusD.email.toLowerCase());

      // (CLOSED) — same shape, independent fixture.
      const applicantCloD = await seedUser(tx, `clo-d-${t}`);
      const memberCloD = await seedUser(tx, `clo-d-member-${t}`, `member-clo-d-${t}@t.test`);
      const createdCloD = await submitSellerApplication(applicantCloD.id, validInput(`clo-d-${t}`), tx);
      if (!createdCloD.ok) throw new Error(`fixture setup failed (D-closed): ${JSON.stringify(createdCloD)}`);
      await tx.sellerUser.create({ data: { sellerId: createdCloD.sellerId, userId: memberCloD.id, role: "OWNER", status: "ACTIVE" } });
      await tx.seller.update({ where: { id: createdCloD.sellerId }, data: { status: "CLOSED" } });
      const auditCloD = await auditRow(tx, "seller.closed", admin.id, createdCloD.sellerId);
      const resCloD = await sendSellerAccountClosed(createdCloD.sellerId, auditCloD.id, { client: tx });
      ok("D · closed dispatch succeeds with no override present", resCloD.status !== "FAILED", JSON.stringify(resCloD));
      const logCloD = await tx.emailLog.findUnique({
        where: { idempotencyKey: `SELLER_ACCOUNT_CLOSED:${createdCloD.sellerId}:${auditCloD.id}` },
      });
      ok("D · no-override subject is byte-identical to the existing hardcoded copy",
        !!logCloD && logCloD.subject === `Your ${brand} seller account has been closed`, logCloD?.subject);
      ok("F · closed recipient is the existing ACTIVE member — precedence unchanged",
        !!logCloD && logCloD.recipient === memberCloD.email.toLowerCase());

      // ── E/K — CMS override changes the rendered subject ─────────────────
      // (SUSPENDED)
      const overrideSubjectSus = `P4F OVERRIDE SUSPENDED ${t}`;
      await tx.contentBlock.create({
        data: {
          key: "email.seller_account_suspended",
          area: "global",
          type: "email_template",
          status: "PUBLISHED",
          data: JSON.stringify({ subject: overrideSubjectSus, heading: "", body: "Custom suspended body.", extraMessage: "", actionLabel: "" }),
        },
      });
      const applicantSusE = await seedUser(tx, `sus-e-${t}`);
      const memberSusE = await seedUser(tx, `sus-e-member-${t}`, `member-sus-e-${t}@t.test`);
      const createdSusE = await submitSellerApplication(applicantSusE.id, validInput(`sus-e-${t}`), tx);
      if (!createdSusE.ok) throw new Error(`fixture setup failed (E-suspended): ${JSON.stringify(createdSusE)}`);
      await tx.sellerUser.create({ data: { sellerId: createdSusE.sellerId, userId: memberSusE.id, role: "OWNER", status: "ACTIVE" } });
      await tx.seller.update({ where: { id: createdSusE.sellerId }, data: { status: "SUSPENDED" } });
      const auditSusE = await auditRow(tx, "seller.suspended", admin.id, createdSusE.sellerId);
      const resSusE = await sendSellerAccountSuspended(createdSusE.sellerId, auditSusE.id, { client: tx });
      ok("E · suspended CMS-override dispatch succeeds", resSusE.status !== "FAILED", JSON.stringify(resSusE));
      const logSusE = await tx.emailLog.findUnique({
        where: { idempotencyKey: `SELLER_ACCOUNT_SUSPENDED:${createdSusE.sellerId}:${auditSusE.id}` },
      });
      ok("E · the published override's custom subject was actually used for suspended",
        !!logSusE && logSusE.subject === overrideSubjectSus, logSusE?.subject);
      ok("F · recipient resolution unaffected by the override — still the ACTIVE member",
        !!logSusE && logSusE.recipient === memberSusE.email.toLowerCase());

      // (CLOSED)
      const overrideSubjectClo = `P4F OVERRIDE CLOSED ${t}`;
      await tx.contentBlock.create({
        data: {
          key: "email.seller_account_closed",
          area: "global",
          type: "email_template",
          status: "PUBLISHED",
          data: JSON.stringify({ subject: overrideSubjectClo, heading: "", body: "Custom closed body.", extraMessage: "", actionLabel: "" }),
        },
      });
      const applicantCloE = await seedUser(tx, `clo-e-${t}`);
      const memberCloE = await seedUser(tx, `clo-e-member-${t}`, `member-clo-e-${t}@t.test`);
      const createdCloE = await submitSellerApplication(applicantCloE.id, validInput(`clo-e-${t}`), tx);
      if (!createdCloE.ok) throw new Error(`fixture setup failed (E-closed): ${JSON.stringify(createdCloE)}`);
      await tx.sellerUser.create({ data: { sellerId: createdCloE.sellerId, userId: memberCloE.id, role: "OWNER", status: "ACTIVE" } });
      await tx.seller.update({ where: { id: createdCloE.sellerId }, data: { status: "CLOSED" } });
      const auditCloE = await auditRow(tx, "seller.closed", admin.id, createdCloE.sellerId);
      const resCloE = await sendSellerAccountClosed(createdCloE.sellerId, auditCloE.id, { client: tx });
      ok("E · closed CMS-override dispatch succeeds", resCloE.status !== "FAILED", JSON.stringify(resCloE));
      const logCloE = await tx.emailLog.findUnique({
        where: { idempotencyKey: `SELLER_ACCOUNT_CLOSED:${createdCloE.sellerId}:${auditCloE.id}` },
      });
      ok("E · the published override's custom subject was actually used for closed",
        !!logCloE && logCloE.subject === overrideSubjectClo, logCloE?.subject);
      ok("F · recipient resolution unaffected by the override — still the ACTIVE member",
        !!logCloE && logCloE.recipient === memberCloE.email.toLowerCase());

      // ── H — the eec1672 applicantUserId fallback still applies for both,
      // unchanged by adding CMS support (first-time self-service seller,
      // approved then suspended/closed WITHOUT ever being claimed).
      const applicantH1 = await seedUser(tx, `h1-${t}`, `applicant-h1-${t}@t.test`);
      const createdH1 = await submitSellerApplication(applicantH1.id, validInput(`h1-${t}`), tx);
      if (!createdH1.ok) throw new Error(`fixture setup failed (H-suspended): ${JSON.stringify(createdH1)}`);
      await tx.seller.update({ where: { id: createdH1.sellerId }, data: { status: "APPROVED" } });
      await tx.seller.update({ where: { id: createdH1.sellerId }, data: { status: "SUSPENDED" } });
      const auditH1 = await auditRow(tx, "seller.suspended", admin.id, createdH1.sellerId);
      const resH1 = await sendSellerAccountSuspended(createdH1.sellerId, auditH1.id, { client: tx });
      ok("H · suspended still dispatches for a never-claimed self-service seller (no ACTIVE SellerUser)",
        resH1.status !== "FAILED", JSON.stringify(resH1));
      const logH1 = await tx.emailLog.findUnique({
        where: { idempotencyKey: `SELLER_ACCOUNT_SUSPENDED:${createdH1.sellerId}:${auditH1.id}` },
      });
      ok("H · recipient still resolves via the eec1672 applicantUserId fallback for suspended",
        !!logH1 && logH1.recipient === applicantH1.email.toLowerCase());

      const applicantH2 = await seedUser(tx, `h2-${t}`, `applicant-h2-${t}@t.test`);
      const createdH2 = await submitSellerApplication(applicantH2.id, validInput(`h2-${t}`), tx);
      if (!createdH2.ok) throw new Error(`fixture setup failed (H-closed): ${JSON.stringify(createdH2)}`);
      await tx.seller.update({ where: { id: createdH2.sellerId }, data: { status: "APPROVED" } });
      await tx.seller.update({ where: { id: createdH2.sellerId }, data: { status: "CLOSED" } });
      const auditH2 = await auditRow(tx, "seller.closed", admin.id, createdH2.sellerId);
      const resH2 = await sendSellerAccountClosed(createdH2.sellerId, auditH2.id, { client: tx });
      ok("H · closed still dispatches for a never-claimed self-service seller (no ACTIVE SellerUser)",
        resH2.status !== "FAILED", JSON.stringify(resH2));
      const logH2 = await tx.emailLog.findUnique({
        where: { idempotencyKey: `SELLER_ACCOUNT_CLOSED:${createdH2.sellerId}:${auditH2.id}` },
      });
      ok("H · recipient still resolves via the eec1672 applicantUserId fallback for closed",
        !!logH2 && logH2.recipient === applicantH2.email.toLowerCase());

      // ── J — no SellerInvite/SellerUser side effects from any send above,
      // beyond the ACTIVE memberships this fixture setup created explicitly.
      const allSellerIds = [
        createdSusD.sellerId, createdCloD.sellerId, createdSusE.sellerId, createdCloE.sellerId,
        createdH1.sellerId, createdH2.sellerId,
      ];
      ok("J · zero SellerInvite rows created by any send above", (await tx.sellerInvite.count({ where: { sellerId: { in: allSellerIds } } })) === 0);
      ok("J · SellerUser rows equal exactly the 4 explicit fixture memberships (none from the senders themselves)",
        (await tx.sellerUser.count({ where: { sellerId: { in: allSellerIds } } })) === 4);

      throw new Rollback();
    }, { timeout: 30_000, maxWait: 15_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("isolation · no fixture User leaked", (await prisma.user.count({ where: { email: { contains: "p4f-" } } })) === 0);
  ok("isolation · no fixture Seller leaked", (await prisma.seller.count({ where: { displayName: { startsWith: "P4F Store " } } })) === 0);
  ok("isolation · no fixture EmailLog leaked",
    (await prisma.emailLog.count({ where: { idempotencyKey: { contains: "SELLER_ACCOUNT_" }, recipient: { contains: "t.test" } } })) === 0);
  ok("K · no ContentBlock override leaked (suspended)", (await prisma.contentBlock.count({ where: { key: "email.seller_account_suspended" } })) === 0);
  ok("K · no ContentBlock override leaked (closed)", (await prisma.contentBlock.count({ where: { key: "email.seller_account_closed" } })) === 0);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
