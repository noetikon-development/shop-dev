/**
 * Seller Onboarding Phase 4 — OWNER claim/activation only (no invite
 * auto-creation on approval yet — that stays out of scope for this phase).
 *
 * Pattern: static-source checks + one prisma.$transaction ending in
 * `throw new Rollback()` (mirrors test-seller-onboarding-p2/p3).
 *
 * Concurrency note (item H): a single Postgres interactive transaction
 * serializes its own statements on one connection, so two `Promise.all`-fired
 * calls sharing the SAME `tx` don't race in the true multi-connection sense —
 * genuinely parallel, separately-committing transactions would leave rows
 * outside this file's rollback boundary, which conflicts with "isolated/
 * rolled-back tests only". What IS tested here, faithfully, is the actual
 * safety property that matters: the status-guarded `updateMany` on the
 * invite means a second logical claim attempt against the same invite is a
 * clean no-op regardless of how it's triggered — same guarantee, honestly
 * scoped to what a rolled-back single-connection test can prove.
 *
 * requireUser()/requireSellerSession() both call `redirect()`/`forbidden()`,
 * which only behave correctly inside a real Next.js request — so (a) the
 * action's auth-first ordering is checked statically, and (b) "does this
 * user now pass the Seller Portal gate" (item J) is checked by directly
 * querying the same predicate `getSellerSession()` depends on
 * (`SellerUser.status === "ACTIVE"` AND `Seller.status === "APPROVED"`)
 * rather than invoking the cached, request-scoped helper itself.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-seller-onboarding-p4.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { submitSellerApplication, claimSellerOwnerInvite } from "../src/lib/seller-onboarding/repository";

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

async function seedUser(tx: Tx, tag: string) {
  return tx.user.create({
    data: { email: `p4-${tag}-${Math.random().toString(36).slice(2, 8)}@t.test`, name: "P4 User" },
    select: { id: true },
  });
}
function validInput(tag: string) {
  return {
    displayName: `P4 Store ${tag}`,
    slug: `p4-store-${tag}-${Math.random().toString(36).slice(2, 7)}`,
    supportEmail: `p4-store-${tag}@t.test`,
  };
}
/** Seed an APPROVED seller for `applicantUserId`, optionally with a
 *  SellerInvite in the given status (and, for ACCEPTED, the SellerUser a
 *  real prior successful claim would have also created — so the fixture
 *  matches a state the real code could actually produce). */
async function seedApprovedSeller(
  tx: Tx,
  applicantUserId: string,
  tag: string,
  invite?: "PENDING" | "ACCEPTED" | "REVOKED",
) {
  const created = await submitSellerApplication(applicantUserId, validInput(tag), tx);
  if (!created.ok) throw new Error(`fixture setup failed: ${JSON.stringify(created)}`);
  await tx.seller.update({ where: { id: created.sellerId }, data: { status: "APPROVED" } });

  let inviteId: string | null = null;
  if (invite) {
    const row = await tx.sellerInvite.create({
      data: {
        sellerId: created.sellerId,
        email: `p4-invite-${tag}@t.test`,
        status: invite,
        ...(invite === "ACCEPTED" ? { acceptedByUserId: applicantUserId, acceptedAt: new Date() } : {}),
      },
      select: { id: true },
    });
    inviteId = row.id;
    if (invite === "ACCEPTED") {
      // A real ACCEPTED invite implies a real prior claim already created the
      // SellerUser — seed both together so the fixture is internally
      // consistent with what the actual code can produce.
      await tx.sellerUser.create({
        data: { sellerId: created.sellerId, userId: applicantUserId, role: "OWNER", status: "ACTIVE" },
      });
    }
  }
  return { sellerId: created.sellerId, inviteId };
}

