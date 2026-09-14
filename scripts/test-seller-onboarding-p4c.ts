/**
 * Seller Onboarding — first-time self-service approval email recipient fix (9F-60).
 *
 * Bug: `loadSellerLifecycleEmailContext()` only ever resolved recipients from
 * ACTIVE SellerUser members or `Seller.notifyEmail`. A first-time self-service
 * seller (applicantUserId set, just APPROVED) has neither — no SellerUser is
 * created until OWNER claim, and notifyEmail is never asked for on the
 * customer-facing application — so `sendSellerAccountApproved()` always failed
 * `no_recipient`. Fix: when no recipient resolves and `applicantUserId` is set,
 * fall back to that user's CURRENT `User.email`. Additive and gated on
 * `addrs.size === 0`, so an admin-created seller (applicantUserId null) or any
 * seller that already has a member/notifyEmail is completely unaffected.
 *
 * `sendSellerAccountApproved` etc. only need a Prisma client (no admin
 * session), so — unlike `transitionSellerAction` itself — this file exercises
 * the real sender functions directly against rolled-back DB fixtures, with no
 * SMTP configured in this environment (`dispatchEmail` records SKIPPED /
 * "email_mode_log", never sends).
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-seller-onboarding-p4c.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { submitSellerApplication } from "../src/lib/seller-onboarding/repository";
import { createSeller } from "../src/lib/admin/sellers/repository";
import { sendSellerAccountApproved } from "../src/lib/email/notifications";

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

async function seedUser(tx: Tx, tag: string, email?: string) {
  return tx.user.create({
    data: { email: email ?? `p4c-${tag}-${Math.random().toString(36).slice(2, 8)}@t.test`, name: "P4C User" },
    select: { id: true, email: true },
  });
}
function validInput(tag: string) {
  return {
    displayName: `P4C Store ${tag}`,
    slug: `p4c-store-${tag}-${Math.random().toString(36).slice(2, 7)}`,
    supportEmail: `p4c-support-${tag}@t.test`, // deliberately DIFFERENT from any applicant/member account email
  };
}
async function auditRow(tx: Tx, action: string, actorUserId: string, sellerId: string) {
  return tx.adminAuditLog.create({
    data: { actorUserId, action, targetType: "seller", targetId: sellerId, summary: "test fixture" },
    select: { id: true },
  });
}

async function main() {
  console.log("\nSeller Onboarding — approval email recipient fix (9F-60)\n");

  // ── static: the fix itself is the smallest safe additive change ────────
  const notifSrc = read("src/lib/email/notifications.ts");
  const ctxFn = notifSrc.match(/async function loadSellerLifecycleEmailContext[\s\S]*?\n}/);
  ok("static · loadSellerLifecycleEmailContext exists and was matched", !!ctxFn);
  ok("static · the seller select now includes applicantUserId",
    !!ctxFn && /applicantUserId: true/.test(ctxFn[0]));
  ok("static · the fallback only fires when addrs is still empty AND applicantUserId is set",
    !!ctxFn && /if \(addrs\.size === 0 && seller\.applicantUserId\)/.test(ctxFn[0]));
  ok("static · the fallback resolves via User.email, never Seller.supportEmail",
    !!ctxFn && (() => {
      const idx = ctxFn[0].indexOf("if (addrs.size === 0 && seller.applicantUserId)");
      const block = ctxFn[0].slice(idx);
      return /client\.user\.findUnique/.test(block) && !/supportEmail/.test(block);
    })());
  ok("static · EMAIL_RE is reused, not redefined, in the fallback",
    !!ctxFn && (ctxFn[0].match(/EMAIL_RE/g) ?? []).length >= 2);
  ok("static · no new email template / templateKey was introduced (still seller_account_approved)",
    /templateKey: "seller_account_approved"/.test(notifSrc) &&
      !/renderSellerAccountApprovedSelfService|seller_account_approved_self_service/.test(notifSrc));
  ok("static · the reactivate-detection logic (audit.action lookup) is unchanged",
    /const reactivate = audit\?\.action === "seller\.reactivated"/.test(notifSrc));
  ok("static · sendSellerAccountApproved's actionUrl is unchanged (still ctx.portalUrl, no claim-specific URL)",
    /templateActionUrl: ctx\.portalUrl/.test(notifSrc));

  // ── DB (rolled back) ─────────────────────────────────────────────────────
  try {
    await prisma.$transaction(async (tx) => {
      const t = Date.now().toString(36);
      const admin = await seedUser(tx, `admin-${t}`);

      // A/B/H — first-time self-service approval: applicantUserId set, no
      // SellerUser, no notifyEmail. Must resolve to the applicant's CURRENT
      // account email, never Seller.supportEmail, and must not fail no_recipient.
      const applicantA = await seedUser(tx, `a-${t}`, `applicant-a-${t}@t.test`);
      const inputA = validInput(`a-${t}`);
      const createdA = await submitSellerApplication(applicantA.id, inputA, tx);
      if (!createdA.ok) throw new Error(`fixture setup failed (A): ${JSON.stringify(createdA)}`);
      await tx.seller.update({ where: { id: createdA.sellerId }, data: { status: "APPROVED" } });
      const auditA = await auditRow(tx, "seller.approved", admin.id, createdA.sellerId);

      const resA = await sendSellerAccountApproved(createdA.sellerId, auditA.id, { client: tx });
      ok("A/B · first-time self-service approval does not fail no_recipient",
        resA.status !== "FAILED" || (resA as { error?: string }).error !== "no_recipient",
        JSON.stringify(resA));
      ok("B · result is otherwise a normal dispatch outcome (SENT/SKIPPED), not FAILED",
        resA.status === "SENT" || resA.status === "SKIPPED", JSON.stringify(resA));

      const logA = await tx.emailLog.findUnique({
        where: { idempotencyKey: `SELLER_ACCOUNT_APPROVED:${createdA.sellerId}:${auditA.id}` },
      });
      ok("A · an EmailLog row was written", !!logA);
      ok("A · recipient resolved to the applicant's current account email",
        !!logA && logA.recipient === applicantA.email.toLowerCase(), logA?.recipient);
      ok("H · recipient is NOT Seller.supportEmail",
        !!logA && logA.recipient !== inputA.supportEmail.toLowerCase());

      // H (freshness) — a SEPARATE seller/applicant proves the email is read
      // fresh at send time, not cached from application-submission time.
      const applicantH = await seedUser(tx, `h-${t}`, `old-h-${t}@t.test`);
      const createdH = await submitSellerApplication(applicantH.id, validInput(`h-${t}`), tx);
      if (!createdH.ok) throw new Error(`fixture setup failed (H): ${JSON.stringify(createdH)}`);
      await tx.seller.update({ where: { id: createdH.sellerId }, data: { status: "APPROVED" } });
      const auditH = await auditRow(tx, "seller.approved", admin.id, createdH.sellerId);
      await tx.user.update({ where: { id: applicantH.id }, data: { email: `new-h-${t}@t.test` } });
      await sendSellerAccountApproved(createdH.sellerId, auditH.id, { client: tx });
      const logH = await tx.emailLog.findUnique({
        where: { idempotencyKey: `SELLER_ACCOUNT_APPROVED:${createdH.sellerId}:${auditH.id}` },
      });
      ok("H · email is read fresh at send time, not snapshotted at application time",
        !!logH && logH.recipient === `new-h-${t}@t.test`, logH?.recipient);

      // C — admin-created seller (applicantUserId null), no member, no
      // notifyEmail → existing no_recipient behavior is UNCHANGED.
      const inputC = validInput(`c-${t}`);
      const createdC = await createSeller(inputC, tx);
      if (!createdC.ok) throw new Error(`fixture setup failed (C): ${JSON.stringify(createdC)}`);
      await tx.seller.update({ where: { id: createdC.sellerId }, data: { status: "APPROVED" } });
      const sellerCRow = await tx.seller.findUniqueOrThrow({
        where: { id: createdC.sellerId },
        select: { applicantUserId: true },
      });
      ok("C · admin-created seller has no applicantUserId", sellerCRow.applicantUserId === null);
      const auditC = await auditRow(tx, "seller.approved", admin.id, createdC.sellerId);
      const resC = await sendSellerAccountApproved(createdC.sellerId, auditC.id, { client: tx });
      ok("C · admin-created seller approval still fails no_recipient (unchanged)",
        resC.status === "FAILED" && (resC as { error?: string }).error === "no_recipient",
        JSON.stringify(resC));
      const logC = await tx.emailLog.findUnique({
        where: { idempotencyKey: `SELLER_ACCOUNT_APPROVED:${createdC.sellerId}:${auditC.id}` },
      });
      ok("C · the no_recipient EmailLog row is still written (existing failNoRecipient behavior)",
        !!logC && logC.error === "no_recipient" && logC.status === "FAILED");

      // D — SUSPENDED→APPROVED reactivation for a seller with an existing
      // notifyEmail (no member yet) — existing notifyEmail fallback + the
      // reactivate flag must both be unaffected by this fix.
      const applicantD = await seedUser(tx, `d-${t}`, `applicant-d-${t}@t.test`);
      const createdD = await submitSellerApplication(applicantD.id, validInput(`d-${t}`), tx);
      if (!createdD.ok) throw new Error(`fixture setup failed (D): ${JSON.stringify(createdD)}`);
      const notifyD = `notify-d-${t}@t.test`;
      await tx.seller.update({
        where: { id: createdD.sellerId },
        data: { status: "APPROVED", notifyEmail: notifyD },
      });
      // suspend, then reactivate
      await tx.seller.update({ where: { id: createdD.sellerId }, data: { status: "SUSPENDED" } });
      await tx.seller.update({ where: { id: createdD.sellerId }, data: { status: "APPROVED" } });
      const auditD = await auditRow(tx, "seller.reactivated", admin.id, createdD.sellerId);
      const resD = await sendSellerAccountApproved(createdD.sellerId, auditD.id, { client: tx });
      ok("D · reactivation dispatch does not fail", resD.status !== "FAILED", JSON.stringify(resD));
      const logD = await tx.emailLog.findUnique({
        where: { idempotencyKey: `SELLER_ACCOUNT_APPROVED:${createdD.sellerId}:${auditD.id}` },
      });
      ok("D · reactivation still resolves via the existing notifyEmail fallback, not the applicant fallback",
        !!logD && logD.recipient === notifyD.toLowerCase() && logD.recipient !== applicantD.email.toLowerCase(),
        logD?.recipient);

      // E — existing ACTIVE SellerUser member takes precedence over the new
      // applicant fallback on a FIRST (non-reactivation) approval.
      const applicantE = await seedUser(tx, `e-${t}`, `applicant-e-${t}@t.test`);
      const memberE = await seedUser(tx, `e-member-${t}`, `member-e-${t}@t.test`);
      const createdE = await submitSellerApplication(applicantE.id, validInput(`e-${t}`), tx);
      if (!createdE.ok) throw new Error(`fixture setup failed (E): ${JSON.stringify(createdE)}`);
      await tx.sellerUser.create({
        data: { sellerId: createdE.sellerId, userId: memberE.id, role: "OWNER", status: "ACTIVE" },
      });
      await tx.seller.update({ where: { id: createdE.sellerId }, data: { status: "APPROVED" } });
      const auditE = await auditRow(tx, "seller.approved", admin.id, createdE.sellerId);
      await sendSellerAccountApproved(createdE.sellerId, auditE.id, { client: tx });
      const logE = await tx.emailLog.findUnique({
        where: { idempotencyKey: `SELLER_ACCOUNT_APPROVED:${createdE.sellerId}:${auditE.id}` },
      });
      ok("E · existing ACTIVE SellerUser member recipient is unchanged (precedence over applicant fallback)",
        !!logE && logE.recipient === memberE.email.toLowerCase() && logE.recipient !== applicantE.email.toLowerCase(),
        logE?.recipient);

      // F/G — EmailLog idempotency: replaying the exact same call creates no
      // duplicate row and returns DEDUPED, not a second send/failure.
      const beforeCount = await tx.emailLog.count({
        where: { idempotencyKey: `SELLER_ACCOUNT_APPROVED:${createdA.sellerId}:${auditA.id}` },
      });
      const resAReplay = await sendSellerAccountApproved(createdA.sellerId, auditA.id, { client: tx });
      const afterCount = await tx.emailLog.count({
        where: { idempotencyKey: `SELLER_ACCOUNT_APPROVED:${createdA.sellerId}:${auditA.id}` },
      });
      ok("F · idempotency key is unique — replay does not create a second EmailLog row",
        beforeCount === 1 && afterCount === 1, `before=${beforeCount} after=${afterCount}`);
      ok("G · replaying approval is deduped, not re-dispatched",
        resAReplay.status === "DEDUPED", JSON.stringify(resAReplay));

      // I — applicantUserId set but the referenced User no longer exists
      // (orphan reference; the column has no FK). Must fail SAFELY with the
      // existing no-recipient behavior, never throw.
      const applicantI = await seedUser(tx, `i-${t}`, `applicant-i-${t}@t.test`);
      const createdI = await submitSellerApplication(applicantI.id, validInput(`i-${t}`), tx);
      if (!createdI.ok) throw new Error(`fixture setup failed (I): ${JSON.stringify(createdI)}`);
      await tx.seller.update({ where: { id: createdI.sellerId }, data: { status: "APPROVED" } });
      await tx.user.delete({ where: { id: applicantI.id } });
      const auditI = await auditRow(tx, "seller.approved", admin.id, createdI.sellerId);
      const resI = await sendSellerAccountApproved(createdI.sellerId, auditI.id, { client: tx });
      ok("I · missing applicant User row fails safely with no_recipient (no throw)",
        resI.status === "FAILED" && (resI as { error?: string }).error === "no_recipient",
        JSON.stringify(resI));

      throw new Rollback();
    }, { timeout: 30_000, maxWait: 15_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("isolation · no fixture User leaked", (await prisma.user.count({ where: { email: { contains: "p4c-" } } })) === 0);
  ok("isolation · no fixture Seller leaked", (await prisma.seller.count({ where: { displayName: { startsWith: "P4C Store " } } })) === 0);
  ok("isolation · no fixture EmailLog leaked",
    (await prisma.emailLog.count({ where: { idempotencyKey: { contains: "SELLER_ACCOUNT_APPROVED" }, recipient: { contains: "t.test" } } })) === 0);
  ok("isolation · no fixture AdminAuditLog leaked", (await prisma.adminAuditLog.count({ where: { summary: "test fixture" } })) === 0);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
