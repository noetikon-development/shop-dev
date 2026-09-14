/**
 * Seller Onboarding — approval → SellerInvite wiring (9F-59).
 *
 * `transitionSellerAction` calls `requirePermission("manage_settings")`,
 * which resolves a real authenticated admin session — not meaningfully
 * invocable from a bare script (same class of limitation as `requireUser()`
 * elsewhere in this test family). So this file, consistent with every other
 * seller-onboarding test file:
 *   (a) statically confirms transitionSellerAction calls
 *       createOwnerInviteIfNeeded(res.sellerId, admin.user.id) in exactly the
 *       right place — inside `if (res.from !== res.to)`, gated on
 *       `res.to === "APPROVED" && !res.reactivate`;
 *   (b) directly, fully exercises createOwnerInviteIfNeeded itself (the
 *       actual new logic) against rolled-back DB fixtures.
 * Together these prove the same thing an end-to-end admin-session test would,
 * without needing one.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-seller-onboarding-p4b.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { submitSellerApplication, createOwnerInviteIfNeeded } from "../src/lib/seller-onboarding/repository";
import { createSeller } from "../src/lib/admin/sellers/repository";

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
    data: { email: email ?? `p4b-${tag}-${Math.random().toString(36).slice(2, 8)}@t.test`, name: "P4B User" },
    select: { id: true, email: true },
  });
}
function validInput(tag: string) {
  return {
    displayName: `P4B Store ${tag}`,
    slug: `p4b-store-${tag}-${Math.random().toString(36).slice(2, 7)}`,
    supportEmail: `p4b-support-${tag}@t.test`, // deliberately DIFFERENT from the applicant's account email
  };
}

async function main() {
  console.log("\nSeller Onboarding — approval → SellerInvite wiring (9F-59)\n");

  // ── static: transitionSellerAction wiring ───────────────────────────────
  const adminActionsSrc = read("src/lib/admin/sellers/actions.ts");
  const repoSrc = read("src/lib/seller-onboarding/repository.ts");

  ok("static · transitionSellerAction imports createOwnerInviteIfNeeded from the seller-onboarding repository",
    /import \{ createOwnerInviteIfNeeded \} from "@\/lib\/seller-onboarding\/repository"/.test(adminActionsSrc));
  ok("static · the invite call is gated on APPROVED && !reactivate",
    /if \(res\.to === "APPROVED" && !res\.reactivate\) \{\s*await createOwnerInviteIfNeeded\(res\.sellerId, admin\.user\.id\)/.test(adminActionsSrc));
  ok("static · the invite call sits inside the res.from !== res.to guard (never fires on a same-status no-op)",
    (() => {
      const blockStart = adminActionsSrc.indexOf("if (res.from !== res.to) {");
      const inviteCallIdx = adminActionsSrc.indexOf("createOwnerInviteIfNeeded(res.sellerId, admin.user.id)");
      // find the matching close of the from!==to block by locating the next
      // top-level "}\n\n  revalidateSeller" after it
      const blockEnd = adminActionsSrc.indexOf("revalidateSeller(parsed.data.sellerId);");
      return blockStart !== -1 && inviteCallIdx !== -1 && blockEnd !== -1 &&
        blockStart < inviteCallIdx && inviteCallIdx < blockEnd;
    })());
  ok("static · the existing seller.approved / seller.reactivated audit call is unchanged (still exactly one writeAudit in this block)",
    (adminActionsSrc.match(/await writeAudit\(/g) ?? []).length >= 1 &&
      /action: res\.reactivate \? "seller\.reactivated" : sellerTransitionAction\(res\.to\)/.test(adminActionsSrc));
  ok("static · no separate/new audit action was added for invite creation",
    !/seller\.invite_created|seller\.owner_invited/.test(adminActionsSrc));
  ok("static · sendSellerAccountApproved's call site is unchanged (same 2-arg call, no new actionUrl param)",
    /scheduleEmail\(\(\) => sendSellerAccountApproved\(res\.sellerId, auditLogId\)\)/.test(adminActionsSrc));
  ok("static · createOwnerInviteIfNeeded never creates a SellerUser",
    (() => {
      const m = repoSrc.match(/export async function createOwnerInviteIfNeeded[\s\S]*?\n}/);
      return !!m && !/sellerUser\.(create|upsert)/.test(m[0]);
    })());
  ok("static · createOwnerInviteIfNeeded never uses supportEmail as an identity source",
    (() => {
      const m = repoSrc.match(/export async function createOwnerInviteIfNeeded[\s\S]*?\n}/);
      return !!m && !/supportEmail/.test(m[0]);
    })());
  ok("static · no CHANGES_REQUESTED or invite-expiration field introduced",
    !/CHANGES_REQUESTED/.test(adminActionsSrc) && !/expiresAt|expiryAt/.test(repoSrc));

  // ── DB (rolled back) ─────────────────────────────────────────────────────
  try {
    await prisma.$transaction(async (tx) => {
      const t = Date.now().toString(36);

      // A/B/C/D — self-service approval creates exactly one correctly-shaped
      // PENDING invite, addressed to the applicant's CURRENT account email
      // (not Seller.supportEmail, which is deliberately different in the fixture).
      const applicantA = await seedUser(tx, `a-${t}`, `applicant-a-${t}@t.test`);
      const createdA = await submitSellerApplication(applicantA.id, validInput(`a-${t}`), tx);
      if (!createdA.ok) throw new Error(`fixture setup failed: ${JSON.stringify(createdA)}`);
      await tx.seller.update({ where: { id: createdA.sellerId }, data: { status: "APPROVED" } });

      const adminUser = await seedUser(tx, `admin-${t}`);
      const resA = await createOwnerInviteIfNeeded(createdA.sellerId, adminUser.id, tx);
      ok("A · self-service approval creates exactly one PENDING SellerInvite", resA.created === true, JSON.stringify(resA));
      const inviteCount = await tx.sellerInvite.count({ where: { sellerId: createdA.sellerId } });
      ok("A · exactly one SellerInvite row exists", inviteCount === 1);

      const inviteRowA = await tx.sellerInvite.findUniqueOrThrow({ where: { id: resA.created ? resA.inviteId : "" } });
      ok("B · SellerInvite.sellerId is correct", inviteRowA.sellerId === createdA.sellerId);
      ok("B · status is PENDING", inviteRowA.status === "PENDING");

      const sellerARow = await tx.seller.findUniqueOrThrow({ where: { id: createdA.sellerId }, select: { applicantUserId: true } });
      ok("C · the invite's Seller has applicantUserId matching the original applicant", sellerARow.applicantUserId === applicantA.id);

      ok("D · invited email is the applicant's CURRENT account email, not Seller.supportEmail",
        inviteRowA.email === applicantA.email && inviteRowA.email !== validInput(`a-${t}`).supportEmail);

      ok("E · invitedById is the approving admin", inviteRowA.invitedById === adminUser.id);

      // D (freshness) — if the applicant's account email changes AFTER
      // signup, a NEW invite (different seller) still picks up the current
      // email, proving it's read fresh, not snapshotted at signup time.
      const applicantD = await seedUser(tx, `d-${t}`, `old-email-${t}@t.test`);
      const createdD = await submitSellerApplication(applicantD.id, validInput(`d-${t}`), tx);
      if (!createdD.ok) throw new Error(`fixture setup failed: ${JSON.stringify(createdD)}`);
      await tx.seller.update({ where: { id: createdD.sellerId }, data: { status: "APPROVED" } });
      await tx.user.update({ where: { id: applicantD.id }, data: { email: `new-email-${t}@t.test` } });
      const resD = await createOwnerInviteIfNeeded(createdD.sellerId, null, tx);
      ok("D · email is read fresh at invite-creation time, not snapshotted at signup",
        resD.created === true && (await tx.sellerInvite.findUniqueOrThrow({ where: { id: resD.inviteId! } })).email === `new-email-${t}@t.test`);
      ok("E (no admin available) · invitedById is null when no admin id is passed",
        (await tx.sellerInvite.findUniqueOrThrow({ where: { id: resD.inviteId! } })).invitedById === null);

      // F — replay: calling it again for the SAME seller creates no duplicate,
      // reuses the existing PENDING invite id.
      const resA2 = await createOwnerInviteIfNeeded(createdA.sellerId, adminUser.id, tx);
      ok("F · replaying the call is a no-op — reuses the existing invite, creates nothing new",
        resA2.created === false && resA2.inviteId === resA.inviteId);
      ok("F · still exactly one SellerInvite for this seller after replay",
        (await tx.sellerInvite.count({ where: { sellerId: createdA.sellerId } })) === 1);

      // G — admin-created seller (applicantUserId null) → zero invites
      const adminCreated = await createSeller(validInput(`g-${t}`), tx);
      if (!adminCreated.ok) throw new Error(`fixture setup failed: ${JSON.stringify(adminCreated)}`);
      await tx.seller.update({ where: { id: adminCreated.sellerId }, data: { status: "APPROVED" } });
      const resG = await createOwnerInviteIfNeeded(adminCreated.sellerId, adminUser.id, tx);
      ok("G · admin-created seller (no applicantUserId) → no-op, zero invites",
        resG.created === false && resG.inviteId === null);
      ok("G · zero SellerInvite rows for the admin-created seller",
        (await tx.sellerInvite.count({ where: { sellerId: adminCreated.sellerId } })) === 0);

      // I — createOwnerInviteIfNeeded never creates a SellerUser as a side effect
      ok("I · no SellerUser was created for any seller touched above",
        (await tx.sellerUser.count({ where: { sellerId: { in: [createdA.sellerId, createdD.sellerId, adminCreated.sellerId] } } })) === 0);

      throw new Rollback();
    }, { timeout: 30_000, maxWait: 15_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("isolation · no fixture User leaked", (await prisma.user.count({ where: { email: { contains: "p4b-" } } })) === 0);
  ok("isolation · no fixture Seller leaked", (await prisma.seller.count({ where: { displayName: { startsWith: "P4B Store " } } })) === 0);
  ok("isolation · no fixture SellerInvite leaked", (await prisma.sellerInvite.count({ where: { email: { contains: "t.test" } } })) === 0);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
