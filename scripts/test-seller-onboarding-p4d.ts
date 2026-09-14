/**
 * Seller Onboarding — first-time self-service approval email CTA fix (9F-61).
 *
 * Bug: after eec1672 fixed the RECIPIENT of `seller_account_approved` for a
 * first-time self-service seller, the email's own call-to-action still
 * pointed at `/seller/login` — a real HTTP 403 for that exact seller, since
 * no SellerUser exists until they claim their PENDING SellerInvite from
 * `/sell-on-axiaro/status` (`src/app/seller/(portal)/layout.tsx`'s
 * `getSellerSession()` → `forbidden()`). Fix: `sendSellerAccountApproved`
 * now computes a local `actionUrl` that defaults to `ctx.portalUrl`
 * (`/seller/login`, unchanged) and is overridden to
 * `${siteUrl}/sell-on-axiaro/status` ONLY when: never a reactivation, AND
 * `Seller.applicantUserId` is set, AND no ACTIVE SellerUser exists yet.
 * Neither the hardcoded template (`templates/seller-lifecycle.ts`) nor the
 * CMS registry (`template-registry.ts`) were touched — both still receive
 * whatever `actionUrl` this function computes.
 *
 * `EmailLog` never stores the rendered HTML/text (only recipient/subject), so
 * the actual embedded URL can't be read back from the DB after a real send.
 * Consistent with this test family's established approach for logic that
 * can't be observed end-to-end (e.g. p4b's static wiring checks for
 * `requirePermission`-gated code): this file (a) precisely matches the exact
 * conditional source in `sendSellerAccountApproved` via static regex, (b)
 * drives the REAL function against DB fixtures whose membership/applicant
 * state exactly matches each branch of that condition and confirms it
 * dispatches successfully with the correct recipient, and (c) proves the
 * CMS-override renderer (`renderEmailTemplateOverride`, a pure function)
 * honors whatever `actionUrl` it's given — closing the loop between "the
 * condition picks the right URL" and "whichever URL it picks reaches both
 * the hardcoded AND the CMS-overridden render path".
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-seller-onboarding-p4d.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { submitSellerApplication } from "../src/lib/seller-onboarding/repository";
import { createSeller } from "../src/lib/admin/sellers/repository";
import { sendSellerAccountApproved } from "../src/lib/email/notifications";
import { renderEmailTemplateOverride } from "../src/lib/email/template-overrides";

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
    data: { email: email ?? `p4d-${tag}-${Math.random().toString(36).slice(2, 8)}@t.test`, name: "P4D User" },
    select: { id: true, email: true },
  });
}
function validInput(tag: string) {
  return {
    displayName: `P4D Store ${tag}`,
    slug: `p4d-store-${tag}-${Math.random().toString(36).slice(2, 7)}`,
    supportEmail: `p4d-support-${tag}@t.test`,
  };
}
async function auditRow(tx: Tx, action: string, actorUserId: string, sellerId: string) {
  return tx.adminAuditLog.create({
    data: { actorUserId, action, targetType: "seller", targetId: sellerId, summary: "test fixture" },
    select: { id: true },
  });
}

async function main() {
  console.log("\nSeller Onboarding — approval email CTA fix (9F-61)\n");

  // ── static: the fix is scoped to sendSellerAccountApproved only ────────
  const notifSrc = read("src/lib/email/notifications.ts");
  const fnMatch = notifSrc.match(/export async function sendSellerAccountApproved[\s\S]*?\r?\n  \}\r?\n\}/);
  ok("static · sendSellerAccountApproved was matched", !!fnMatch);
  const fnSrc = fnMatch ? fnMatch[0] : "";

  ok("static · actionUrl defaults to ctx.portalUrl", /let actionUrl = ctx\.portalUrl;/.test(fnSrc));
  ok("static · the override is gated on !reactivate (reactivation always keeps the default)",
    /if \(!reactivate\) \{[\s\S]*?applicantUserId/.test(fnSrc));
  ok("static · applicantUserId is read fresh from Seller, not from ctx",
    /db\.seller\.findUnique\(\{ where: \{ id: sellerId \}, select: \{ applicantUserId: true \} \}\)/.test(fnSrc));
  ok("static · ACTIVE membership is checked via SellerUser.findFirst, not cached from loadSellerLifecycleEmailContext",
    /db\.sellerUser\.findFirst\(\{\s*where: \{ sellerId, status: "ACTIVE" \}/.test(fnSrc));
  ok("static · the status-page URL is only assigned inside the !activeMembership branch",
    /if \(!activeMembership\) actionUrl = `\$\{ctx\.siteUrl\}\/sell-on-axiaro\/status`;/.test(fnSrc));
  ok("static · the SAME actionUrl variable feeds both the CMS-override path (templateActionUrl) and the hardcoded template (portalUrl) — they can never diverge",
    /templateActionUrl: actionUrl,/.test(fnSrc) && /portalUrl: actionUrl,/.test(fnSrc));
  ok("static · templateTokens.actionUrl also uses the same computed value",
    /templateTokens: \{ sellerName: ctx\.sellerName, actionUrl \},/.test(fnSrc));
  ok("static · no mutation of SellerInvite or SellerUser inside this function (read-only membership check)",
    !/sellerInvite\.(create|update|upsert|delete)/.test(fnSrc) && !/sellerUser\.(create|update|upsert|delete)/.test(fnSrc));

  // ── static: the template + CMS registry were NOT touched by this fix ───
  const templateSrc = read("src/lib/email/templates/seller-lifecycle.ts");
  ok("static · the hardcoded template file has no knowledge of the status-page URL (redirect logic lives only in notifications.ts)",
    !/sell-on-axiaro\/status/.test(templateSrc));
  ok("static · renderSellerAccountApproved's token contract is unchanged (still SellerBase & { reactivate: boolean })",
    /export function renderSellerAccountApproved\(d: SellerBase & \{ reactivate: boolean \}\)/.test(templateSrc));

  const registrySrc = read("src/lib/email/template-registry.ts");
  ok("static · seller_account_approved's CMS registry entry is unchanged (still sellerName + actionUrl, no new token)",
    /t\("seller_account_approved", "Seller application approved", "seller_lifecycle",\s*\n\s*"Sent when an application \(or a reactivated account\) is approved\."\,\s*\n\s*\["sellerName", "actionUrl"\]\)/.test(registrySrc));

  // ── E — the CMS-override renderer honors whatever actionUrl it's given ──
  // Pure-function check, no DB: proves the override mechanism itself does not
  // hardcode /seller/login anywhere — whichever URL sendSellerAccountApproved
  // computes (proven above to be the SAME value on both paths) is what a
  // published override would actually render.
  const override = { subject: "", heading: "", body: "", extraMessage: "", actionLabel: "" };
  const loginRender = renderEmailTemplateOverride({
    templateKey: "seller_account_approved",
    override,
    brand: "Axiaro",
    siteUrl: "https://axiaro.test",
    tokenValues: { sellerName: "Test Co", actionUrl: "https://axiaro.test/seller/login" },
    fallback: { subject: "s", heading: "h", body: "b", actionLabel: "Go" },
    actionUrl: "https://axiaro.test/seller/login",
  });
  const statusRender = renderEmailTemplateOverride({
    templateKey: "seller_account_approved",
    override,
    brand: "Axiaro",
    siteUrl: "https://axiaro.test",
    tokenValues: { sellerName: "Test Co", actionUrl: "https://axiaro.test/sell-on-axiaro/status" },
    fallback: { subject: "s", heading: "h", body: "b", actionLabel: "Go" },
    actionUrl: "https://axiaro.test/sell-on-axiaro/status",
  });
  ok("E · the CMS-override render embeds /seller/login when given that actionUrl",
    loginRender.html.includes("https://axiaro.test/seller/login") && loginRender.text.includes("https://axiaro.test/seller/login"));
  ok("E · the CMS-override render embeds /sell-on-axiaro/status when given THAT actionUrl instead",
    statusRender.html.includes("https://axiaro.test/sell-on-axiaro/status") && statusRender.text.includes("https://axiaro.test/sell-on-axiaro/status"));
  ok("E · the two renders differ — the override path is not hardcoded to one URL",
    loginRender.html !== statusRender.html);

  // ── DB (rolled back) ─────────────────────────────────────────────────────
  try {
    await prisma.$transaction(async (tx) => {
      const t = Date.now().toString(36);
      const admin = await seedUser(tx, `admin-${t}`);

      // A — first-time self-service approval: applicantUserId set, never
      // reactivated, zero ACTIVE SellerUser rows → this is exactly the
      // condition the fix targets.
      const applicantA = await seedUser(tx, `a-${t}`, `applicant-a-${t}@t.test`);
      const createdA = await submitSellerApplication(applicantA.id, validInput(`a-${t}`), tx);
      if (!createdA.ok) throw new Error(`fixture setup failed (A): ${JSON.stringify(createdA)}`);
      await tx.seller.update({ where: { id: createdA.sellerId }, data: { status: "APPROVED" } });
      const sellerA = await tx.seller.findUniqueOrThrow({ where: { id: createdA.sellerId }, select: { applicantUserId: true } });
      const activeA = await tx.sellerUser.count({ where: { sellerId: createdA.sellerId, status: "ACTIVE" } });
      ok("A · precondition — applicantUserId is set", sellerA.applicantUserId === applicantA.id);
      ok("A · precondition — zero ACTIVE SellerUser rows exist yet", activeA === 0);
      const auditA = await auditRow(tx, "seller.approved", admin.id, createdA.sellerId);
      const resA = await sendSellerAccountApproved(createdA.sellerId, auditA.id, { client: tx });
      ok("A · dispatch succeeds (not FAILED) — per the static wiring above this used /sell-on-axiaro/status",
        resA.status === "SENT" || resA.status === "SKIPPED", JSON.stringify(resA));
      const logA = await tx.emailLog.findUnique({
        where: { idempotencyKey: `SELLER_ACCOUNT_APPROVED:${createdA.sellerId}:${auditA.id}` },
      });
      ok("A · recipient is still the applicant's current account email (eec1672 unaffected by this fix)",
        !!logA && logA.recipient === applicantA.email.toLowerCase());

      // B — already-active seller (has an ACTIVE OWNER SellerUser), first
      // (non-reactivation) approval → per the static wiring, actionUrl stays
      // ctx.portalUrl (/seller/login), the existing behavior.
      const applicantB = await seedUser(tx, `b-${t}`, `applicant-b-${t}@t.test`);
      const memberB = await seedUser(tx, `b-member-${t}`, `member-b-${t}@t.test`);
      const createdB = await submitSellerApplication(applicantB.id, validInput(`b-${t}`), tx);
      if (!createdB.ok) throw new Error(`fixture setup failed (B): ${JSON.stringify(createdB)}`);
      await tx.sellerUser.create({
        data: { sellerId: createdB.sellerId, userId: memberB.id, role: "OWNER", status: "ACTIVE" },
      });
      await tx.seller.update({ where: { id: createdB.sellerId }, data: { status: "APPROVED" } });
      const activeB = await tx.sellerUser.count({ where: { sellerId: createdB.sellerId, status: "ACTIVE" } });
      ok("B · precondition — an ACTIVE SellerUser already exists", activeB === 1);
      const auditB = await auditRow(tx, "seller.approved", admin.id, createdB.sellerId);
      const resB = await sendSellerAccountApproved(createdB.sellerId, auditB.id, { client: tx });
      ok("B · dispatch succeeds — per the static wiring above this kept /seller/login (unchanged)",
        resB.status === "SENT" || resB.status === "SKIPPED", JSON.stringify(resB));
      const logB = await tx.emailLog.findUnique({
        where: { idempotencyKey: `SELLER_ACCOUNT_APPROVED:${createdB.sellerId}:${auditB.id}` },
      });
      ok("B · recipient is the existing ACTIVE member, precedence unchanged",
        !!logB && logB.recipient === memberB.email.toLowerCase());

      // C — SUSPENDED→APPROVED reactivation, with NO ACTIVE SellerUser at all
      // (an approved-but-never-claimed seller that got suspended, then
      // reactivated) — the sharpest test of the reactivate short-circuit:
      // even though membership state alone would otherwise trigger the
      // status-page redirect, `reactivate` must override that unconditionally.
      const applicantC = await seedUser(tx, `c-${t}`, `applicant-c-${t}@t.test`);
      const createdC = await submitSellerApplication(applicantC.id, validInput(`c-${t}`), tx);
      if (!createdC.ok) throw new Error(`fixture setup failed (C): ${JSON.stringify(createdC)}`);
      await tx.seller.update({ where: { id: createdC.sellerId }, data: { status: "APPROVED" } });
      await tx.seller.update({ where: { id: createdC.sellerId }, data: { status: "SUSPENDED" } });
      await tx.seller.update({ where: { id: createdC.sellerId }, data: { status: "APPROVED" } });
      const activeC = await tx.sellerUser.count({ where: { sellerId: createdC.sellerId, status: "ACTIVE" } });
      ok("C · precondition — zero ACTIVE SellerUser rows (never claimed before being suspended)", activeC === 0);
      const auditC = await auditRow(tx, "seller.reactivated", admin.id, createdC.sellerId);
      const resC = await sendSellerAccountApproved(createdC.sellerId, auditC.id, { client: tx });
      ok("C · dispatch does not fail on reactivation despite zero active membership",
        resC.status !== "FAILED", JSON.stringify(resC));
      // recipient falls back to the applicant (eec1672) since there is still
      // no member/notifyEmail — proving reactivate only affects the CTA
      // branch (this fix), never the recipient-resolution fix (eec1672).
      const logC = await tx.emailLog.findUnique({
        where: { idempotencyKey: `SELLER_ACCOUNT_APPROVED:${createdC.sellerId}:${auditC.id}` },
      });
      ok("C · recipient still resolves via eec1672's applicant fallback (unaffected by this fix)",
        !!logC && logC.recipient === applicantC.email.toLowerCase());

      // D — admin-created seller (applicantUserId null), approved via the
      // existing notifyEmail fallback → per the static wiring, the
      // `if (seller?.applicantUserId)` check fails immediately regardless of
      // membership state, so actionUrl stays ctx.portalUrl unconditionally.
      const inputD = validInput(`d-${t}`);
      const createdD = await createSeller(inputD, tx);
      if (!createdD.ok) throw new Error(`fixture setup failed (D): ${JSON.stringify(createdD)}`);
      const notifyD = `notify-d-${t}@t.test`;
      await tx.seller.update({ where: { id: createdD.sellerId }, data: { status: "APPROVED", notifyEmail: notifyD } });
      const sellerD = await tx.seller.findUniqueOrThrow({ where: { id: createdD.sellerId }, select: { applicantUserId: true } });
      ok("D · precondition — admin-created seller has no applicantUserId", sellerD.applicantUserId === null);
      const auditD = await auditRow(tx, "seller.approved", admin.id, createdD.sellerId);
      const resD = await sendSellerAccountApproved(createdD.sellerId, auditD.id, { client: tx });
      ok("D · dispatch succeeds — admin-created behavior is completely unaffected by this fix",
        resD.status === "SENT" || resD.status === "SKIPPED", JSON.stringify(resD));
      const logD = await tx.emailLog.findUnique({
        where: { idempotencyKey: `SELLER_ACCOUNT_APPROVED:${createdD.sellerId}:${auditD.id}` },
      });
      ok("D · recipient is the existing notifyEmail fallback, unchanged", !!logD && logD.recipient === notifyD.toLowerCase());

      // F/G — EmailLog idempotency / no duplicate on replay (reusing scenario A).
      const beforeCount = await tx.emailLog.count({
        where: { idempotencyKey: `SELLER_ACCOUNT_APPROVED:${createdA.sellerId}:${auditA.id}` },
      });
      const resAReplay = await sendSellerAccountApproved(createdA.sellerId, auditA.id, { client: tx });
      const afterCount = await tx.emailLog.count({
        where: { idempotencyKey: `SELLER_ACCOUNT_APPROVED:${createdA.sellerId}:${auditA.id}` },
      });
      ok("F · idempotency key is unique — replay does not create a second EmailLog row",
        beforeCount === 1 && afterCount === 1, `before=${beforeCount} after=${afterCount}`);
      ok("G · replaying approval is deduped, not re-dispatched", resAReplay.status === "DEDUPED", JSON.stringify(resAReplay));

      // H — this fix never creates SellerInvite/SellerUser rows itself (it
      // only READS SellerUser to decide the CTA). Every SellerUser row
      // present at this point was created explicitly by fixture setup above
      // (scenario B/C's memberships), never as a side effect of any
      // sendSellerAccountApproved call.
      const sellerUserTotal = await tx.sellerUser.count({
        where: { sellerId: { in: [createdA.sellerId, createdB.sellerId, createdC.sellerId, createdD.sellerId] } },
      });
      ok("H · SellerUser rows equal exactly what fixture setup created (1, from scenario B) — none from sendSellerAccountApproved itself",
        sellerUserTotal === 1, `total=${sellerUserTotal}`);
      const inviteTotal = await tx.sellerInvite.count({
        where: { sellerId: { in: [createdA.sellerId, createdB.sellerId, createdC.sellerId, createdD.sellerId] } },
      });
      ok("H · zero SellerInvite rows created — this fix never touches invite creation", inviteTotal === 0);

      throw new Rollback();
    }, { timeout: 30_000, maxWait: 15_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("isolation · no fixture User leaked", (await prisma.user.count({ where: { email: { contains: "p4d-" } } })) === 0);
  ok("isolation · no fixture Seller leaked", (await prisma.seller.count({ where: { displayName: { startsWith: "P4D Store " } } })) === 0);
  ok("isolation · no fixture EmailLog leaked",
    (await prisma.emailLog.count({ where: { idempotencyKey: { contains: "SELLER_ACCOUNT_APPROVED" }, recipient: { contains: "t.test" } } })) === 0);
  ok("isolation · no fixture AdminAuditLog leaked", (await prisma.adminAuditLog.count({ where: { summary: "test fixture" } })) === 0);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
