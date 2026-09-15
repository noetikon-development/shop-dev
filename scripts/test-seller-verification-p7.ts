/**
 * Seller Verification — review outcome emails (Phase 7).
 *
 * `reviewSellerVerificationAction`'s auth gate only works inside a real
 * Next.js request — the same limitation as every other seller/admin action
 * tested in this project. This file (a) statically confirms the action wires
 * in the new emails correctly, (b) drives the REPOSITORY + EMAIL functions
 * directly to prove the real transition → audit → email pipeline, and
 * (c) calls the render functions directly to prove email CONTENT never
 * carries sensitive document/ID data.
 *
 * `reviewSellerVerificationForAdmin` uses the bare `prisma` client (no
 * injectable transaction — same as Phase 4's own design), so — like Phases 3,
 * 4, and 5 — this file uses real, committed fixtures with explicit cleanup in
 * a `finally` block, rather than a rolled-back transaction.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-seller-verification-p7.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { createSeller } from "../src/lib/admin/sellers/repository";
import { writeAudit } from "../src/lib/admin/audit";
import { reviewSellerVerificationForAdmin } from "../src/lib/seller-verification/repository";
import { sendSellerVerificationApproved, sendSellerVerificationRejected } from "../src/lib/email/notifications";
import { renderSellerVerificationApproved, renderSellerVerificationRejected } from "../src/lib/email/templates/seller-lifecycle";

const prisma = new PrismaClient();

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

function fakeSellerInput(tag: string) {
  return {
    displayName: `P7V Store ${tag}`,
    slug: `p7v-store-${tag}-${Math.random().toString(36).slice(2, 7)}`,
    supportEmail: `p7v-support-${tag}@t.test`,
  };
}

async function seedPendingVerification(tag: string) {
  const email = `p7v-${tag}-${Math.random().toString(36).slice(2, 8)}@t.test`;
  const user = await prisma.user.create({ data: { email, name: "P7V Owner" }, select: { id: true, email: true } });
  const created = await createSeller(fakeSellerInput(tag), prisma);
  if (!created.ok) throw new Error(`fixture setup failed: ${JSON.stringify(created)}`);
  await prisma.sellerUser.create({
    data: { sellerId: created.sellerId, userId: user.id, role: "OWNER", status: "ACTIVE" },
  });
  const verification = await prisma.sellerVerification.create({
    data: {
      sellerId: created.sellerId,
      status: "PENDING",
      submittedAt: new Date(),
      legalName: "Fixture Legal Name",
      tin: "123-456-789-000",
      dtiRegistrationNumber: "DTI-FAKE-000",
    },
    select: { id: true },
  });
  return { sellerId: created.sellerId, verificationId: verification.id, ownerUserId: user.id, ownerEmail: email.toLowerCase() };
}

async function main() {
  console.log("\nSeller Verification — review outcome emails (Phase 7)\n");

  // ── static — wiring, scope discipline, and content-safety by construction ─
  const actionsSrc = read("src/lib/admin/seller-verification-actions.ts");
  const notificationsSrc = read("src/lib/email/notifications.ts");
  const templateSrc = read("src/lib/email/templates/seller-lifecycle.ts");
  const sendSrc = read("src/lib/email/send.ts");

  ok("A · reviewSellerVerificationAction imports scheduleEmail and both new senders",
    /import \{ scheduleEmail \} from "@\/lib\/email\/schedule"/.test(actionsSrc) &&
    /import \{ sendSellerVerificationApproved, sendSellerVerificationRejected \} from "@\/lib\/email\/notifications"/.test(actionsSrc));
  ok("B · reviewSellerVerificationAction captures auditLogId from writeAudit (not discarded)",
    /const auditLogId = await writeAudit\(/.test(actionsSrc));
  ok("C · email is only scheduled after writeAudit, guarded by if (auditLogId)",
    (() => {
      const m = actionsSrc.match(/export async function reviewSellerVerificationAction[\s\S]*?\n\}/);
      if (!m) return false;
      const auditIdx = m[0].indexOf("const auditLogId = await writeAudit(");
      const guardIdx = m[0].indexOf("if (auditLogId)");
      const scheduleIdx = m[0].indexOf("scheduleEmail(");
      return auditIdx !== -1 && guardIdx !== -1 && scheduleIdx !== -1 && auditIdx < guardIdx && guardIdx < scheduleIdx;
    })());
  ok("· document-review action (per-document) is untouched — no email import used there",
    (() => {
      const m = actionsSrc.match(/export async function reviewSellerVerificationDocumentAction[\s\S]*?\n\}/);
      return !!m && !/scheduleEmail|sendSellerVerification/.test(m[0]);
    })());
  ok("D · EmailType union includes both new outcome types",
    /"seller_verification_approved"/.test(sendSrc) && /"seller_verification_rejected"/.test(sendSrc));
  ok("E · recipient resolution reuses loadSellerLifecycleEmailContext (current-account-email pattern), not loadSellerApplicationEmailContext",
    (() => {
      const a = notificationsSrc.match(/export async function sendSellerVerificationApproved[\s\S]*?\n\}/);
      const r = notificationsSrc.match(/export async function sendSellerVerificationRejected[\s\S]*?\n\}/);
      return !!a && !!r &&
        /loadSellerLifecycleEmailContext/.test(a[0]) && /loadSellerLifecycleEmailContext/.test(r[0]) &&
        !/loadSellerApplicationEmailContext/.test(a[0]) && !/loadSellerApplicationEmailContext/.test(r[0]);
    })());
  ok("F · rejection reason is read back off the audit row's own meta at send time, never a caller-supplied string",
    (() => {
      const m = notificationsSrc.match(/export async function sendSellerVerificationRejected[\s\S]*?\n\}/);
      return !!m && /adminAuditLog\.findUnique/.test(m[0]) && /safeParse[\s\S]{0,60}reason/.test(m[0]) &&
        !/sendSellerVerificationRejected\([^)]*reason:/.test(m[0]);
    })());
  ok("G · idempotency keys are anchored on verificationId + auditLogId (never Seller.updatedAt / verification.updatedAt)",
    /SELLER_VERIFICATION_APPROVED:\$\{verificationId\}:\$\{auditLogId\}/.test(notificationsSrc) &&
    /SELLER_VERIFICATION_REJECTED:\$\{verificationId\}:\$\{auditLogId\}/.test(notificationsSrc));
  ok("security · neither render function's source references any government-ID / registration / document / storage field",
    (() => {
      const forbidden = /\b(tin|dtiRegistrationNumber|secRegistrationNumber|businessRegistrationNumber|legalName|phone|addressLine|storagePath|signedUrl|documentType|bucket)\b/i;
      const a = templateSrc.match(/export function renderSellerVerificationApproved[\s\S]*?\n\}/);
      const r = templateSrc.match(/export function renderSellerVerificationRejected[\s\S]*?\n\}/);
      return !!a && !!r && !forbidden.test(a[0]) && !forbidden.test(r[0]);
    })());
  ok("security · neither sender function's source reads a document/ID field off the verification row",
    (() => {
      const a = notificationsSrc.match(/export async function sendSellerVerificationApproved[\s\S]*?\n\}/);
      const r = notificationsSrc.match(/export async function sendSellerVerificationRejected[\s\S]*?\n\}/);
      const forbidden = /\b(tin|dtiRegistrationNumber|secRegistrationNumber|businessRegistrationNumber|storagePath|signedUrl|documentType)\b/i;
      return !!a && !!r && !forbidden.test(a[0]) && !forbidden.test(r[0]);
    })());
  ok("scope · Phase 6 verification gate files untouched by this phase (grep for any edit marker)",
    !/Phase 7/.test(read("src/lib/marketplace/seller-repository.ts")) &&
    !/Phase 7/.test(read("src/lib/seller/session.ts")));
  ok("scope · scripts/seed-rbac.ts untouched by this phase",
    !/Phase 7|seller_verification_approved|seller_verification_rejected/.test(read("scripts/seed-rbac.ts")));

  // ── pure content tests — render functions called directly ───────────────
  console.log("\n── render content (pure, no DB) ──");
  {
    const out = renderSellerVerificationApproved({ brand: "Axiaro", siteUrl: "https://axiaro.shop", sellerName: "Test Seller", portalUrl: "https://axiaro.shop/seller/login" });
    ok("4 · approved email mentions the seller name and a portal CTA", out.html.includes("Test Seller") && out.html.includes("https://axiaro.shop/seller/login"));
    ok("4 · approved email mentions marketplace-selling capability", /listings|marketplace|publish/i.test(out.html));
    ok("4 · approved email contains no TIN/registration-number-shaped strings",
      !/\d{3}-\d{3}-\d{3}/.test(out.html) && !/DTI-|SEC-/.test(out.html));
    ok("4 · approved email contains no storage/document path shape", !/sellers\/[a-z0-9]+\/[a-z0-9]+\.[a-z]+/i.test(out.html));
  }
  {
    const reason = "The uploaded ID photo was blurry. Please resubmit a clearer copy.";
    const out = renderSellerVerificationRejected({ brand: "Axiaro", siteUrl: "https://axiaro.shop", sellerName: "Test Seller", verificationUrl: "https://axiaro.shop/seller/verification", reason });
    ok("2 · rejected email includes the admin's reason verbatim", out.html.includes(reason) && out.text.includes(reason));
    ok("4 · rejected email links to the Seller Verification page, not settings/offers", out.html.includes("https://axiaro.shop/seller/verification"));
    ok("4 · rejected email contains no TIN/registration-number-shaped strings",
      !/\d{3}-\d{3}-\d{3}/.test(out.html) && !/DTI-|SEC-/.test(out.html));
    ok("4 · rejected email contains no storage/document path shape", !/sellers\/[a-z0-9]+\/[a-z0-9]+\.[a-z]+/i.test(out.html));
  }

  // ── real, committed fixtures (cleaned up explicitly at the end) ─────────
  const t = Date.now().toString(36);
  const fixtureSellerIds: string[] = [];
  const fixtureUserIds: string[] = [];
  const fixtureAuditLogIds: string[] = [];
  const fixtureEmailIdempotencyKeys: string[] = [];

  try {
    // ── 1 — PENDING → APPROVED: status changes + approval email/log created ─
    const a1 = await seedPendingVerification(`a-${t}`);
    fixtureSellerIds.push(a1.sellerId);
    fixtureUserIds.push(a1.ownerUserId);

    const adminUser = await prisma.user.create({ data: { email: `p7v-admin-${t}@t.test`, name: "P7V Admin" }, select: { id: true } });
    fixtureUserIds.push(adminUser.id);

    const approve = await reviewSellerVerificationForAdmin({
      sellerId: a1.sellerId, verificationId: a1.verificationId, status: "APPROVED", reviewNote: null, reviewedBy: adminUser.id,
    });
    ok("1 · PENDING → APPROVED succeeds", approve.ok === true, JSON.stringify(approve));
    const rowAfterApprove = await prisma.sellerVerification.findUniqueOrThrow({ where: { id: a1.verificationId } });
    ok("1 · verification status is now APPROVED", rowAfterApprove.status === "APPROVED");

    const approveAuditId = await writeAudit({
      actorUserId: adminUser.id, action: "seller.verification_approved", targetType: "seller_verification", targetId: a1.verificationId,
      summary: `P7V test approved ${a1.sellerId}'s seller verification`,
      meta: { sellerId: a1.sellerId, sellerVerificationId: a1.verificationId, status: "APPROVED" },
    });
    ok("fixture · audit row written for approval", !!approveAuditId);
    if (approveAuditId) fixtureAuditLogIds.push(approveAuditId);

    const approveEmailKey = `SELLER_VERIFICATION_APPROVED:${a1.verificationId}:${approveAuditId}`;
    fixtureEmailIdempotencyKeys.push(approveEmailKey);
    const sendApprove = approveAuditId ? await sendSellerVerificationApproved(a1.sellerId, a1.verificationId, approveAuditId) : null;
    ok("1 · approval email dispatch returns a routed result (SENT or SKIPPED)", !!sendApprove && ["SENT", "SKIPPED"].includes(sendApprove.status), JSON.stringify(sendApprove));
    const approveLog = await prisma.emailLog.findUnique({ where: { idempotencyKey: approveEmailKey } });
    ok("1 · exactly one EmailLog row created for the approval", !!approveLog && approveLog.type === "seller_verification_approved");
    ok("3 · approval email recipient is the seller's CURRENT account (OWNER) email",
      approveLog?.recipient === a1.ownerEmail, JSON.stringify({ got: approveLog?.recipient, want: a1.ownerEmail }));

    // ── 5 — duplicate/replay: same call again must not create a second row ──
    const sendApproveAgain = approveAuditId ? await sendSellerVerificationApproved(a1.sellerId, a1.verificationId, approveAuditId) : null;
    ok("5 · re-sending the SAME approval outcome dedupes (no duplicate email)", !!sendApproveAgain && sendApproveAgain.deduped === true, JSON.stringify(sendApproveAgain));
    const approveLogCount = await prisma.emailLog.count({ where: { idempotencyKey: approveEmailKey } });
    ok("5 · still exactly one EmailLog row for the approval after replay", approveLogCount === 1);

    // ── 5b — replay at the ACTION-LAYER transition itself: a second review
    // attempt on the same (already APPROVED) verification must fail BEFORE
    // any email would even be scheduled ─────────────────────────────────────
    const replayReview = await reviewSellerVerificationForAdmin({
      sellerId: a1.sellerId, verificationId: a1.verificationId, status: "APPROVED", reviewNote: null, reviewedBy: adminUser.id,
    });
    ok("5b · re-reviewing an already-APPROVED verification fails safely (no second transition to email)", replayReview.ok === false, JSON.stringify(replayReview));

    // ── 2 — PENDING → REJECTED: status changes + rejection email/log + reason ─
    const r1 = await seedPendingVerification(`r-${t}`);
    fixtureSellerIds.push(r1.sellerId);
    fixtureUserIds.push(r1.ownerUserId);
    const reviewNote = "The government ID photo is blurry — please upload a clearer copy.";
    const reject = await reviewSellerVerificationForAdmin({
      sellerId: r1.sellerId, verificationId: r1.verificationId, status: "REJECTED", reviewNote, reviewedBy: adminUser.id,
    });
    ok("2 · PENDING → REJECTED succeeds", reject.ok === true, JSON.stringify(reject));
    const rowAfterReject = await prisma.sellerVerification.findUniqueOrThrow({ where: { id: r1.verificationId } });
    ok("2 · verification status is now REJECTED", rowAfterReject.status === "REJECTED");

    const rejectAuditId = await writeAudit({
      actorUserId: adminUser.id, action: "seller.verification_rejected", targetType: "seller_verification", targetId: r1.verificationId,
      summary: `P7V test rejected ${r1.sellerId}'s seller verification`,
      meta: { sellerId: r1.sellerId, sellerVerificationId: r1.verificationId, status: "REJECTED", reason: reviewNote },
    });
    ok("fixture · audit row written for rejection, with reason in meta", !!rejectAuditId);
    if (rejectAuditId) fixtureAuditLogIds.push(rejectAuditId);

    const rejectEmailKey = `SELLER_VERIFICATION_REJECTED:${r1.verificationId}:${rejectAuditId}`;
    fixtureEmailIdempotencyKeys.push(rejectEmailKey);
    const sendReject = rejectAuditId ? await sendSellerVerificationRejected(r1.sellerId, r1.verificationId, rejectAuditId) : null;
    ok("2 · rejection email dispatch returns a routed result (SENT or SKIPPED)", !!sendReject && ["SENT", "SKIPPED"].includes(sendReject.status), JSON.stringify(sendReject));
    const rejectLog = await prisma.emailLog.findUnique({ where: { idempotencyKey: rejectEmailKey } });
    ok("2 · exactly one EmailLog row created for the rejection", !!rejectLog && rejectLog.type === "seller_verification_rejected");
    ok("2 · the audit row's own reason matches what the admin submitted (what sendSellerVerificationRejected reads at send time)",
      JSON.parse((await prisma.adminAuditLog.findUniqueOrThrow({ where: { id: rejectAuditId! } })).meta ?? "{}").reason === reviewNote);
    ok("3 · rejection email recipient is the seller's CURRENT account (OWNER) email", rejectLog?.recipient === r1.ownerEmail);

    // ── 5 (rejection side) — duplicate/replay ────────────────────────────────
    const sendRejectAgain = rejectAuditId ? await sendSellerVerificationRejected(r1.sellerId, r1.verificationId, rejectAuditId) : null;
    ok("5 · re-sending the SAME rejection outcome dedupes (no duplicate email)", !!sendRejectAgain && sendRejectAgain.deduped === true, JSON.stringify(sendRejectAgain));
    const rejectLogCount = await prisma.emailLog.count({ where: { idempotencyKey: rejectEmailKey } });
    ok("5 · still exactly one EmailLog row for the rejection after replay", rejectLogCount === 1);

    // ── 6 — email failure is durably logged and NEVER reverts the decision ──
    const noReasonAuditId = await writeAudit({
      actorUserId: adminUser.id, action: "seller.verification_rejected", targetType: "seller_verification", targetId: r1.verificationId,
      summary: "P7V test audit row with no reason in meta (simulated preparation failure)",
      meta: { sellerId: r1.sellerId, sellerVerificationId: r1.verificationId, status: "REJECTED" },
    });
    if (noReasonAuditId) fixtureAuditLogIds.push(noReasonAuditId);
    const failKey = `SELLER_VERIFICATION_REJECTED:${r1.verificationId}:${noReasonAuditId}`;
    fixtureEmailIdempotencyKeys.push(failKey);
    const failedSend = noReasonAuditId ? await sendSellerVerificationRejected(r1.sellerId, r1.verificationId, noReasonAuditId) : null;
    ok("6 · a preparation failure (missing reason) is reported as FAILED, not silently dropped", !!failedSend && failedSend.status === "FAILED", JSON.stringify(failedSend));
    const failedLog = await prisma.emailLog.findUnique({ where: { idempotencyKey: failKey } });
    ok("6 · the failure is durably logged as a FAILED EmailLog row", failedLog?.status === "FAILED");
    const verificationAfterFailure = await prisma.sellerVerification.findUniqueOrThrow({ where: { id: r1.verificationId } });
    ok("6 · the verification decision itself is UNCHANGED by the email failure (still REJECTED)", verificationAfterFailure.status === "REJECTED");

    // ── F/G/H — nothing else in the domain changed by this phase ───────────
    ok("· Seller.status untouched by either review (still its creation-time default, PENDING)",
    (await prisma.seller.findUniqueOrThrow({ where: { id: a1.sellerId }, select: { status: true } })).status === "PENDING");
    ok("· no SellerInvite rows created for any fixture seller", (await prisma.sellerInvite.count({ where: { sellerId: { in: fixtureSellerIds } } })) === 0);
  } finally {
    if (fixtureEmailIdempotencyKeys.length) {
      await prisma.emailLog.deleteMany({ where: { idempotencyKey: { in: fixtureEmailIdempotencyKeys } } }).catch(() => {});
    }
    if (fixtureSellerIds.length) {
      await prisma.seller.deleteMany({ where: { id: { in: fixtureSellerIds } } }).catch(() => {});
    }
    if (fixtureAuditLogIds.length) {
      await prisma.adminAuditLog.deleteMany({ where: { id: { in: fixtureAuditLogIds } } }).catch(() => {});
    }
    if (fixtureUserIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: fixtureUserIds } } }).catch(() => {});
    }
  }

  // ── isolation ─────────────────────────────────────────────────────────
  ok("isolation · no fixture User leaked", (await prisma.user.count({ where: { email: { contains: "p7v-" } } })) === 0);
  ok("isolation · no fixture Seller leaked", (await prisma.seller.count({ where: { displayName: { startsWith: "P7V Store " } } })) === 0);
  ok("isolation · no fixture SellerVerification leaked",
    (await prisma.sellerVerification.count({ where: { seller: { displayName: { startsWith: "P7V Store " } } } })) === 0);
  ok("isolation · no fixture AdminAuditLog leaked", (await prisma.adminAuditLog.count({ where: { summary: { contains: "P7V" } } })) === 0);
  ok("isolation · no fixture EmailLog rows leaked", (await prisma.emailLog.count({ where: { recipient: { contains: "p7v-" } } })) === 0);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