async function main() {
  console.log("\nSeller Onboarding Phase 4 — OWNER claim/activation\n");

  // ── static: source-level security / scope checks ────────────────────────
  const repoSrc = read("src/lib/seller-onboarding/repository.ts");
  const actionsSrc = read("src/lib/seller-onboarding/actions.ts");
  const pageSrc = read("src/app/(shop)/sell-on-axiaro/status/page.tsx");
  const buttonSrc = read("src/components/seller-onboarding/claim-owner-button.tsx");
  const adminSellersActionsSrc = read("src/lib/admin/sellers/actions.ts");

  ok("static · claimSellerOwnerInviteAction calls requireUser() before anything else",
    /export async function claimSellerOwnerInviteAction[\s\S]{0,300}await requireUser\(/.test(actionsSrc) &&
      actionsSrc.indexOf("await requireUser(\"/sell-on-axiaro/status\")") < actionsSrc.lastIndexOf("claimSellerOwnerInvite(user.id)"));
  ok("static · claimSellerOwnerInviteAction reads no id of any kind from formData",
    (() => {
      const m = actionsSrc.match(/export async function claimSellerOwnerInviteAction[\s\S]*?\n}/);
      return !!m && !/formData\.get\(/.test(m[0]);
    })());
  ok("static · claimSellerOwnerInvite takes userId as its only identity input (no sellerId/inviteId params)",
    /export async function claimSellerOwnerInvite\(\s*userId: string,\s*client/.test(repoSrc));
  ok("static · claimSellerOwnerInvite never matches by email",
    (() => {
      const m = repoSrc.match(/export async function claimSellerOwnerInvite[\s\S]*$/);
      return !!m && !/where:\s*\{[^}]*email/.test(m[0]);
    })());
  ok("static · the claim button form has no input fields to spoof an id through",
    !/<input/.test(buttonSrc) && !/formData\.get\(/.test(buttonSrc));
  ok("static · the status page never shows a claim URL, invite id, or raw Seller id",
    !/\/claim\//.test(pageSrc) && !/app\.inviteId|app\.sellerId|app\.id\b/.test(pageSrc));
  // A later, separate, explicitly-requested task (9F-59) legitimately wired
  // transitionSellerAction to createOwnerInviteIfNeeded on first-time
  // approval — this phase's OWN scope (the claim side) never touched that
  // file, and still doesn't create a SellerUser directly there; that
  // invariant is still meaningful and still true.
  ok("static · admin/sellers/actions.ts never creates a SellerUser directly (invite creation, added later, only ever creates a SellerInvite)",
    !/\.sellerUser\.(create|upsert)\(/.test(adminSellersActionsSrc));

  // ── DB (rolled back) ─────────────────────────────────────────────────────
  try {
    await prisma.$transaction(async (tx) => {
      const t = Date.now().toString(36);

      // A — successful claim
      const userA = await seedUser(tx, `a-${t}`);
      const { sellerId: sellerA, inviteId: inviteA } = await seedApprovedSeller(tx, userA.id, `a-${t}`, "PENDING");
      const resA = await claimSellerOwnerInvite(userA.id, tx);
      ok("A · successful claim returns SUCCESS", resA.ok === true && resA.code === "SUCCESS", JSON.stringify(resA));
      const suA = await tx.sellerUser.findUnique({ where: { sellerId_userId: { sellerId: sellerA, userId: userA.id } } });
      ok("A · exactly one ACTIVE OWNER SellerUser created", suA?.role === "OWNER" && suA?.status === "ACTIVE");
      const inviteRowA = await tx.sellerInvite.findUniqueOrThrow({ where: { id: inviteA! } });
      ok("A · invite marked ACCEPTED with acceptedByUserId + acceptedAt set",
        inviteRowA.status === "ACCEPTED" && inviteRowA.acceptedByUserId === userA.id && inviteRowA.acceptedAt !== null);
      const auditA = await tx.adminAuditLog.findFirst({ where: { action: "seller.owner_claimed", targetType: "seller_user", actorUserId: userA.id } });
      ok("A · exactly one seller.owner_claimed audit row, correctly attributed",
        !!auditA && JSON.parse(auditA.meta).sellerId === sellerA && JSON.parse(auditA.meta).inviteId === inviteA);

      // B — wrong user: a different authenticated user has no application of
      // their own, so they can never reach userA's Seller or invite at all.
      const userB = await seedUser(tx, `b-${t}`);
      const { sellerId: sellerB, inviteId: inviteB } = await seedApprovedSeller(tx, userB.id, `wrong-${t}`, "PENDING");
      const stranger = await seedUser(tx, `stranger-${t}`);
      const strangerResult = await claimSellerOwnerInvite(stranger.id, tx);
      ok("B · a user with no application of their own gets NOT_ELIGIBLE",
        !strangerResult.ok && strangerResult.code === "NOT_ELIGIBLE", JSON.stringify(strangerResult));
      const inviteBUnchanged = await tx.sellerInvite.findUniqueOrThrow({ where: { id: inviteB! } });
      ok("B · the other applicant's invite is untouched (still PENDING)", inviteBUnchanged.status === "PENDING");
      ok("B · no SellerUser created for the stranger", (await tx.sellerUser.count({ where: { sellerId: sellerB } })) === 0);

      // C — no invite at all
      const userC = await seedUser(tx, `c-${t}`);
      await seedApprovedSeller(tx, userC.id, `c-${t}`); // approved, no invite
      const resC = await claimSellerOwnerInvite(userC.id, tx);
      ok("C · APPROVED with no invite → NO_PENDING_INVITE", !resC.ok && resC.code === "NO_PENDING_INVITE", JSON.stringify(resC));
      ok("C · no SellerUser created", (await tx.sellerUser.count({ where: { userId: userC.id } })) === 0);

      // D — Seller no longer APPROVED (SUSPENDED and REJECTED both fail safely)
      for (const badStatus of ["SUSPENDED", "REJECTED"] as const) {
        const userD = await seedUser(tx, `d-${badStatus}-${t}`);
        const { sellerId: sellerD } = await seedApprovedSeller(tx, userD.id, `d-${badStatus}-${t}`, "PENDING");
        await tx.seller.update({ where: { id: sellerD }, data: { status: badStatus } });
        const resD = await claimSellerOwnerInvite(userD.id, tx);
        ok(`D · Seller ${badStatus} → NOT_ELIGIBLE`, !resD.ok && resD.code === "NOT_ELIGIBLE", JSON.stringify(resD));
        ok(`D · no SellerUser created for ${badStatus} seller`, (await tx.sellerUser.count({ where: { sellerId: sellerD } })) === 0);
      }

      // E — already accepted (a real prior claim already happened)
      const userE = await seedUser(tx, `e-${t}`);
      const { sellerId: sellerE } = await seedApprovedSeller(tx, userE.id, `e-${t}`, "ACCEPTED");
      const resE = await claimSellerOwnerInvite(userE.id, tx);
      ok("E · re-claiming an already-accepted invite → ALREADY_CLAIMED, not an error",
        resE.ok === true && resE.code === "ALREADY_CLAIMED", JSON.stringify(resE));
      ok("E · still exactly one SellerUser (no duplicate)", (await tx.sellerUser.count({ where: { sellerId: sellerE } })) === 1);

      // F — revoked invite
      const userF = await seedUser(tx, `f-${t}`);
      const { sellerId: sellerF } = await seedApprovedSeller(tx, userF.id, `f-${t}`, "REVOKED");
      const resF = await claimSellerOwnerInvite(userF.id, tx);
      ok("F · a REVOKED invite is never claimable (NO_PENDING_INVITE — excluded from the PENDING-only query)",
        !resF.ok && resF.code === "NO_PENDING_INVITE", JSON.stringify(resF));
      ok("F · no SellerUser created", (await tx.sellerUser.count({ where: { sellerId: sellerF } })) === 0);

      // G — replay: call twice, exactly one SellerUser + one audit row
      const userG = await seedUser(tx, `g-${t}`);
      const { sellerId: sellerG } = await seedApprovedSeller(tx, userG.id, `g-${t}`, "PENDING");
      const resG1 = await claimSellerOwnerInvite(userG.id, tx);
      const resG2 = await claimSellerOwnerInvite(userG.id, tx);
      ok("G · first call SUCCESS, second call ALREADY_CLAIMED (safe, idempotent)",
        resG1.ok && resG1.code === "SUCCESS" && resG2.ok && resG2.code === "ALREADY_CLAIMED");
      ok("G · exactly one SellerUser after replay", (await tx.sellerUser.count({ where: { sellerId: sellerG } })) === 1);
      ok("G · exactly one seller.owner_claimed audit row after replay",
        (await tx.adminAuditLog.count({ where: { action: "seller.owner_claimed", targetType: "seller_user", meta: { contains: sellerG } } })) === 1);

      // H — "concurrency" (see file header for the honest scope of this)
      const userH = await seedUser(tx, `h-${t}`);
      const { sellerId: sellerH } = await seedApprovedSeller(tx, userH.id, `h-${t}`, "PENDING");
      const [h1, h2] = await Promise.all([
        claimSellerOwnerInvite(userH.id, tx),
        claimSellerOwnerInvite(userH.id, tx),
      ]);
      const successes = [h1, h2].filter((r) => r.ok && r.code === "SUCCESS").length;
      ok("H · exactly one of two simultaneous claim attempts reports SUCCESS", successes === 1, JSON.stringify([h1, h2]));
      ok("H · exactly one ACTIVE OWNER SellerUser exists afterward", (await tx.sellerUser.count({ where: { sellerId: sellerH, status: "ACTIVE" } })) === 1);
      ok("H · exactly one invite acceptance took effect (no double-accept)",
        (await tx.sellerInvite.count({ where: { sellerId: sellerH, status: "ACCEPTED" } })) === 1);

      // J — Seller Portal gate transition. requireSellerSession()/
      // getSellerSession() call redirect()/use React's request-scoped
      // cache() — not meaningful to invoke directly from a bare script (see
      // file header) — so this checks the exact predicate they're built on.
      const userJ = await seedUser(tx, `j-${t}`);
      const { sellerId: sellerJ } = await seedApprovedSeller(tx, userJ.id, `j-${t}`, "PENDING");
      const beforeClaim = await tx.sellerUser.findUnique({ where: { sellerId_userId: { sellerId: sellerJ, userId: userJ.id } } });
      ok("J · before claim, no ACTIVE SellerUser exists — the portal gate's predicate is false", beforeClaim === null);
      await claimSellerOwnerInvite(userJ.id, tx);
      const afterClaim = await tx.sellerUser.findUnique({ where: { sellerId_userId: { sellerId: sellerJ, userId: userJ.id } } });
      const sellerJRow = await tx.seller.findUniqueOrThrow({ where: { id: sellerJ }, select: { status: true } });
      ok("J · after claim, an ACTIVE SellerUser exists on an APPROVED Seller — the portal gate's predicate is now true",
        afterClaim?.status === "ACTIVE" && sellerJRow.status === "APPROVED");

      // K — no approval-side effects: approving a self-service application
      // through ANY path in this phase must never auto-create a SellerInvite.
      const userK = await seedUser(tx, `k-${t}`);
      const createdK = await submitSellerApplication(userK.id, validInput(`k-${t}`), tx);
      if (!createdK.ok) throw new Error(`fixture setup failed: ${JSON.stringify(createdK)}`);
      await tx.seller.update({ where: { id: createdK.sellerId }, data: { status: "APPROVED" } });
      ok("K · approving a seller creates zero SellerInvite rows in this phase",
        (await tx.sellerInvite.count({ where: { sellerId: createdK.sellerId } })) === 0);

      throw new Rollback();
    }, { timeout: 30_000, maxWait: 15_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("isolation · no fixture User leaked", (await prisma.user.count({ where: { email: { contains: "p4-" } } })) === 0);
  ok("isolation · no fixture Seller leaked", (await prisma.seller.count({ where: { displayName: { startsWith: "P4 Store " } } })) === 0);
  ok("isolation · no fixture AdminAuditLog leaked", (await prisma.adminAuditLog.count({ where: { action: "seller.owner_claimed" } })) === 0);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
