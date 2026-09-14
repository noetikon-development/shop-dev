/**
 * Seller Onboarding Phase 3 — applicant-facing application status page.
 *
 * Pattern: static-source checks + one prisma.$transaction ending in
 * `throw new Rollback()` (mirrors test-seller-onboarding-p2 / test-9f56).
 * `getSellerApplicationStatus` is a plain, auth-free repository function — the
 * page itself just calls `requireUser()` then this — so every scenario is
 * exercised directly against the repository, exactly like Phase 2's tests
 * exercise `submitSellerApplication` directly.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-seller-onboarding-p3.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { submitSellerApplication, getSellerApplicationStatus } from "../src/lib/seller-onboarding/repository";

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

async function seedApplicant(tx: Tx, tag: string) {
  return tx.user.create({
    data: { email: `p3-applicant-${tag}-${Math.random().toString(36).slice(2, 8)}@t.test`, name: "Applicant" },
    select: { id: true },
  });
}
function validInput(tag: string) {
  return {
    displayName: `P3 Store ${tag}`,
    slug: `p3-store-${tag}-${Math.random().toString(36).slice(2, 7)}`,
    supportEmail: `p3-store-${tag}@t.test`,
  };
}
async function seedRejectAudit(tx: Tx, sellerId: string, reason: string) {
  return tx.adminAuditLog.create({
    data: { action: "seller.rejected", targetType: "seller", targetId: sellerId, summary: "x", meta: JSON.stringify({ sellerId, from: "PENDING", to: "REJECTED", reason }) },
    select: { id: true },
  });
}
async function seedReopenAudit(tx: Tx, sellerId: string, note: string) {
  return tx.adminAuditLog.create({
    data: { action: "seller.reopened", targetType: "seller", targetId: sellerId, summary: "x", meta: JSON.stringify({ sellerId, from: "REJECTED", to: "PENDING", reason: note }) },
    select: { id: true },
  });
}

async function main() {
  console.log("\nSeller Onboarding Phase 3 — application status page\n");

  // ── static: source-level security checks ────────────────────────────────
  const repoSrc = read("src/lib/seller-onboarding/repository.ts");
  const pageSrc = read("src/app/(shop)/sell-on-axiaro/status/page.tsx");

  ok("static · the status page requires an authenticated user before any lookup",
    /await requireUser\(/.test(pageSrc) && pageSrc.indexOf("await requireUser(") < pageSrc.indexOf("getSellerApplicationStatus("));
  ok("static · getSellerApplicationStatus's top-level Seller lookup is keyed on applicantUserId only",
    (() => {
      const m = repoSrc.match(/export async function getSellerApplicationStatus[\s\S]*?client\.seller\.findFirst\(\{\s*where:\s*\{([^}]*)\}/);
      return !!m && /applicantUserId/.test(m[1]) && !/supportEmail|displayName|slug/.test(m[1]);
    })());
  ok("static · the page never reads a sellerId/applicantUserId from params, query, or form",
    !/searchParams|params\.(sellerId|applicantUserId|id)/.test(pageSrc) &&
      !/formData\.get\(\s*["'](sellerId|applicantUserId)["']\s*\)/.test(pageSrc));
  ok("static · the page never renders commissionRate, contentReviewNote, or a raw Seller id",
    !/commissionRate|contentReviewNote|app\.sellerId|app\.id\b/.test(pageSrc));
  // Phase 4 legitimately extended getSellerApplicationStatus (per its own
  // task instructions) to READ SellerInvite for the status page's claim
  // button — the narrower, still-true invariant this phase cares about is
  // that this specific function never WRITES one; creation/claim logic lives
  // entirely in Phase 4's separate claimSellerOwnerInvite function.
  ok("static · getSellerApplicationStatus only ever reads SellerInvite, never creates/updates one",
    (() => {
      const m = repoSrc.match(/export async function getSellerApplicationStatus[\s\S]*?\n}/);
      return !!m && !/sellerInvite\.(create|update|updateMany|delete|deleteMany|upsert)/.test(m[0]);
    })());
  ok("static · no CHANGES_REQUESTED introduced",
    !/CHANGES_REQUESTED/.test(pageSrc) && !/CHANGES_REQUESTED/.test(repoSrc));

  // ── DB (rolled back) ─────────────────────────────────────────────────────
  try {
    await prisma.$transaction(async (tx) => {
      const t = Date.now().toString(36);

      // 1 — no application at all
      const noAppUser = await seedApplicant(tx, `none-${t}`);
      const noApp = await getSellerApplicationStatus(noAppUser.id, tx);
      ok("1 · a user with no application gets null (empty state)", noApp === null);

      // 2 — PENDING (first submission, never reopened)
      const pendingUser = await seedApplicant(tx, `pending-${t}`);
      const pendingRes = await submitSellerApplication(pendingUser.id, validInput(`pending-${t}`), tx);
      if (!pendingRes.ok) throw new Error(`fixture setup failed: ${JSON.stringify(pendingRes)}`);
      const pendingView = await getSellerApplicationStatus(pendingUser.id, tx);
      ok("2 · PENDING application is visible to its own applicant", pendingView?.status === "PENDING");
      ok("2 · displayName matches what was submitted", pendingView?.displayName === pendingRes.displayName);
      ok("2 · not marked reopened, no reason", pendingView?.reopened === false && pendingView?.reason === null);

      // 3 — APPROVED
      const approvedUser = await seedApplicant(tx, `approved-${t}`);
      const approvedRes = await submitSellerApplication(approvedUser.id, validInput(`approved-${t}`), tx);
      if (!approvedRes.ok) throw new Error(`fixture setup failed: ${JSON.stringify(approvedRes)}`);
      await tx.seller.update({ where: { id: approvedRes.sellerId }, data: { status: "APPROVED" } });
      const approvedView = await getSellerApplicationStatus(approvedUser.id, tx);
      ok("3 · APPROVED application displays approved state", approvedView?.status === "APPROVED");

      // 4 — REJECTED with the authoritative reason
      const rejectedUser = await seedApplicant(tx, `rejected-${t}`);
      const rejectedRes = await submitSellerApplication(rejectedUser.id, validInput(`rejected-${t}`), tx);
      if (!rejectedRes.ok) throw new Error(`fixture setup failed: ${JSON.stringify(rejectedRes)}`);
      await tx.seller.update({ where: { id: rejectedRes.sellerId }, data: { status: "REJECTED" } });
      await seedRejectAudit(tx, rejectedRes.sellerId, "Business registration could not be verified.");
      const rejectedView = await getSellerApplicationStatus(rejectedUser.id, tx);
      ok("4 · REJECTED application displays the authoritative reason",
        rejectedView?.status === "REJECTED" && rejectedView?.reason === "Business registration could not be verified.");

      // 4b — REJECTED with NO audit row (shouldn't happen via the real action,
      // but the repository must never invent a reason if it does)
      const rejectedNoAuditUser = await seedApplicant(tx, `rejected-noaudit-${t}`);
      const rejectedNoAuditRes = await submitSellerApplication(rejectedNoAuditUser.id, validInput(`rejected-noaudit-${t}`), tx);
      if (!rejectedNoAuditRes.ok) throw new Error(`fixture setup failed: ${JSON.stringify(rejectedNoAuditRes)}`);
      await tx.seller.update({ where: { id: rejectedNoAuditRes.sellerId }, data: { status: "REJECTED" } });
      const rejectedNoAuditView = await getSellerApplicationStatus(rejectedNoAuditUser.id, tx);
      ok("4b · REJECTED with no audit row → reason is null, never invented", rejectedNoAuditView?.reason === null);

      // 5 — reopened (REJECTED → PENDING) shows the reopened state + note
      const reopenedUser = await seedApplicant(tx, `reopened-${t}`);
      const reopenedRes = await submitSellerApplication(reopenedUser.id, validInput(`reopened-${t}`), tx);
      if (!reopenedRes.ok) throw new Error(`fixture setup failed: ${JSON.stringify(reopenedRes)}`);
      // status stays PENDING (a reopen returns it there) — only the audit row
      // (and the fact it's the most recent one) signals "reopened"
      await seedReopenAudit(tx, reopenedRes.sellerId, "Please resubmit with an updated business permit.");
      const reopenedView = await getSellerApplicationStatus(reopenedUser.id, tx);
      ok("5 · reopened application is still PENDING", reopenedView?.status === "PENDING");
      ok("5 · marked reopened with the authoritative note", reopenedView?.reopened === true &&
        reopenedView?.reason === "Please resubmit with an updated business permit.");

      // 6 — cross-user isolation: neither applicant can see the other's data
      ok("6 · applicant A cannot retrieve applicant B's application",
        (await getSellerApplicationStatus(pendingUser.id, tx))?.displayName !== approvedRes.displayName);
      const crossCheck = await getSellerApplicationStatus(rejectedUser.id, tx);
      ok("6 · applicant sees only their OWN reason, not another applicant's",
        crossCheck?.reason === "Business registration could not be verified." &&
        crossCheck?.displayName === rejectedRes.displayName);

      // 7 — most-recent-application handling: a user with an older CLOSED
      // seller and a fresh PENDING one sees the fresh one, not the stale one
      // (this is the direct consequence of Phase 2's documented CLOSED
      // re-application rule — the status page must stay consistent with it).
      const multiUser = await seedApplicant(tx, `multi-${t}`);
      const oldRes = await submitSellerApplication(multiUser.id, validInput(`multi-old-${t}`), tx);
      if (!oldRes.ok) throw new Error(`fixture setup failed: ${JSON.stringify(oldRes)}`);
      await tx.seller.update({ where: { id: oldRes.sellerId }, data: { status: "CLOSED" } });
      const newRes = await submitSellerApplication(multiUser.id, validInput(`multi-new-${t}`), tx);
      if (!newRes.ok) throw new Error(`fixture setup failed: ${JSON.stringify(newRes)}`);
      const multiView = await getSellerApplicationStatus(multiUser.id, tx);
      ok("7 · a user with an old CLOSED + a fresh PENDING application sees the fresh one",
        multiView?.status === "PENDING" && multiView?.displayName === newRes.displayName);

      // 8 — no SellerInvite touched anywhere in this phase
      ok("8 · zero SellerInvite rows created by any of the above", (await tx.sellerInvite.count()) === 0);

      throw new Rollback();
    }, { timeout: 30_000, maxWait: 15_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("isolation · no fixture User leaked", (await prisma.user.count({ where: { email: { contains: "p3-applicant-" } } })) === 0);
  ok("isolation · no fixture Seller leaked", (await prisma.seller.count({ where: { displayName: { startsWith: "P3 Store " } } })) === 0);
  ok("isolation · no fixture AdminAuditLog leaked", (await prisma.adminAuditLog.count({ where: { summary: "x", action: { in: ["seller.rejected", "seller.reopened"] } } })) === 0);
  ok("isolation · no fixture SellerInvite leaked", (await prisma.sellerInvite.count()) === 0);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
