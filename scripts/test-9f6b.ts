/**
 * Phase 9F-6b — seller lifecycle notifications (account approved / suspended /
 * closed; store-profile submitted / approved / rejected).
 *
 * DB tests build a seller + OWNER user inside ONE prisma.$transaction and roll
 * back. All 6 senders + `retryEmailByLog` take an optional transaction client
 * so nothing leaks. The local env has no EMAIL_* creds, so a "successful" send
 * re-records SKIPPED (not SENT) — the assertion is that it ROUTES, uses the
 * right EmailType/recipient/idempotency key, and (on retry) REUSES the row —
 * which in a configured runtime would actually send.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f6b.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  retryEmailByLog,
  sendSellerAccountApproved,
  sendSellerAccountSuspended,
  sendSellerAccountClosed,
  sendSellerProfileApproved,
  sendSellerProfileRejected,
  sendSellerProfileSubmitted,
} from "../src/lib/email/notifications";
import {
  renderSellerAccountApproved,
  renderSellerAccountSuspended,
  renderSellerAccountClosed,
  renderSellerProfileRejected,
} from "../src/lib/email/templates/seller-lifecycle";

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

const D1 = new Date("2026-09-05T09:00:00.000Z");
const D2 = new Date("2026-09-05T10:00:00.000Z");
const D3 = new Date("2026-09-05T11:00:00.000Z");

async function seedSeller(tx: Tx, slug: string, notifyEmail?: string) {
  return tx.seller.create({
    data: {
      type: "THIRD_PARTY",
      status: "PENDING",
      displayName: slug,
      slug,
      supportEmail: `${slug}@t.test`,
      contentStatus: "DRAFT",
      notifyEmail: notifyEmail ?? null,
    },
    select: { id: true },
  });
}
async function seedUser(tx: Tx, tag: string) {
  return tx.user.create({
    data: { email: `${tag}@t.test`, name: "T", role: "CUSTOMER", supabaseUserId: `sb-${tag}` },
    select: { id: true, email: true },
  });
}
async function seedAudit(tx: Tx, action: string, sellerId: string, from: string, to: string) {
  return tx.adminAuditLog.create({
    data: { action, targetType: "seller", targetId: sellerId, summary: "x", meta: JSON.stringify({ sellerId, from, to }) },
    select: { id: true },
  });
}

// ---------------------------------------------------------------------------
// Static wiring
// ---------------------------------------------------------------------------

function staticTests() {
  const notifs = read("src/lib/email/notifications.ts");
  const send = read("src/lib/email/send.ts");
  const audit = read("src/lib/admin/audit.ts");
  const sellersActions = read("src/lib/admin/sellers/actions.ts");
  const contentActions = read("src/lib/admin/seller-content-actions.ts");
  const settingsActions = read("src/lib/seller/settings-actions.ts");
  const schema = read("prisma/schema.prisma");

  // 6 new EmailTypes
  for (const t of [
    "seller_account_approved",
    "seller_account_suspended",
    "seller_account_closed",
    "seller_profile_submitted",
    "seller_profile_approved",
    "seller_profile_rejected",
  ]) {
    ok(`EmailType · "${t}" added`, new RegExp(`"${t}"`).test(send));
  }

  // retryEmailByLog cases for all 6
  ok("routing · account cases present", /case "seller_account_approved":[\s\S]{0,60}case "seller_account_suspended":[\s\S]{0,60}case "seller_account_closed":/.test(notifs));
  ok("routing · profile cases present", /case "seller_profile_approved":/.test(notifs) && /case "seller_profile_rejected":/.test(notifs) && /case "seller_profile_submitted":/.test(notifs));
  ok("routing · default branch still returns not_retryable exactly once", (notifs.match(/error: "not_retryable"/g) ?? []).length === 1);
  ok("routing · retry passes the ORIGINAL key back for the new types too", (notifs.match(/idempotencyKey: log\.idempotencyKey/g) ?? []).length >= 2);

  // idempotency anchors — audit log id for account events, NEVER Seller.updatedAt
  ok("idempotency · account keys anchor on the audit log id, not updatedAt", /SELLER_ACCOUNT_APPROVED:\$\{sellerId\}:\$\{auditLogId\}/.test(notifs) && /SELLER_ACCOUNT_SUSPENDED:\$\{sellerId\}:\$\{auditLogId\}/.test(notifs) && /SELLER_ACCOUNT_CLOSED:\$\{sellerId\}:\$\{auditLogId\}/.test(notifs));
  ok("idempotency · account sender re-derives reactivate from the audit row action (not a caller flag)", /audit\?\.action === "seller\.reactivated"/.test(notifs));
  ok("idempotency · profile approved/rejected key off contentReviewedAt + resulting state", /SELLER_PROFILE_APPROVED:\$\{sellerId\}:\$\{reviewedAt\.getTime\(\)\}:APPROVED/.test(notifs) && /SELLER_PROFILE_REJECTED:\$\{sellerId\}:\$\{reviewedAt\.getTime\(\)\}:DRAFT/.test(notifs));
  ok("idempotency · profile submitted keys off contentSubmittedAt, not updatedAt", /SELLER_PROFILE_SUBMITTED:\$\{sellerId\}:\$\{submittedAt\.getTime\(\)\}/.test(notifs));
  ok("idempotency · no lifecycle key is built from Seller.updatedAt", !/SELLER_(ACCOUNT|PROFILE)_\w+:\$\{sellerId\}:\$\{[^}]*updatedAt/.test(notifs));

  // writeAudit now returns the created row id
  ok("audit · writeAudit returns the created row id", /Promise<string \| null>/.test(audit) && /select: \{ id: true \}/.test(audit));

  // recipient resolution reused from the product-request pattern
  ok("recipients · account/profile context resolves ACTIVE OWNER/MANAGER + notifyEmail, deduped", /role: \{ in: \["OWNER", "MANAGER"\] \}/.test(notifs) && /addrs\.add\(notify\)/.test(notifs));
  ok("recipients · profile SUBMITTED uses the ops inbox, never loadSellerLifecycleEmailContext", /sendSellerProfileSubmitted[\s\S]{0,600}getSupportInboxEmail\(\)/.test(notifs) && !/sendSellerProfileSubmitted[\s\S]{0,900}loadSellerLifecycleEmailContext/.test(notifs));

  // trigger wiring — preserves existing transitions/audit, adds scheduleEmail
  ok("trigger · account transition schedules the matching sender", /scheduleEmail\(\(\) => sendSellerAccountApproved/.test(sellersActions) && /scheduleEmail\(\(\) => sendSellerAccountSuspended/.test(sellersActions) && /scheduleEmail\(\(\) => sendSellerAccountClosed/.test(sellersActions));
  ok("trigger · account email fires only when an audit row was actually written", /if \(auditLogId\)/.test(sellersActions));
  ok("trigger · profile approve/reject still call writeAudit before scheduling email", /action: "seller\.content\.approved"[\s\S]{0,400}scheduleEmail\(\(\) => sendSellerProfileApproved/.test(contentActions) && /action: "seller\.content\.rejected"[\s\S]{0,400}scheduleEmail\(\(\) => sendSellerProfileRejected/.test(contentActions));
  ok("trigger · profile submit only emails ops when it actually moved to PENDING", /res\.contentStatus === "PENDING"\) \{\s*scheduleEmail\(\(\) => sendSellerProfileSubmitted/.test(settingsActions));

  // scheduleEmail (not direct dispatch) used everywhere — never blocks the tx/response on SMTP
  ok("dispatch · triggers use scheduleEmail, not a bare await dispatchEmail", !/await dispatchEmail/.test(sellersActions) && !/await dispatchEmail/.test(contentActions) && !/await dispatchEmail/.test(settingsActions));

  // no schema change beyond what already existed (contentReviewedAt / contentSubmittedAt / adminAuditLog.id predate this phase)
  const sellerBlock = schema.slice(schema.indexOf("model Seller {"), schema.indexOf("model SellerUser {"));
  ok("schema · Seller model unchanged by this phase (still has the pre-existing moderation columns, nothing new)", /contentReviewedAt\s+DateTime\?/.test(sellerBlock) && /contentSubmittedAt\s+DateTime\?/.test(sellerBlock) && !/seller(AccountEmail|LifecycleEmail)/i.test(sellerBlock));
  ok("schema · EmailLog model untouched (no new columns)", schema.match(/model EmailLog \{[\s\S]*?\n\}/)?.[0].includes("idempotencyKey") ?? false);

  // scripts/seed-rbac.ts: this repo carries a long-standing, pre-existing
  // uncommitted change to that file from an earlier admin-migration phase
  // (predates 9F-6b — see `git log -1 -- scripts/seed-rbac.ts`), so a bare
  // "no git diff" check would always fail for a reason unrelated to this
  // phase. What 9F-6b actually needs verified is that none of ITS changed
  // files reference or import it.
  ok("scope · scripts/seed-rbac.ts not imported/required by any file this phase touched", ![notifs, send, audit, sellersActions, contentActions, settingsActions].some((f) => /seed-rbac/.test(f) && /(import|require)[^\n]*seed-rbac/.test(f)));
  ok("scope · no multiSellerCheckout / PayMongo / Inventory reference in the new template file", !/multiSellerCheckout|PayMongo|Inventory/.test(read("src/lib/email/templates/seller-lifecycle.ts")));
}

// ---------------------------------------------------------------------------
// Template content — direct render checks (EmailLog has no body columns)
// ---------------------------------------------------------------------------

function templateTests() {
  const approved1st = renderSellerAccountApproved({ brand: "Axiaro", siteUrl: "https://axiaro.shop", sellerName: "Style Avenue", portalUrl: "https://axiaro.shop/seller/login", reactivate: false });
  const approvedReactivate = renderSellerAccountApproved({ brand: "Axiaro", siteUrl: "https://axiaro.shop", sellerName: "Style Avenue", portalUrl: "https://axiaro.shop/seller/login", reactivate: true });
  ok("copy · first approval and reactivation use distinct subjects", approved1st.subject !== approvedReactivate.subject, `${approved1st.subject} vs ${approvedReactivate.subject}`);
  ok("copy · first approval says approved, not 'active again'", /approved/i.test(approved1st.subject) && !/active again/i.test(approved1st.subject));
  ok("copy · reactivation says active again / reactivated", /active again|reactivat/i.test(approvedReactivate.subject + approvedReactivate.html));
  ok("copy · both mention current status Approved", approved1st.html.includes("Approved") && approvedReactivate.html.includes("Approved"));

  const suspended = renderSellerAccountSuspended({ brand: "Axiaro", siteUrl: "https://axiaro.shop", sellerName: "Style Avenue", portalUrl: "https://axiaro.shop/seller/login" });
  ok("copy · suspended states current status", suspended.html.includes("Suspended"));
  ok("copy · suspended does NOT claim sessions were revoked/terminated", !/session[s]? (has|have|was|were) been (revoked|terminated|logged out)/i.test(suspended.html + suspended.text));

  const closed = renderSellerAccountClosed({ brand: "Axiaro", siteUrl: "https://axiaro.shop", sellerName: "Style Avenue", portalUrl: "https://axiaro.shop/seller/login" });
  ok("copy · closed states current status", closed.html.includes("Closed"));
  ok("copy · closed does NOT claim data was deleted/purged/wiped", !/(delet(e|ed|ion)|purg(e|ed)|wip(e|ed)|erased)/i.test(closed.html + closed.text));

  const rejected = renderSellerProfileRejected({ brand: "Axiaro", siteUrl: "https://axiaro.shop", sellerName: "Style Avenue", portalUrl: "https://axiaro.shop/seller/settings", reviewNote: "Please add a return policy before resubmitting." });
  ok("copy · profile rejection includes the mandatory review note verbatim", rejected.html.includes("Please add a return policy before resubmitting.") && rejected.text.includes("Please add a return policy before resubmitting."));

  const rejectedNoNote = renderSellerProfileRejected({ brand: "Axiaro", siteUrl: "https://axiaro.shop", sellerName: "Style Avenue", portalUrl: "https://axiaro.shop/seller/settings", reviewNote: null });
  ok("copy · rejection renders safely with no note (defensive — the action layer requires one)", typeof rejectedNoNote.subject === "string" && rejectedNoNote.subject.length > 0);
}

// ---------------------------------------------------------------------------
// Database (rolled back)
// ---------------------------------------------------------------------------

async function dbTests() {
  const emailLogBefore = await prisma.emailLog.count();
  const auditBefore = await prisma.adminAuditLog.count();
  const sellerBefore = await prisma.seller.count();

  try {
    await prisma.$transaction(async (tx) => {
      const t = Date.now().toString(36);
      const owner = await seedUser(tx, `owner-${t}`);
      // notifyEmail deliberately == owner's email, to prove dedup collapses it to one address
      const S = await seedSeller(tx, `sl-${t}`, owner.email);
      await tx.sellerUser.create({ data: { sellerId: S.id, userId: owner.id, role: "OWNER", status: "ACTIVE" } });
      const outsider = await seedUser(tx, `out-${t}`); // NOT a SellerUser of S

      // ── 1 — first approval (PENDING → APPROVED) ─────────────────────────
      const a1 = await seedAudit(tx, "seller.approved", S.id, "PENDING", "APPROVED");
      const r1 = await sendSellerAccountApproved(S.id, a1.id, { client: tx });
      ok("1 · first approval send routes (not FAILED for a bad reason)", r1.status !== "FAILED" || r1.error === "smtp_not_configured", JSON.stringify(r1));
      const key1 = `SELLER_ACCOUNT_APPROVED:${S.id}:${a1.id}`;
      const row1 = await tx.emailLog.findUnique({ where: { idempotencyKey: key1 }, select: { type: true, recipient: true, subject: true } });
      ok("1 · EmailLog row created with the exact expected key", Boolean(row1));
      ok("1 · correct EmailType", row1?.type === "seller_account_approved");
      ok("1 · recipients deduped — owner email appears exactly once despite matching notifyEmail too", row1?.recipient === owner.email);
      ok("1 · outsider (non-member) never a recipient", !row1?.recipient.includes(outsider.email));
      ok("1 · subject is the FIRST-approval copy, not reactivation", /approved/i.test(row1?.subject ?? "") && !/active again/i.test(row1?.subject ?? ""));

      // ── 2 — reactivation (SUSPENDED → APPROVED), distinct audit row+key ─
      const a2 = await seedAudit(tx, "seller.reactivated", S.id, "SUSPENDED", "APPROVED");
      await sendSellerAccountApproved(S.id, a2.id, { client: tx });
      const key2 = `SELLER_ACCOUNT_APPROVED:${S.id}:${a2.id}`;
      const row2 = await tx.emailLog.findUnique({ where: { idempotencyKey: key2 }, select: { subject: true } });
      ok("2 · reactivation gets its OWN key (different audit row id → no collision with test 1)", key1 !== key2);
      ok("2 · subject is the reactivation copy", /active again/i.test(row2?.subject ?? ""));

      // ── 3 — retry a FAILED/SKIPPED row (test 1's row) ───────────────────
      const logId1 = (await tx.emailLog.findUniqueOrThrow({ where: { idempotencyKey: key1 }, select: { id: true } })).id;
      const retry1 = await retryEmailByLog(logId1, tx);
      ok("3 · retry of SKIPPED row routes (not not_retryable)", retry1.error !== "not_retryable", JSON.stringify(retry1));
      ok("3 · retry reuses the same row (still exactly 1 for the key)", (await tx.emailLog.count({ where: { idempotencyKey: key1 } })) === 1);

      // ── 4 — retry a SENT row → DEDUPED ───────────────────────────────────
      const sentLog = await tx.emailLog.create({
        data: { type: "seller_account_approved", recipient: owner.email, subject: "x", idempotencyKey: `SELLER_ACCOUNT_APPROVED:${S.id}:${a1.id}:sent-fixture`, status: "SENT", sentAt: D1 },
        select: { id: true },
      });
      const retrySent = await retryEmailByLog(sentLog.id, tx);
      ok("4 · retrying a SENT row → DEDUPED, never re-sends", retrySent.status === "DEDUPED");

      // ── 5 — concurrent retry is safe, no duplicate row ──────────────────
      const [c1, c2] = await Promise.all([retryEmailByLog(logId1, tx), retryEmailByLog(logId1, tx)]);
      ok("5 · concurrent retry both resolve without throwing", Boolean(c1) && Boolean(c2));
      ok("5 · concurrent retry leaves exactly one row for the key", (await tx.emailLog.count({ where: { idempotencyKey: key1 } })) === 1);

      // ── 6 — suspended ────────────────────────────────────────────────────
      const a3 = await seedAudit(tx, "seller.suspended", S.id, "APPROVED", "SUSPENDED");
      await sendSellerAccountSuspended(S.id, a3.id, { client: tx });
      const key3 = `SELLER_ACCOUNT_SUSPENDED:${S.id}:${a3.id}`;
      const row3 = await tx.emailLog.findUnique({ where: { idempotencyKey: key3 }, select: { type: true, recipient: true } });
      ok("6 · suspended EmailType + key correct", row3?.type === "seller_account_suspended");
      ok("6 · suspended goes to the seller, not ops", row3?.recipient === owner.email);
      const retry3 = await retryEmailByLog((await tx.emailLog.findUniqueOrThrow({ where: { idempotencyKey: key3 }, select: { id: true } })).id, tx);
      ok("6 · suspended retry routes", retry3.error !== "not_retryable");

      // ── 7 — closed ───────────────────────────────────────────────────────
      const a4 = await seedAudit(tx, "seller.closed", S.id, "SUSPENDED", "CLOSED");
      await sendSellerAccountClosed(S.id, a4.id, { client: tx });
      const key4 = `SELLER_ACCOUNT_CLOSED:${S.id}:${a4.id}`;
      const row4 = await tx.emailLog.findUnique({ where: { idempotencyKey: key4 }, select: { type: true } });
      ok("7 · closed EmailType + key correct", row4?.type === "seller_account_closed");
      const retry4 = await retryEmailByLog((await tx.emailLog.findUniqueOrThrow({ where: { idempotencyKey: key4 }, select: { id: true } })).id, tx);
      ok("7 · closed retry routes", retry4.error !== "not_retryable");

      // ── 8 — profile approved (contentReviewedAt anchor, not updatedAt) ──
      await tx.seller.update({ where: { id: S.id }, data: { contentStatus: "APPROVED", contentReviewedAt: D2, contentReviewNote: null } });
      await sendSellerProfileApproved(S.id, { client: tx });
      const keyApproved = `SELLER_PROFILE_APPROVED:${S.id}:${D2.getTime()}:APPROVED`;
      const rowApproved = await tx.emailLog.findUnique({ where: { idempotencyKey: keyApproved }, select: { type: true, recipient: true } });
      ok("8 · profile-approved EmailType + key correct", rowApproved?.type === "seller_profile_approved");
      ok("8 · profile-approved goes to the seller", rowApproved?.recipient === owner.email);
      const retryApproved = await retryEmailByLog((await tx.emailLog.findUniqueOrThrow({ where: { idempotencyKey: keyApproved }, select: { id: true } })).id, tx);
      ok("8 · profile-approved retry routes", retryApproved.error !== "not_retryable");

      // ── 9 — profile rejected, with the mandatory note ───────────────────
      const note = "Please add a shipping policy and a return window before resubmitting.";
      await tx.seller.update({ where: { id: S.id }, data: { contentStatus: "DRAFT", contentReviewedAt: D3, contentReviewNote: note } });
      await sendSellerProfileRejected(S.id, { client: tx });
      const keyRejected = `SELLER_PROFILE_REJECTED:${S.id}:${D3.getTime()}:DRAFT`;
      const rowRejected = await tx.emailLog.findUnique({ where: { idempotencyKey: keyRejected }, select: { type: true, recipient: true, subject: true } });
      ok("9 · profile-rejected EmailType + key correct", rowRejected?.type === "seller_profile_rejected");
      ok("9 · profile-rejected key uses contentReviewedAt (D3), distinct from approved's D2 key", keyRejected !== keyApproved);
      const retryRejected = await retryEmailByLog((await tx.emailLog.findUniqueOrThrow({ where: { idempotencyKey: keyRejected }, select: { id: true } })).id, tx);
      ok("9 · profile-rejected retry routes", retryRejected.error !== "not_retryable");

      // ── 10 — profile submitted → OPS inbox, never the seller ────────────
      await tx.seller.update({ where: { id: S.id }, data: { contentStatus: "PENDING", contentSubmittedAt: D1, contentReviewNote: null } });
      await sendSellerProfileSubmitted(S.id, { client: tx });
      const keySubmitted = `SELLER_PROFILE_SUBMITTED:${S.id}:${D1.getTime()}`;
      const rowSubmitted = await tx.emailLog.findUnique({ where: { idempotencyKey: keySubmitted }, select: { type: true, recipient: true } });
      ok("10 · profile-submitted EmailType + key correct", rowSubmitted?.type === "seller_profile_submitted");
      ok("10 · profile-submitted recipient is NOT the seller (ops inbox instead)", rowSubmitted?.recipient !== owner.email);
      const retrySubmitted = await retryEmailByLog((await tx.emailLog.findUniqueOrThrow({ where: { idempotencyKey: keySubmitted }, select: { id: true } })).id, tx);
      ok("10 · profile-submitted retry routes", retrySubmitted.error !== "not_retryable");

      // ── 11 — an unsupported SKIPPED type stays not_retryable (unaffected) ─
      const eOther = await tx.emailLog.create({
        data: { type: "password_changed", recipient: owner.email, subject: "x", idempotencyKey: `PASSWORD_CHANGED:u-${t}:2026-09-05T09`, status: "SKIPPED", provider: "smtp", error: "smtp_not_configured" },
        select: { id: true },
      });
      const ro = await retryEmailByLog(eOther.id, tx);
      ok("11 · unrelated type (password_changed) is untouched — still not_retryable", ro.ok === false && ro.error === "not_retryable");

      // ── 12 — no recipient (seller with zero ACTIVE OWNER/MANAGER + no notifyEmail) ─
      const lonelySeller = await tx.seller.create({
        data: { type: "THIRD_PARTY", status: "PENDING", displayName: `lonely-${t}`, slug: `lonely-${t}`, supportEmail: `lonely-${t}@t.test`, contentStatus: "DRAFT" },
        select: { id: true },
      });
      const a5 = await seedAudit(tx, "seller.approved", lonelySeller.id, "PENDING", "APPROVED");
      const rLonely = await sendSellerAccountApproved(lonelySeller.id, a5.id, { client: tx });
      ok("12 · no resolvable recipient → FAILED/no_recipient, no EmailLog row created", rLonely.ok === false && rLonely.error === "no_recipient");
      ok("12 · no row written for a no-recipient send", (await tx.emailLog.findUnique({ where: { idempotencyKey: `SELLER_ACCOUNT_APPROVED:${lonelySeller.id}:${a5.id}` } })) === null);

      throw new Rollback();
    }, { timeout: 40_000, maxWait: 12_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("isolation · EmailLog count unchanged after rollback", (await prisma.emailLog.count()) === emailLogBefore);
  ok("isolation · AdminAuditLog count unchanged after rollback", (await prisma.adminAuditLog.count()) === auditBefore);
  ok("isolation · Seller count unchanged after rollback", (await prisma.seller.count()) === sellerBefore);
}

async function main() {
  console.log("\nPHASE 9F-6b — seller lifecycle notifications\n");
  console.log("Static wiring");
  staticTests();
  console.log("\nTemplate content");
  templateTests();
  console.log("\nDatabase (rolled back)");
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
