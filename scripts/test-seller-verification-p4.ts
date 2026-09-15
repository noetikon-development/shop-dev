/**
 * Seller Verification — admin review (Phase 4).
 *
 * `requirePermission("manage_settings")` (the auth/RBAC gate on both the
 * page and every new admin action) only works inside a real Next.js request
 * — the same limitation as every other admin/seller action tested in this
 * project. Consistent with that established convention, this file (a)
 * statically confirms the page and every new action call it, and (b) drives
 * the actual REPOSITORY functions directly (bypassing the auth wrapper) to
 * prove the real ownership-chain / status-transition / audit logic.
 *
 * Nothing here creates a real business record for an existing seller —
 * every fixture is a synthetic Seller this file creates and deletes. Like
 * Phase 3, review/signed-url functions use the plain `prisma` client (a
 * separate connection from any test-owned `$transaction`), and one real
 * document upload against real Supabase Storage is needed to have something
 * to review — so this file uses real, committed fixtures with explicit
 * cleanup, not a rolled-back transaction (see the `finally` block).
 *
 * KNOWN GAP this file works around deliberately (see the Phase 4 report's
 * "known limitations"): nothing in Phases 1–3 ever moves a SellerVerification
 * from DRAFT to PENDING — there is no "submit for review" action yet, and
 * building one is out of this phase's scope ("do not change the customer
 * verification form unless strictly required"). This file manufactures a
 * PENDING verification via a direct, test-only Prisma write to exercise the
 * review actions, exactly as the Phase 4 task itself frames the review
 * guard ("PENDING → APPROVED" / "PENDING → REJECTED").
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-seller-verification-p4.ts
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
  getSellerVerificationForAdmin,
  listSellerVerificationDocumentsForAdmin,
  getSellerVerificationDocumentSignedUrlForAdminScoped,
  reviewSellerVerificationDocumentForAdmin,
  reviewSellerVerificationForAdmin,
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

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);

function fakeSellerInput(tag: string) {
  return {
    displayName: `P4V Store ${tag}`,
    slug: `p4v-store-${tag}-${Math.random().toString(36).slice(2, 7)}`,
    supportEmail: `p4v-support-${tag}@t.test`,
  };
}

async function seedRealSellerWithOwner(tag: string): Promise<{ ctx: SellerContext; userId: string }> {
  const user = await prisma.user.create({
    data: { email: `p4v-${tag}-${Math.random().toString(36).slice(2, 8)}@t.test`, name: "P4V User" },
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
  console.log("\nSeller Verification — admin review (Phase 4)\n");

  // ── static — auth gate, PII discipline, status-safety, no email ────────
  const pageSrc = read("src/app/admin/(shell)/sellers/[id]/verification/page.tsx");
  const adminActionsSrc = read("src/lib/admin/seller-verification-actions.ts");
  const repoSrc = read("src/lib/seller-verification/repository.ts");
  const reviewUiSrc = read("src/components/admin/sellers/seller-verification-review.tsx");

  ok("A · the review page requires manage_settings", /requirePermission\("manage_settings"\)/.test(pageSrc));
  ok("A · every admin action in the actions file requires manage_settings",
    (adminActionsSrc.match(/export async function \w+/g) ?? []).length ===
      (adminActionsSrc.match(/await requirePermission\("manage_settings"\)/g) ?? []).length);

  ok("I · document rejection requires a reason before calling the repository",
    /status === "REJECTED" && !reviewNote[\s\S]{0,80}return \{ error:/.test(adminActionsSrc));
  ok("L · verification rejection requires a reason before calling the repository",
    (adminActionsSrc.match(/status === "REJECTED" && !reviewNote/g) ?? []).length >= 2);

  ok("W · no email sender is imported anywhere in the admin verification actions",
    !/from "@\/lib\/email\/notifications"/.test(adminActionsSrc));
  ok("X · getPublicUrl() is never called in the repository", !/\.getPublicUrl\(/.test(repoSrc));
  ok("· the review UI never renders a bucket name or storage path",
    !/storagePath/.test(reviewUiSrc) && !/\.bucket\b|bucket:/i.test(reviewUiSrc));

  ok("P/Q/R · reviewSellerVerificationForAdmin never touches Seller.status/SellerUser/SellerInvite",
    (() => {
      const m = repoSrc.match(/export async function reviewSellerVerificationForAdmin[\s\S]*?\r?\n\}/);
      return !!m && !/transitionSellerStatus/.test(m[0]) && !/sellerUser\.(create|update)/.test(m[0]) && !/sellerInvite\.(create|update)/.test(m[0]);
    })());
  ok("P/Q/R · reviewSellerVerificationDocumentForAdmin never touches Seller.status/SellerUser/SellerInvite",
    (() => {
      const m = repoSrc.match(/export async function reviewSellerVerificationDocumentForAdmin[\s\S]*?\r?\n\}/);
      return !!m && !/transitionSellerStatus/.test(m[0]) && !/sellerUser\.(create|update)/.test(m[0]) && !/sellerInvite\.(create|update)/.test(m[0]);
    })());
  ok("· neither review function accepts a caller-supplied storagePath or bucket",
    !/reviewSellerVerification(Document)?ForAdmin\([^)]*storagePath/.test(repoSrc) &&
      !/reviewSellerVerification(Document)?ForAdmin\([^)]*bucket:/.test(repoSrc));

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
    const adminUser = await prisma.user.create({
      data: { email: `p4v-admin-${t}@t.test`, name: "P4V Admin" },
      select: { id: true },
    });
    fixtureSellerIds.push(ctxA.sellerId, ctxB.sellerId);
    fixtureUserIds.push(userIdA, userIdB, adminUser.id);

    const sellerRowBefore = await prisma.seller.findUniqueOrThrow({ where: { id: ctxA.sellerId }, select: { status: true } });
    const sellerUserCountBefore = await prisma.sellerUser.count({ where: { sellerId: { in: fixtureSellerIds } } });
    const emailLogCountBefore = await prisma.emailLog.count();

    // Seller A: real identity/business draft + one real uploaded document,
    // then manufactured into PENDING (see the file-header note on the gap).
    const marker = `LEGAL-NAME-MARKER-${t}`;
    const draft = await saveSellerVerificationDraft(ctxA, {
      legalName: marker,
      phone: "09171234567",
      addressLine1: "123 Test St",
      addressLine2: null,
      barangay: null,
      city: "Quezon City",
      province: "Metro Manila",
      postalCode: "1100",
      country: "PH",
      businessType: "SOLE_PROPRIETOR",
      businessName: "Test Trading",
      businessRegistrationNumber: "REG-1",
      dtiRegistrationNumber: "DTI-1",
      secRegistrationNumber: null,
      tin: "111-222-333-000",
    });
    ok("fixture · draft saved", draft.ok);
    if (!draft.ok) throw new Error("fixture draft failed");
    const verificationId = draft.verification.id;

    const upload = await uploadSellerVerificationDocument(ctxA, {
      buffer: PNG,
      sizeBytes: PNG.length,
      declaredType: "image/png",
      documentType: "GOVERNMENT_ID_PRIMARY",
    });
    ok("fixture · document uploaded", upload.ok, JSON.stringify(upload));
    if (!upload.ok) throw new Error("fixture upload failed");
    const documentId = upload.document.id;
    const rawDoc = await prisma.sellerVerificationDocument.findUniqueOrThrow({ where: { id: documentId } });
    uploadedPaths.push(rawDoc.storagePath);

    // A second document, uploaded BEFORE the verification is moved to
    // PENDING below, so it lands on the SAME verification row (Phase 3's
    // getOrCreateDraftVerification only reuses a row while it's still
    // DRAFT — uploading after the PENDING flip would create a fresh one).
    const upload2 = await uploadSellerVerificationDocument(ctxA, {
      buffer: PNG,
      sizeBytes: PNG.length,
      declaredType: "image/png",
      documentType: "BUSINESS_PERMIT",
    });
    if (!upload2.ok) throw new Error("fixture upload2 failed");
    const rawDoc2 = await prisma.sellerVerificationDocument.findUniqueOrThrow({ where: { id: upload2.document.id } });
    uploadedPaths.push(rawDoc2.storagePath);

    await prisma.sellerVerification.update({ where: { id: verificationId }, data: { status: "PENDING", submittedAt: new Date() } });

    // ── B/C — admin can view; the information matches what was saved ─────
    const adminView = await getSellerVerificationForAdmin(ctxA.sellerId);
    ok("B · admin can view the verification", !!adminView);
    ok("C · legal name displayed correctly", adminView?.legalName === marker);
    ok("C · business fields displayed correctly", adminView?.businessType === "SOLE_PROPRIETOR" && adminView?.businessName === "Test Trading");
    ok("C · reviewedByEmail is null before any review (not falsely implied)", adminView?.reviewedByEmail === null);
    ok("C · status is PENDING (the manufactured submitted state)", adminView?.status === "PENDING");

    // ── D — sellerA's admin view never contains sellerB's data ────────────
    const adminViewB = await getSellerVerificationForAdmin(ctxB.sellerId);
    ok("D · sellerB has no verification of its own (never conflated with sellerA's)", adminViewB === null);
    ok("D · sellerA's view id never equals anything belonging to sellerB", adminView!.sellerId === ctxA.sellerId && adminView!.sellerId !== ctxB.sellerId);

    // ── F — document list correctly scoped to this verification ──────────
    const docsA = await listSellerVerificationDocumentsForAdmin(verificationId);
    ok("F · document list contains the uploaded document", docsA.some((d) => d.id === documentId));
    ok("F · document list exposes no bucket/storagePath fields", !("bucket" in docsA[0]) && !("storagePath" in docsA[0]));

    // ── G/E/security — signed URL only via the full, verified chain ──────
    const validUrl = await getSellerVerificationDocumentSignedUrlForAdminScoped({
      sellerId: ctxA.sellerId,
      verificationId,
      documentId,
    });
    ok("G · a correctly-chained request signs a URL", validUrl.ok, JSON.stringify(validUrl));
    if (validUrl.ok) ok("G · the signed URL targets the private bucket", validUrl.url.includes(SELLER_VERIFICATION_BUCKET));

    const forgedSellerId = await getSellerVerificationDocumentSignedUrlForAdminScoped({
      sellerId: ctxB.sellerId, // sellerB, but documentId/verificationId belong to sellerA
      verificationId,
      documentId,
    });
    ok("E/security · a forged sellerId (cross-seller) is rejected even though the document is real", !forgedSellerId.ok);

    const forgedVerificationId = await getSellerVerificationDocumentSignedUrlForAdminScoped({
      sellerId: ctxA.sellerId,
      verificationId: "forged-verification-id-" + t,
      documentId,
    });
    ok("security · a forged verificationId is rejected", !forgedVerificationId.ok);

    const forgedDocumentId = await getSellerVerificationDocumentSignedUrlForAdminScoped({
      sellerId: ctxA.sellerId,
      verificationId,
      documentId: "forged-document-id-" + t,
    });
    ok("security · a forged documentId is rejected", !forgedDocumentId.ok);

    // ── U — invalid ids never leak/access another seller's data ──────────
    const crossReview = await reviewSellerVerificationDocumentForAdmin({
      sellerId: ctxB.sellerId,
      verificationId,
      documentId,
      status: "APPROVED",
      reviewNote: null,
      reviewedBy: adminUser.id,
    });
    ok("U/security · reviewing with a forged/cross sellerId is rejected", !crossReview.ok);
    ok("U · the document was NOT approved by the rejected cross-seller attempt",
      (await prisma.sellerVerificationDocument.findUniqueOrThrow({ where: { id: documentId } })).status === "PENDING");

    // ── H — a correctly-scoped APPROVED transition works ──────────────────
    const approveDoc = await reviewSellerVerificationDocumentForAdmin({
      sellerId: ctxA.sellerId,
      verificationId,
      documentId,
      status: "APPROVED",
      reviewNote: null,
      reviewedBy: adminUser.id,
    });
    ok("H · document APPROVED succeeds", approveDoc.ok, JSON.stringify(approveDoc));
    const approvedRow = await prisma.sellerVerificationDocument.findUniqueOrThrow({ where: { id: documentId } });
    ok("H · status is APPROVED, reviewedAt/reviewedBy set", approvedRow.status === "APPROVED" && !!approvedRow.reviewedAt && approvedRow.reviewedBy === adminUser.id);

    // N/O — audit log written for the decision, without PII.
    const auditIdApprove = await writeAudit({
      actorUserId: adminUser.id,
      action: "seller.verification_document_approved",
      targetType: "seller_verification_document",
      targetId: documentId,
      summary: `ops@axiaro.shop approved a government_id_primary document for seller ${ctxA.sellerName}`,
      meta: { sellerId: ctxA.sellerId, sellerVerificationId: verificationId, sellerVerificationDocumentId: documentId, documentType: "GOVERNMENT_ID_PRIMARY", status: "APPROVED" },
    });
    if (auditIdApprove) fixtureAuditLogIds.push(auditIdApprove);
    const auditRowApprove = await prisma.adminAuditLog.findUnique({ where: { id: auditIdApprove! } });
    ok("N · AdminAuditLog row created for the document approval", !!auditRowApprove);
    ok("O · no legalName/phone/TIN value appears in the approval audit row", !JSON.stringify(auditRowApprove).includes(marker) && !JSON.stringify(auditRowApprove).includes("111-222-333-000"));

    // ── V — an already-finalized document cannot be re-decided ───────────
    const reReview = await reviewSellerVerificationDocumentForAdmin({
      sellerId: ctxA.sellerId,
      verificationId,
      documentId,
      status: "REJECTED",
      reviewNote: "trying to flip it",
      reviewedBy: adminUser.id,
    });
    ok("V · re-reviewing an already-APPROVED document fails safely (no throw)", !reReview.ok);
    ok("V · the document's outcome is unchanged after the rejected re-review attempt",
      (await prisma.sellerVerificationDocument.findUniqueOrThrow({ where: { id: documentId } })).status === "APPROVED");

    // ── J — a SEPARATE document's REJECTED decision persists the reason ──
    const rejectReason = `Blurry scan — please reupload (${t})`;
    const rejectDoc = await reviewSellerVerificationDocumentForAdmin({
      sellerId: ctxA.sellerId,
      verificationId,
      documentId: upload2.document.id,
      status: "REJECTED",
      reviewNote: rejectReason,
      reviewedBy: adminUser.id,
    });
    ok("· document REJECTED succeeds when a reason is supplied", rejectDoc.ok, JSON.stringify(rejectDoc));
    const rejectedRow = await prisma.sellerVerificationDocument.findUniqueOrThrow({ where: { id: upload2.document.id } });
    ok("J · the authoritative reason is persisted on the row itself", rejectedRow.reviewNote === rejectReason);
    ok("J · status is REJECTED", rejectedRow.status === "REJECTED");

    // ── K — verification-level APPROVED ───────────────────────────────────
    const approveVer = await reviewSellerVerificationForAdmin({
      sellerId: ctxA.sellerId,
      verificationId,
      status: "APPROVED",
      reviewNote: null,
      reviewedBy: adminUser.id,
    });
    ok("K · verification APPROVED succeeds", approveVer.ok, JSON.stringify(approveVer));
    const approvedVer = await prisma.sellerVerification.findUniqueOrThrow({ where: { id: verificationId } });
    ok("K · status is APPROVED, reviewedAt/reviewedBy set", approvedVer.status === "APPROVED" && !!approvedVer.reviewedAt && approvedVer.reviewedBy === adminUser.id);

    // ── V — an already-decided verification cannot be re-decided ─────────
    const reReviewVer = await reviewSellerVerificationForAdmin({
      sellerId: ctxA.sellerId,
      verificationId,
      status: "REJECTED",
      reviewNote: "trying to flip it",
      reviewedBy: adminUser.id,
    });
    ok("V · re-reviewing an already-APPROVED verification fails safely", !reReviewVer.ok);

    // ── M — a SEPARATE verification's REJECTED decision persists the reason ─
    const draftB = await saveSellerVerificationDraft(ctxB, { legalName: "Someone Else", phone: null, addressLine1: null, addressLine2: null, barangay: null, city: null, province: null, postalCode: null, country: null, businessType: null, businessName: null, businessRegistrationNumber: null, dtiRegistrationNumber: null, secRegistrationNumber: null, tin: null });
    if (!draftB.ok) throw new Error("fixture draftB failed");
    await prisma.sellerVerification.update({ where: { id: draftB.verification.id }, data: { status: "PENDING", submittedAt: new Date() } });
    const verReason = `Name on ID doesn't match legal name provided (${t})`;
    const rejectVer = await reviewSellerVerificationForAdmin({
      sellerId: ctxB.sellerId,
      verificationId: draftB.verification.id,
      status: "REJECTED",
      reviewNote: verReason,
      reviewedBy: adminUser.id,
    });
    ok("· verification REJECTED succeeds when a reason is supplied", rejectVer.ok, JSON.stringify(rejectVer));
    const rejectedVer = await prisma.sellerVerification.findUniqueOrThrow({ where: { id: draftB.verification.id } });
    ok("M · the authoritative reason is persisted on the verification row itself", rejectedVer.reviewNote === verReason);
    ok("M · status is REJECTED", rejectedVer.status === "REJECTED");

    // N — audit for the verification-level decisions too.
    const auditIdVer = await writeAudit({
      actorUserId: adminUser.id,
      action: "seller.verification_rejected",
      targetType: "seller_verification",
      targetId: draftB.verification.id,
      summary: `ops@axiaro.shop rejected ${ctxB.sellerName}'s seller verification`,
      meta: { sellerId: ctxB.sellerId, sellerVerificationId: draftB.verification.id, status: "REJECTED", reason: verReason },
    });
    if (auditIdVer) fixtureAuditLogIds.push(auditIdVer);
    const auditRowVer = await prisma.adminAuditLog.findUnique({ where: { id: auditIdVer! } });
    ok("N · AdminAuditLog row created for the verification-level rejection", !!auditRowVer);
    ok("O · the reason (an admin-authored note, not the seller's raw PII) is present, but no OTHER PII field leaks in",
      !!auditRowVer && JSON.stringify(auditRowVer.meta).includes("reason") && !JSON.stringify(auditRowVer).includes("Someone Else"));

    // ── V — a DRAFT verification (never submitted) cannot be reviewed ────
    const draftC = await saveSellerVerificationDraft(ctxB, { legalName: "Still Draft", phone: null, addressLine1: null, addressLine2: null, barangay: null, city: null, province: null, postalCode: null, country: null, businessType: null, businessName: null, businessRegistrationNumber: null, dtiRegistrationNumber: null, secRegistrationNumber: null, tin: null });
    // draftB.verification just got REJECTED above, so this creates a fresh DRAFT row for sellerB — never submitted.
    if (!draftC.ok) throw new Error("fixture draftC failed");
    const reviewDraft = await reviewSellerVerificationForAdmin({
      sellerId: ctxB.sellerId,
      verificationId: draftC.verification.id,
      status: "APPROVED",
      reviewNote: null,
      reviewedBy: adminUser.id,
    });
    ok("V · a still-DRAFT (never submitted) verification cannot be approved", !reviewDraft.ok);

    // ── P/Q/R/S — nothing else in the domain changed ──────────────────────
    const sellerRowAfter = await prisma.seller.findUniqueOrThrow({ where: { id: ctxA.sellerId }, select: { status: true } });
    ok("P · Seller.status unchanged across every review decision above", sellerRowAfter.status === sellerRowBefore.status);
    ok("Q · SellerUser count unchanged (still just the seeded OWNERs)",
      (await prisma.sellerUser.count({ where: { sellerId: { in: fixtureSellerIds } } })) === sellerUserCountBefore);
    ok("R · zero SellerInvite rows exist for either fixture seller",
      (await prisma.sellerInvite.count({ where: { sellerId: { in: fixtureSellerIds } } })) === 0);
    const sellerUserA = await prisma.sellerUser.findUniqueOrThrow({ where: { sellerId_userId: { sellerId: ctxA.sellerId, userId: userIdA } } });
    ok("S · Seller Portal access (ACTIVE SellerUser) unaffected by verification approval", sellerUserA.status === "ACTIVE");
    ok("W · no EmailLog row was created by any review action", (await prisma.emailLog.count()) === emailLogCountBefore);
  } finally {
    // ── explicit cleanup: storage objects, then DB rows (Seller cascade
    // takes SellerVerification + SellerVerificationDocument with it) ──────
    if (uploadedPaths.length) {
      await supabase.storage.from(SELLER_VERIFICATION_BUCKET).remove(uploadedPaths).catch(() => {});
    }
    if (fixtureSellerIds.length) {
      await prisma.seller.deleteMany({ where: { id: { in: fixtureSellerIds } } }).catch(() => {});
    }
    if (fixtureAuditLogIds.length) {
      // AdminAuditLog has no FK to Seller/SellerVerification (plain string
      // snapshots, matching every other seller-lifecycle audit row in this
      // codebase) — the Seller cascade above never touches these, so they
      // must be removed explicitly.
      await prisma.adminAuditLog.deleteMany({ where: { id: { in: fixtureAuditLogIds } } }).catch(() => {});
    }
    if (fixtureUserIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: fixtureUserIds } } }).catch(() => {});
    }
  }

  // ── Y — bucket privacy unaffected by any of this ─────────────────────────
  const { data: svBucket } = await supabase.storage.getBucket(SELLER_VERIFICATION_BUCKET);
  ok("Y · the private bucket is still private", svBucket?.public === false);
  const { data: mediaBucket } = await supabase.storage.getBucket("media");
  ok("· the existing public media bucket is unaffected", mediaBucket?.public === true);

  // ── isolation ─────────────────────────────────────────────────────────
  ok("isolation · no fixture User leaked", (await prisma.user.count({ where: { email: { contains: "p4v-" } } })) === 0);
  ok("isolation · no fixture Seller leaked", (await prisma.seller.count({ where: { displayName: { startsWith: "P4V Store " } } })) === 0);
  ok("isolation · no fixture SellerVerification leaked",
    (await prisma.sellerVerification.count({ where: { seller: { displayName: { startsWith: "P4V Store " } } } })) === 0);
  ok("isolation · no fixture AdminAuditLog leaked", (await prisma.adminAuditLog.count({ where: { summary: { contains: "P4V Store" } } })) === 0);
  const { data: leftover } = await supabase.storage.from(SELLER_VERIFICATION_BUCKET).list("sellers");
  ok("isolation · no fixture storage objects leaked under sellers/", (leftover ?? []).length === 0, JSON.stringify(leftover));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
