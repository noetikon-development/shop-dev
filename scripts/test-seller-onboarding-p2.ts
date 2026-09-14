/**
 * Seller Onboarding Phase 2 — customer-facing application submission.
 *
 * Pattern: pure-function/static-source checks + one prisma.$transaction per
 * DB scenario ending in `throw new Rollback()` (mirrors test-9f56 / test-9f57).
 *
 * `submitSellerApplicationAction` itself calls `requireUser()`, which redirects
 * an unauthenticated caller via `next/navigation` — that only behaves
 * correctly inside a real Next.js request, not a bare script. So instead of
 * invoking the action directly to prove "unauthenticated is rejected", this
 * file (a) statically confirms `requireUser(` is the action's very first
 * meaningful step, before any Seller access, and (b) exercises the actual
 * business logic (`submitSellerApplication`, the repository function the
 * action delegates to post-auth) directly against a rolled-back transaction —
 * exactly the same split admin/sellers/actions.ts already uses between
 * `createSellerAction` (permission + form parsing) and `createSeller`
 * (pure data mutation, fully testable).
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-seller-onboarding-p2.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient, type Prisma } from "@prisma/client";
import { submitSellerApplication, SELLER_APPLICATION_IN_PROGRESS_STATUSES } from "../src/lib/seller-onboarding/repository";
import { createSeller } from "../src/lib/admin/sellers/repository";
import { sendSellerAccountSubmitted } from "../src/lib/email/notifications";

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
    data: { email: `applicant-${tag}-${Math.random().toString(36).slice(2, 8)}@t.test`, name: "Applicant" },
    select: { id: true },
  });
}
function validInput(tag: string) {
  return {
    displayName: `Test Store ${tag}`,
    slug: `test-store-${tag}-${Math.random().toString(36).slice(2, 7)}`,
    supportEmail: `store-${tag}@t.test`,
  };
}

async function main() {
  console.log("\nSeller Onboarding Phase 2 — application submission\n");

  // ── static: source-level security / wiring checks ──────────────────────
  const actionsSrc = read("src/lib/seller-onboarding/actions.ts");
  const repoSrc = read("src/lib/seller-onboarding/repository.ts");
  const pageSrc = read("src/app/(shop)/sell-on-axiaro/apply/page.tsx");
  const formSrc = read("src/components/seller-onboarding/apply-form.tsx");

  ok("static · submitSellerApplicationAction calls requireUser() before anything else",
    /export async function submitSellerApplicationAction[\s\S]{0,700}await requireUser\(/.test(actionsSrc) &&
      // and nothing Seller-related happens before that line
      actionsSrc.indexOf("await requireUser(") < actionsSrc.indexOf("submitSellerApplication("));
  ok("static · the action never reads applicantUserId (or userId) from formData — identity is session-only",
    !/formData\.get\(\s*["'](applicantUserId|userId|sellerId)["']\s*\)/.test(actionsSrc));
  ok("static · submitSellerApplication is called with user.id, never a form-derived id",
    /submitSellerApplication\(user\.id,\s*parsed\.data\)/.test(actionsSrc));
  ok("static · the action schedules the EXISTING sendSellerAccountSubmitted (no new template)",
    /scheduleEmail\(\(\) => sendSellerAccountSubmitted\(res\.sellerId\)\)/.test(actionsSrc));
  ok("static · the repository reuses createSeller() rather than a raw seller.create (no duplicated validation)",
    /createSeller\(/.test(repoSrc) && !/\.seller\.create\(/.test(repoSrc));
  ok("static · SellerApplicationInput carries no applicantUserId/userId field — it cannot be spoofed through input",
    (() => {
      const m = repoSrc.match(/export type SellerApplicationInput = \{[\s\S]*?\};/);
      return !!m && !/applicantUserId|userId/.test(m[0]);
    })());
  ok("static · the apply page requires an authenticated user (requireUser) before rendering the form",
    /await requireUser\(/.test(pageSrc));
  // Phase 4 legitimately added a SECOND, separate function
  // (claimSellerOwnerInvite) to this same shared repository file — this
  // checks the narrower, still-true thing: submitSellerApplication ITSELF
  // never references SellerInvite. The Phase 2 action/page/form files are
  // untouched by Phase 4 and still reference it nowhere at all.
  ok("static · submitSellerApplication itself never references SellerInvite (unrelated to Phase 4's claim function elsewhere in the same file)",
    (() => {
      const m = repoSrc.match(/export async function submitSellerApplication[\s\S]*?\n}/);
      return !!m && !/SellerInvite/.test(m[0]);
    })() &&
      !/SellerInvite/.test(actionsSrc) && !/SellerInvite/.test(pageSrc) && !/SellerInvite/.test(formSrc));
  ok("static · no CHANGES_REQUESTED introduced in this phase",
    !/CHANGES_REQUESTED/.test(actionsSrc) && !/CHANGES_REQUESTED/.test(repoSrc));

  // ── DB (rolled back) ─────────────────────────────────────────────────────
  try {
    await prisma.$transaction(async (tx) => {
      const t = Date.now().toString(36);

      // 1 — valid authenticated submission
      const applicantA = await seedApplicant(tx, `a-${t}`);
      const resA = await submitSellerApplication(applicantA.id, validInput(`a-${t}`), tx);
      ok("1 · valid submission succeeds", resA.ok === true, JSON.stringify(resA));
      if (resA.ok) {
        const row = await tx.seller.findUniqueOrThrow({ where: { id: resA.sellerId } });
        ok("1 · Seller starts PENDING", row.status === "PENDING");
        ok("1 · applicantUserId set to the submitting user", row.applicantUserId === applicantA.id);
        ok("1 · type is THIRD_PARTY (never FIRST_PARTY from this path)", row.type === "THIRD_PARTY");
        ok("1 · commissionRate is operator/CMS-derived, not customer-set (createSeller's own default)", typeof row.commissionRate === "number" && row.commissionRate >= 0);
      }

      // 2 — validation: invalid displayName / slug / supportEmail all rejected,
      // exactly the same errors createSeller() already produces (reused, not
      // reimplemented).
      const applicantB = await seedApplicant(tx, `b-${t}`);
      const badName = await submitSellerApplication(applicantB.id, { ...validInput(`b1-${t}`), displayName: "x" }, tx);
      ok("2 · displayName too short → VALIDATION", !badName.ok && badName.code === "VALIDATION", JSON.stringify(badName));
      const badSlug = await submitSellerApplication(applicantB.id, { ...validInput(`b2-${t}`), slug: "Not A Valid Slug!" }, tx);
      ok("2 · invalid slug → VALIDATION", !badSlug.ok && badSlug.code === "VALIDATION", JSON.stringify(badSlug));
      const badEmail = await submitSellerApplication(applicantB.id, { ...validInput(`b3-${t}`), supportEmail: "not-an-email" }, tx);
      ok("2 · invalid supportEmail → VALIDATION", !badEmail.ok && badEmail.code === "VALIDATION", JSON.stringify(badEmail));
      const afterBad = await tx.seller.count({ where: { applicantUserId: applicantB.id } });
      ok("2 · none of the rejected attempts created a Seller row", afterBad === 0);

      // 3 — duplicate protection: PENDING / APPROVED / SUSPENDED all block
      for (const status of SELLER_APPLICATION_IN_PROGRESS_STATUSES) {
        const applicant = await seedApplicant(tx, `dup-${status}-${t}`);
        const first = await submitSellerApplication(applicant.id, validInput(`dup1-${status}-${t}`), tx);
        if (!first.ok) throw new Error(`fixture setup failed for ${status}: ${JSON.stringify(first)}`);
        await tx.seller.update({ where: { id: first.sellerId }, data: { status } });

        const second = await submitSellerApplication(applicant.id, validInput(`dup2-${status}-${t}`), tx);
        ok(`3 · a ${status} application blocks a second submission`,
          !second.ok && second.code === "APPLICATION_IN_PROGRESS", JSON.stringify(second));
        const count = await tx.seller.count({ where: { applicantUserId: applicant.id } });
        ok(`3 · still exactly one Seller row for this ${status} applicant`, count === 1);
      }

      // 3b — CLOSED does NOT block (documented, not silently assumed — see
      // repository.ts's own comment on this exact point).
      const closedApplicant = await seedApplicant(tx, `closed-${t}`);
      const closedFirst = await submitSellerApplication(closedApplicant.id, validInput(`closed1-${t}`), tx);
      if (!closedFirst.ok) throw new Error(`fixture setup failed for CLOSED: ${JSON.stringify(closedFirst)}`);
      await tx.seller.update({ where: { id: closedFirst.sellerId }, data: { status: "CLOSED" } });
      const closedSecond = await submitSellerApplication(closedApplicant.id, validInput(`closed2-${t}`), tx);
      ok("3b · a CLOSED prior application does NOT block a fresh submission (documented, open decision)",
        closedSecond.ok === true, JSON.stringify(closedSecond));

      // 4 — submitted email fires exactly once, idempotent on replay
      const applicantD = await seedApplicant(tx, `d-${t}`);
      const resD = await submitSellerApplication(applicantD.id, validInput(`d-${t}`), tx);
      if (!resD.ok) throw new Error(`fixture setup failed for email test: ${JSON.stringify(resD)}`);
      await sendSellerAccountSubmitted(resD.sellerId, { client: tx });
      const emailCount1 = await tx.emailLog.count({ where: { idempotencyKey: `SELLER_ACCOUNT_SUBMITTED:${resD.sellerId}` } });
      ok("4 · submitted email produced exactly one EmailLog row", emailCount1 === 1);
      await sendSellerAccountSubmitted(resD.sellerId, { client: tx }); // replay
      const emailCount2 = await tx.emailLog.count({ where: { idempotencyKey: `SELLER_ACCOUNT_SUBMITTED:${resD.sellerId}` } });
      ok("4 · replaying the same send is idempotent — still exactly one row", emailCount2 === 1);

      // 5 — applicantUserId cannot be spoofed: the function signature takes the
      // id as its OWN argument, never from the input payload — prove the
      // created row always matches the argument even if a caller tried to
      // sneak a different id-shaped value into the input object.
      const applicantE = await seedApplicant(tx, `e-${t}`);
      const spoofArgs = { ...validInput(`e-${t}`) } as Record<string, unknown>;
      spoofArgs.applicantUserId = "not-the-real-user"; // not a field submitSellerApplication reads
      const resE = await submitSellerApplication(applicantE.id, spoofArgs as { displayName: string; slug: string; supportEmail: string }, tx);
      ok("5 · a stray applicantUserId in the input object is ignored", resE.ok === true);
      if (resE.ok) {
        const rowE = await tx.seller.findUniqueOrThrow({ where: { id: resE.sellerId } });
        ok("5 · applicantUserId always comes from the function argument, never the payload", rowE.applicantUserId === applicantE.id);
      }

      // 6 — existing admin seller creation is unchanged by this phase
      const adminCreated = await createSeller(validInput(`admin-${t}`), tx);
      ok("6 · createSeller() (admin path) still succeeds unchanged", adminCreated.ok === true);
      if (adminCreated.ok) {
        const rowAdmin = await tx.seller.findUniqueOrThrow({ where: { id: adminCreated.sellerId } });
        ok("6 · an admin-created seller has applicantUserId null (no attribution)", rowAdmin.applicantUserId === null);
      }

      // 7 — no SellerInvite touched anywhere in this phase
      ok("7 · zero SellerInvite rows created by any of the above", (await tx.sellerInvite.count()) === 0);

      throw new Rollback();
    }, { timeout: 30_000, maxWait: 15_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("isolation · no fixture User leaked", (await prisma.user.count({ where: { email: { contains: "@t.test" } } })) === 0);
  ok("isolation · no fixture Seller leaked", (await prisma.seller.count({ where: { displayName: { startsWith: "Test Store " } } })) === 0);
  ok("isolation · no fixture EmailLog leaked", (await prisma.emailLog.count({ where: { idempotencyKey: { contains: "SELLER_ACCOUNT_SUBMITTED" } } })) === 0);
  ok("isolation · no fixture SellerInvite leaked", (await prisma.sellerInvite.count()) === 0);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
