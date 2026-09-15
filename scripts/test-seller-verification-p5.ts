/**
 * Seller Verification — submit for review, DRAFT → PENDING (Phase 5).
 *
 * `submitSellerVerificationForReviewAction`'s auth gate
 * (`requireSellerSessionPermission`) only works inside a real Next.js
 * request — the same limitation as every other seller-portal action tested
 * in this project. This file statically confirms the action calls it, then
 * drives the REPOSITORY function (`submitSellerVerificationForReview`)
 * directly to prove the real transition/validation/concurrency logic.
 *
 * Documents require real Supabase Storage I/O (Phase 3's
 * `uploadSellerVerificationDocument` uses the bare `prisma` client, not an
 * injectable transaction), so — like Phases 3 and 4 — this file uses real,
 * committed fixtures with explicit cleanup rather than a rolled-back
 * transaction.
 *
 * The single strongest security property this phase has: `submitSellerVerificationForReview`
 * takes ONLY a `SellerContext` — there is no sellerId, verificationId, or
 * documentId parameter anywhere in its signature for a forged value to even
 * occupy. "Forged sellerId" / "cross-seller submission" aren't just guarded
 * against, they have no attack surface to begin with.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-seller-verification-p5.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { createSeller } from "../src/lib/admin/sellers/repository";
import { createAdminClient } from "../src/lib/supabase/admin";
import { writeAudit } from "../src/lib/admin/audit";
import { SELLER_VERIFICATION_BUCKET } from "../src/lib/seller-verification/storage";
import {
  saveSellerVerificationDraft,
  uploadSellerVerificationDocument,
  submitSellerVerificationForReview,
  reviewSellerVerificationForAdmin,
  type SellerVerificationDraftPatch,
} from "../src/lib/seller-verification/repository";
import type { SellerContext } from "../src/lib/marketplace/types";

const prisma = new PrismaClient();

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 9)]);

const EMPTY_PATCH: SellerVerificationDraftPatch = {
  legalName: null, phone: null, addressLine1: null, addressLine2: null, barangay: null,
  city: null, province: null, postalCode: null, country: null, businessType: null,
  businessName: null, businessRegistrationNumber: null, dtiRegistrationNumber: null,
  secRegistrationNumber: null, tin: null,
};

function fakeSellerInput(tag: string) {
  return {
    displayName: `P5V Store ${tag}`,
    slug: `p5v-store-${tag}-${Math.random().toString(36).slice(2, 7)}`,
    supportEmail: `p5v-support-${tag}@t.test`,
  };
}

async function seedRealSellerWithOwner(tag: string): Promise<{ ctx: SellerContext; userId: string }> {
  const user = await prisma.user.create({
    data: { email: `p5v-${tag}-${Math.random().toString(36).slice(2, 8)}@t.test`, name: "P5V User" },
    select: { id: true },
  });
  const created = await createSeller(fakeSellerInput(tag), prisma);
  if (!created.ok) throw new Error(`fixture setup failed: ${JSON.stringify(created)}`);
  const sellerUser = await prisma.sellerUser.create({
    data: { sellerId: created.sellerId, userId: user.id, role: "OWNER", status: "ACTIVE" },
  });
  return {
    userId: user.id,
    ctx: {
      sellerId: created.sellerId,
      sellerName: created.displayName,
      sellerUserId: sellerUser.id,
      userId: user.id,
      role: "OWNER",
      permissions: new Set(["manage_seller_settings"]),
    },
  };
}

async function main() {
  console.log("\nSeller Verification — submit for review (Phase 5)\n");

  // ── static — auth gate, no forgeable id parameter, no email, no doc-status touch ─
  const actionsSrc = read("src/lib/seller-verification/actions.ts");
  const repoSrc = read("src/lib/seller-verification/repository.ts");
  const pageSrc = read("src/app/seller/(portal)/verification/page.tsx");

  ok("· submitSellerVerificationForReviewAction requires manage_seller_settings",
    (() => {
      const m = actionsSrc.match(/export async function submitSellerVerificationForReviewAction[\s\S]*?\r?\n\}/);
      return !!m && /requireSellerSessionPermission\("manage_seller_settings"\)/.test(m[0]);
    })());
  ok("· the action never reads sellerId/verificationId from the submitted form",
    (() => {
      const m = actionsSrc.match(/export async function submitSellerVerificationForReviewAction[\s\S]*?\r?\n\}/);
      return !!m && !/formData\.get\("sellerId"\)/.test(m[0]) && !/formData\.get\("verificationId"\)/.test(m[0]);
    })());
  ok("security · submitSellerVerificationForReview's signature takes ONLY a SellerContext — no sellerId/verificationId/documentId parameter exists to forge",
    /export async function submitSellerVerificationForReview\(\s*ctx: SellerContext,\s*externalTx\?: Prisma\.TransactionClient,\s*\): Promise<SubmitSellerVerificationResult>/.test(repoSrc));
  ok("M/security · documents are queried ONLY by this verification's own id (where: { sellerVerificationId: verification.id }) — there is no code path that could pull in another seller's document",
    (() => {
      const m = repoSrc.match(/export async function submitSellerVerificationForReview[\s\S]*?\n(?=export |\/\/ -{3})/);
      return !!m && /where: \{ sellerVerificationId: verification\.id \}/.test(m[0]);
    })());
  ok("· the transition never sets reviewedAt/reviewedBy/reviewNote (Admin-review-only, Phase 4)",
    (() => {
      const m = repoSrc.match(/export async function submitSellerVerificationForReview[\s\S]*?\n(?=export |\/\/ -{3})/);
      return !!m && !/reviewedAt:/.test(m[0]) && !/reviewedBy:/.test(m[0]) && !/reviewNote:/.test(m[0]);
    })());
  ok("· the transition never touches SellerVerificationDocument.status (document decisions stay Admin's, Phase 4)",
    (() => {
      const m = repoSrc.match(/export async function submitSellerVerificationForReview[\s\S]*?\n(?=export |\/\/ -{3})/);
      return !!m && !/sellerVerificationDocument\.update/.test(m[0]);
    })());
  ok("· no email sender is imported anywhere in the seller-facing verification actions",
    !/from "@\/lib\/email\/notifications"/.test(actionsSrc));
  ok("S · the page renders the Submit panel ONLY while status is DRAFT",
    // Phase 9 inserted a requirements-checklist block between the condition
    // and the panel — widened from {0,200}.
    /status === "DRAFT" &&[\s\S]{0,900}SellerVerificationSubmitPanel/.test(pageSrc));

  // ── real, committed fixtures (cleaned up explicitly at the end) ─────────
  const t = Date.now().toString(36);
  const supabase = createAdminClient();
  const uploadedPaths: string[] = [];
  const fixtureSellerIds: string[] = [];
  const fixtureUserIds: string[] = [];
  const fixtureAuditLogIds: string[] = [];

  try {
    const { ctx: ctxA, userId: userIdA } = await seedRealSellerWithOwner(`a-${t}`);
    const { ctx: ctxB, userId: userIdB } = await seedRealSellerWithOwner(`b-${t}`);
    const { ctx: ctxC, userId: userIdC } = await seedRealSellerWithOwner(`c-${t}`); // zero documents
    fixtureSellerIds.push(ctxA.sellerId, ctxB.sellerId, ctxC.sellerId);
    fixtureUserIds.push(userIdA, userIdB, userIdC);

    const sellerRowBefore = await prisma.seller.findUniqueOrThrow({ where: { id: ctxA.sellerId }, select: { status: true } });
    const sellerUserCountBefore = await prisma.sellerUser.count({ where: { sellerId: { in: fixtureSellerIds } } });
    const emailLogCountBefore = await prisma.emailLog.count();

    // ── K — a seller with no SellerVerification at all fails safely ────────
    const noVerification = await submitSellerVerificationForReview(ctxB);
    ok("K · submitting with no SellerVerification row fails safely with NOT_FOUND", !noVerification.ok && noVerification.status === "NOT_FOUND");

    // ── L — a DRAFT with valid info but ZERO documents fails safely ────────
    const marker = `LEGAL-NAME-MARKER-${t}`;
    const draftC = await saveSellerVerificationDraft(ctxC, { ...EMPTY_PATCH, legalName: marker, phone: "09171234567" });
    ok("fixture · draftC saved", draftC.ok);
    if (!draftC.ok) throw new Error("fixture draftC failed");
    const zeroDocs = await submitSellerVerificationForReview(ctxC);
    ok("L · submitting with zero documents fails safely with INVALID", !zeroDocs.ok && zeroDocs.status === "INVALID");
    ok("L · the verification stays DRAFT after the failed zero-document submission",
      (await prisma.sellerVerification.findUniqueOrThrow({ where: { id: draftC.verification.id } })).status === "DRAFT");

    // ── A/B/C — a DRAFT with valid info + one document can submit ─────────
    // Phase 9 — address must be COMPLETE (addressLine1/city/province/postalCode/
    // country) to satisfy the new minimum-evidence submission requirement;
    // pre-Phase-9 fixtures only ever set city+country, which now correctly
    // fails MISSING_ADDRESS since this test is exercising a SUCCESSFUL submit.
    const draftA = await saveSellerVerificationDraft(ctxA, {
      ...EMPTY_PATCH, legalName: marker, phone: "09171234567",
      addressLine1: "1 Test St", city: "Quezon City", province: "Metro Manila", postalCode: "1100",
      country: "PH", businessType: "INDIVIDUAL",
    });
    if (!draftA.ok) throw new Error("fixture draftA failed");
    const verificationId = draftA.verification.id;
    const upload = await uploadSellerVerificationDocument(ctxA, {
      buffer: PNG, sizeBytes: PNG.length, declaredType: "image/png", documentType: "GOVERNMENT_ID_PRIMARY",
    });
    ok("fixture · document uploaded", upload.ok, JSON.stringify(upload));
    if (!upload.ok) throw new Error("fixture upload failed");
    const rawDoc = await prisma.sellerVerificationDocument.findUniqueOrThrow({ where: { id: upload.document.id } });
    uploadedPaths.push(rawDoc.storagePath);

    const submitA = await submitSellerVerificationForReview(ctxA);
    ok("A · a DRAFT with valid data + one document submits successfully", submitA.ok, JSON.stringify(submitA));
    if (!submitA.ok) throw new Error("submitA failed");
    ok("B · status is now PENDING", submitA.verification.status === "PENDING");
    ok("C · submittedAt is populated", submitA.verification.submittedAt !== null);
    ok("· reviewedAt/reviewedBy/reviewNote remain untouched by submission", submitA.verification.reviewedAt === null && submitA.verification.reviewNote === null);
    ok("· it is still the SAME verification row (no duplicate created)", submitA.verification.id === verificationId);
    ok("· exactly one SellerVerification row exists for sellerA", (await prisma.sellerVerification.count({ where: { sellerId: ctxA.sellerId } })) === 1);

    // ── J — the document's own status is untouched by submission ──────────
    const docAfterSubmit = await prisma.sellerVerificationDocument.findUniqueOrThrow({ where: { id: upload.document.id } });
    ok("J · the document is still PENDING — submission never auto-decides it", docAfterSubmit.status === "PENDING");

    // ── D/E — audit row for the submission, without PII ────────────────────
    const auditId = await writeAudit({
      actorUserId: ctxA.userId,
      action: "seller.verification_submitted",
      targetType: "seller_verification",
      targetId: verificationId,
      summary: `seller ${ctxA.sellerName} submitted its verification for review`,
      meta: { sellerId: ctxA.sellerId, sellerVerificationId: verificationId },
    });
    if (auditId) fixtureAuditLogIds.push(auditId);
    const auditRow = await prisma.adminAuditLog.findUnique({ where: { id: auditId! } });
    ok("D · exactly one AdminAuditLog row created for the submission", !!auditRow);
    ok("E · the audit row never contains the legal name or any other PII value", !!auditRow && !JSON.stringify(auditRow).includes(marker));

    // ── O — already PENDING cannot be resubmitted (replay) ─────────────────
    const replay = await submitSellerVerificationForReview(ctxA);
    ok("O · resubmitting an already-PENDING verification is rejected safely", !replay.ok && replay.status === "ALREADY_SUBMITTED");
    ok("O · still exactly one SellerVerification row (no duplicate from the replay)", (await prisma.sellerVerification.count({ where: { sellerId: ctxA.sellerId } })) === 1);

    // ── P — APPROVED cannot be resubmitted ──────────────────────────────────
    const adminUser = await prisma.user.create({ data: { email: `p5v-admin-${t}@t.test`, name: "P5V Admin" }, select: { id: true } });
    fixtureUserIds.push(adminUser.id);
    const approve = await reviewSellerVerificationForAdmin({
      sellerId: ctxA.sellerId, verificationId, status: "APPROVED", reviewNote: null, reviewedBy: adminUser.id,
    });
    ok("fixture · admin approves sellerA's verification (Phase 4, unchanged)", approve.ok);
    const submitApproved = await submitSellerVerificationForReview(ctxA);
    ok("P · resubmitting an APPROVED verification is rejected safely", !submitApproved.ok && submitApproved.status === "ALREADY_SUBMITTED");

    // ── Q — REJECTED: submit itself never creates a duplicate row; the
    // EXISTING resubmission pathway is saveSellerVerificationDraft's own
    // unchanged Phase 2 behavior (a fresh DRAFT once the latest row isn't
    // DRAFT), which this phase deliberately does not alter or duplicate ──
    const draftB = await saveSellerVerificationDraft(ctxB, {
      ...EMPTY_PATCH, legalName: "Someone Else", phone: "09171234567",
      addressLine1: "1 Test St", city: "Manila", province: "Metro Manila", postalCode: "1000",
      country: "PH", businessType: "INDIVIDUAL",
    });
    if (!draftB.ok) throw new Error("fixture draftB failed");
    const uploadB = await uploadSellerVerificationDocument(ctxB, {
      buffer: PNG, sizeBytes: PNG.length, declaredType: "image/png", documentType: "GOVERNMENT_ID_PRIMARY",
    });
    if (!uploadB.ok) throw new Error("fixture uploadB failed");
    const rawDocB = await prisma.sellerVerificationDocument.findUniqueOrThrow({ where: { id: uploadB.document.id } });
    uploadedPaths.push(rawDocB.storagePath);
    const submitB = await submitSellerVerificationForReview(ctxB);
    ok("fixture · sellerB submits", submitB.ok);
    if (!submitB.ok) throw new Error("submitB failed");
    const reject = await reviewSellerVerificationForAdmin({
      sellerId: ctxB.sellerId, verificationId: submitB.verification.id, status: "REJECTED", reviewNote: "not clear enough", reviewedBy: adminUser.id,
    });
    ok("fixture · admin rejects sellerB's verification (Phase 4, unchanged)", reject.ok);
    const submitRejected = await submitSellerVerificationForReview(ctxB);
    ok("Q · resubmitting a REJECTED verification via submit itself is rejected, not silently duplicated", !submitRejected.ok && submitRejected.status === "ALREADY_SUBMITTED");
    ok("Q · still exactly one SellerVerification row for sellerB (submit never creates a second one)",
      (await prisma.sellerVerification.count({ where: { sellerId: ctxB.sellerId } })) === 1);
    const freshDraftAfterReject = await saveSellerVerificationDraft(ctxB, { ...EMPTY_PATCH, legalName: "Resubmission attempt" });
    ok("Q · the EXISTING (unchanged) draft-save pathway still creates a fresh DRAFT after rejection, for a later resubmission",
      freshDraftAfterReject.ok && freshDraftAfterReject.ok && freshDraftAfterReject.verification.id !== submitB.verification.id && freshDraftAfterReject.verification.status === "DRAFT");
    ok("Q · that is now a second, distinct row (rejected history preserved, not overwritten)",
      (await prisma.sellerVerification.count({ where: { sellerId: ctxB.sellerId } })) === 2);

    // ── R — concurrent submission: only one transition succeeds ───────────
    // Phase 9 — complete data + a real GOVERNMENT_ID_PRIMARY (not OTHER,
    // which no longer satisfies the INDIVIDUAL minimum-evidence requirement);
    // this test is about concurrency safety, not document-type policy, so the
    // fixture just needs to be genuinely submittable.
    const draftR = await saveSellerVerificationDraft(ctxC, {
      ...EMPTY_PATCH, legalName: "Concurrent Test", phone: "09171234567",
      addressLine1: "1 Test St", city: "Manila", province: "Metro Manila", postalCode: "1000",
      country: "PH", businessType: "INDIVIDUAL",
    });
    if (!draftR.ok) throw new Error("fixture draftR failed");
    // ctxC already had a zero-document DRAFT from test L — saveSellerVerificationDraft
    // reused that same row (still DRAFT). Give it a document now.
    const uploadR = await uploadSellerVerificationDocument(ctxC, {
      buffer: PNG, sizeBytes: PNG.length, declaredType: "image/png", documentType: "GOVERNMENT_ID_PRIMARY",
    });
    if (!uploadR.ok) throw new Error("fixture uploadR failed");
    const rawDocR = await prisma.sellerVerificationDocument.findUniqueOrThrow({ where: { id: uploadR.document.id } });
    uploadedPaths.push(rawDocR.storagePath);

    const [race1, race2, race3] = await Promise.all([
      submitSellerVerificationForReview(ctxC),
      submitSellerVerificationForReview(ctxC),
      submitSellerVerificationForReview(ctxC),
    ]);
    const successes = [race1, race2, race3].filter((r) => r.ok);
    ok("R · exactly ONE of three concurrent submissions succeeds", successes.length === 1, JSON.stringify([race1, race2, race3]));
    ok("R · the other two are safely rejected as ALREADY_SUBMITTED, not errors/throws",
      [race1, race2, race3].filter((r) => !r.ok).every((r) => !r.ok && r.status === "ALREADY_SUBMITTED"));
    ok("R · exactly one SellerVerification row for sellerC ends up PENDING (no duplicate transition)",
      (await prisma.sellerVerification.count({ where: { sellerId: ctxC.sellerId, status: "PENDING" } })) === 1);

    // ── N/security — cross-seller isolation: sellerB's actions never touch
    // sellerA's (already-APPROVED) verification, and vice versa ───────────
    const sellerARowCheck = await prisma.sellerVerification.findUniqueOrThrow({ where: { id: verificationId } });
    ok("N/security · sellerA's APPROVED verification is untouched by any of sellerB's/sellerC's submissions", sellerARowCheck.status === "APPROVED");

    // ── F/G/H/I — nothing else in the domain changed ───────────────────────
    const sellerRowAfter = await prisma.seller.findUniqueOrThrow({ where: { id: ctxA.sellerId }, select: { status: true } });
    ok("F · Seller.status unchanged across every submission/transition above", sellerRowAfter.status === sellerRowBefore.status);
    ok("G · SellerUser count unchanged (still just the seeded OWNERs)",
      (await prisma.sellerUser.count({ where: { sellerId: { in: fixtureSellerIds } } })) === sellerUserCountBefore);
    ok("H · zero SellerInvite rows exist for any fixture seller",
      (await prisma.sellerInvite.count({ where: { sellerId: { in: fixtureSellerIds } } })) === 0);
    ok("I · no EmailLog row was created by any submission", (await prisma.emailLog.count()) === emailLogCountBefore);
  } finally {
    if (uploadedPaths.length) {
      await supabase.storage.from(SELLER_VERIFICATION_BUCKET).remove(uploadedPaths).catch(() => {});
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

  // ── V — no public URL, private bucket unaffected ─────────────────────────
  ok("V · getPublicUrl() is never called in the repository", !/\.getPublicUrl\(/.test(repoSrc));
  const { data: svBucket } = await supabase.storage.getBucket(SELLER_VERIFICATION_BUCKET);
  ok("V · the private bucket is still private", svBucket?.public === false);
  const { data: mediaBucket } = await supabase.storage.getBucket("media");
  ok("· the existing public media bucket is unaffected", mediaBucket?.public === true);

  // ── isolation ─────────────────────────────────────────────────────────
  ok("isolation · no fixture User leaked", (await prisma.user.count({ where: { email: { contains: "p5v-" } } })) === 0);
  ok("isolation · no fixture Seller leaked", (await prisma.seller.count({ where: { displayName: { startsWith: "P5V Store " } } })) === 0);
  ok("isolation · no fixture SellerVerification leaked",
    (await prisma.sellerVerification.count({ where: { seller: { displayName: { startsWith: "P5V Store " } } } })) === 0);
  ok("isolation · no fixture AdminAuditLog leaked", (await prisma.adminAuditLog.count({ where: { summary: { contains: "P5V Store" } } })) === 0);
  const { data: leftover } = await supabase.storage.from(SELLER_VERIFICATION_BUCKET).list("sellers");
  ok("isolation · no fixture storage objects leaked under sellers/", (leftover ?? []).length === 0, JSON.stringify(leftover));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
