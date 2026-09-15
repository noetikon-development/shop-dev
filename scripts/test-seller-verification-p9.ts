/**
 * Seller Verification — submission document/field requirements (Phase 9).
 *
 * Replaces the original Phase 5 "at least one document, of any type" rule
 * with the real business policy: required identity fields + required
 * document TYPES, both varying by business type. This file (a) unit-tests
 * the new pure `validateSellerVerificationSubmission` function directly for
 * every scenario the business policy specifies, and (b) drives the real
 * `submitSellerVerificationForReview` repository function against real,
 * committed fixtures (same reason as every prior phase: that function uses
 * the bare `prisma` client internally, no injectable transaction for the
 * document-upload path it depends on).
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-seller-verification-p9.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { createSeller } from "../src/lib/admin/sellers/repository";
import { createAdminClient } from "../src/lib/supabase/admin";
import { SELLER_VERIFICATION_BUCKET } from "../src/lib/seller-verification/storage";
import {
  validateSellerVerificationSubmission,
  requiredDocumentTypesForBusinessType,
  type SellerVerificationSubmissionCheckInput,
} from "../src/lib/seller-verification/validation";
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

const COMPLETE_INDIVIDUAL: SellerVerificationSubmissionCheckInput = {
  businessType: "INDIVIDUAL",
  legalName: "Juan Dela Cruz",
  phone: "09171234567",
  addressLine1: "123 Rizal St",
  city: "Quezon City",
  province: "Metro Manila",
  postalCode: "1100",
  country: "PH",
  businessName: null,
  documentTypes: ["GOVERNMENT_ID_PRIMARY"],
};

const COMPLETE_BUSINESS = (businessType: string): SellerVerificationSubmissionCheckInput => ({
  ...COMPLETE_INDIVIDUAL,
  businessType,
  businessName: "Juan's Store",
  documentTypes: ["GOVERNMENT_ID_PRIMARY", "BUSINESS_REGISTRATION"],
});

async function main() {
  console.log("\nSeller Verification — submission document/field requirements (Phase 9)\n");

  // ── static — wiring, scope discipline ────────────────────────────────────
  const repoSrc = read("src/lib/seller-verification/repository.ts");
  const validationSrc = read("src/lib/seller-verification/validation.ts");
  const docsUiSrc = read("src/components/seller/verification-documents.tsx");
  const pageSrc = read("src/app/seller/(portal)/verification/page.tsx");

  ok("· submitSellerVerificationForReview now calls validateSellerVerificationSubmission",
    (() => {
      const m = repoSrc.match(/export async function submitSellerVerificationForReview[\s\S]*?\n(?=export |\/\/ -{3})/);
      return !!m && /validateSellerVerificationSubmission\(/.test(m[0]);
    })());
  ok("· the old permissive 'at least one document, of any type' rule is gone",
    !/Upload at least one document before submitting\./.test(repoSrc));
  ok("· the already-reviewed-document guard is still present, unchanged",
    /One of your documents has already been reviewed\. Contact support before resubmitting\./.test(repoSrc));
  ok("scope · BUSINESS_PERMIT is defined for completeness but never auto-emitted by validateSellerVerificationSubmission",
    (() => {
      const m = validationSrc.match(/export function validateSellerVerificationSubmission[\s\S]*?\n\}/);
      return !!m && /MISSING_BUSINESS_PERMIT/.test(validationSrc) && !/push\("MISSING_BUSINESS_PERMIT"\)/.test(m[0]);
    })());
  ok("scope · no external DTI/SEC/BIR verification, phone OTP, or malware-scanning keyword introduced",
    !/dti.{0,20}api|sec.{0,20}api|bir.{0,20}api|otp|malware|virus.?scan/i.test(validationSrc + repoSrc));
  ok("scope · Phase 6 gate files untouched by this phase",
    !/Phase 9(?!F)/.test(read("src/lib/marketplace/seller-repository.ts")) && !/Phase 9(?!F)/.test(read("src/lib/seller/session.ts")));
  ok("scope · Phase 7 email files untouched by this phase",
    !/Phase 9(?!F)/.test(read("src/lib/email/notifications.ts")) && !/Phase 9(?!F)/.test(read("src/lib/email/send.ts")));
  ok("scope · Phase 8 guard (getOrCreateDraftVerification APPROVED check) untouched",
    /if \(existing && existing\.status === "APPROVED"\) return existing;/.test(repoSrc));
  ok("scope · admin review logic (reviewSellerVerificationForAdmin) untouched",
    !/Phase 9(?!F)/.test(repoSrc.match(/export async function reviewSellerVerificationForAdmin[\s\S]*?\n\}/)?.[0] ?? ""));
  ok("scope · scripts/seed-rbac.ts untouched by this phase", !/Phase 9(?!F)/.test(read("scripts/seed-rbac.ts")));
  ok("UI · verification-documents.tsx uses the shared requiredDocumentTypesForBusinessType (never a second, hand-rolled rule)",
    /requiredDocumentTypesForBusinessType/.test(docsUiSrc));
  ok("UI · the verification page computes its requirements preview from the SAME shared function the server uses",
    /validateSellerVerificationSubmission/.test(pageSrc));

  // ── pure-function tests — validateSellerVerificationSubmission ──────────
  console.log("\n── A · INDIVIDUAL ──");
  ok("A1 · complete required data + primary ID => allowed", validateSellerVerificationSubmission(COMPLETE_INDIVIDUAL).ok === true);
  ok("A2 · no primary ID => blocked (MISSING_PRIMARY_GOVERNMENT_ID)",
    (() => { const r = validateSellerVerificationSubmission({ ...COMPLETE_INDIVIDUAL, documentTypes: [] }); return !r.ok && r.codes.includes("MISSING_PRIMARY_GOVERNMENT_ID"); })());
  ok("A3 · OTHER only => blocked (does not satisfy primary ID requirement)",
    (() => { const r = validateSellerVerificationSubmission({ ...COMPLETE_INDIVIDUAL, documentTypes: ["OTHER"] }); return !r.ok && r.codes.includes("MISSING_PRIMARY_GOVERNMENT_ID"); })());
  ok("A4 · missing legal name => blocked (MISSING_LEGAL_NAME)",
    (() => { const r = validateSellerVerificationSubmission({ ...COMPLETE_INDIVIDUAL, legalName: null }); return !r.ok && r.codes.includes("MISSING_LEGAL_NAME"); })());
  ok("A5 · missing phone => blocked (MISSING_PHONE)",
    (() => { const r = validateSellerVerificationSubmission({ ...COMPLETE_INDIVIDUAL, phone: "" }); return !r.ok && r.codes.includes("MISSING_PHONE"); })());
  ok("A6 · missing address => blocked (MISSING_ADDRESS)",
    (() => { const r = validateSellerVerificationSubmission({ ...COMPLETE_INDIVIDUAL, city: null }); return !r.ok && r.codes.includes("MISSING_ADDRESS"); })());

  console.log("\n── B · SOLE_PROPRIETOR ──");
  ok("B1 · required data + primary ID + business registration => allowed", validateSellerVerificationSubmission(COMPLETE_BUSINESS("SOLE_PROPRIETOR")).ok === true);
  ok("B2 · missing primary ID => blocked",
    (() => { const r = validateSellerVerificationSubmission({ ...COMPLETE_BUSINESS("SOLE_PROPRIETOR"), documentTypes: ["BUSINESS_REGISTRATION"] }); return !r.ok && r.codes.includes("MISSING_PRIMARY_GOVERNMENT_ID"); })());
  ok("B3 · missing business registration => blocked",
    (() => { const r = validateSellerVerificationSubmission({ ...COMPLETE_BUSINESS("SOLE_PROPRIETOR"), documentTypes: ["GOVERNMENT_ID_PRIMARY"] }); return !r.ok && r.codes.includes("MISSING_BUSINESS_REGISTRATION"); })());
  ok("B4 · OTHER only => blocked (both required types missing)",
    (() => { const r = validateSellerVerificationSubmission({ ...COMPLETE_BUSINESS("SOLE_PROPRIETOR"), documentTypes: ["OTHER"] }); return !r.ok && r.codes.includes("MISSING_PRIMARY_GOVERNMENT_ID") && r.codes.includes("MISSING_BUSINESS_REGISTRATION"); })());
  ok("B5 · missing business name => blocked (MISSING_BUSINESS_NAME, business types only)",
    (() => { const r = validateSellerVerificationSubmission({ ...COMPLETE_BUSINESS("SOLE_PROPRIETOR"), businessName: null }); return !r.ok && r.codes.includes("MISSING_BUSINESS_NAME"); })());

  console.log("\n── C · PARTNERSHIP ──");
  ok("C1 · missing registration => blocked", (() => { const r = validateSellerVerificationSubmission({ ...COMPLETE_BUSINESS("PARTNERSHIP"), documentTypes: ["GOVERNMENT_ID_PRIMARY"] }); return !r.ok && r.codes.includes("MISSING_BUSINESS_REGISTRATION"); })());
  ok("C2 · complete minimum evidence => allowed", validateSellerVerificationSubmission(COMPLETE_BUSINESS("PARTNERSHIP")).ok === true);

  console.log("\n── D · CORPORATION ──");
  ok("D1 · missing registration => blocked", (() => { const r = validateSellerVerificationSubmission({ ...COMPLETE_BUSINESS("CORPORATION"), documentTypes: ["GOVERNMENT_ID_PRIMARY"] }); return !r.ok && r.codes.includes("MISSING_BUSINESS_REGISTRATION"); })());
  ok("D2 · complete minimum evidence => allowed", validateSellerVerificationSubmission(COMPLETE_BUSINESS("CORPORATION")).ok === true);

  console.log("\n── E · optional documents never become mandatory ──");
  ok("E1 · secondary ID present but primary absent => still blocked (secondary never substitutes)",
    (() => { const r = validateSellerVerificationSubmission({ ...COMPLETE_INDIVIDUAL, documentTypes: ["GOVERNMENT_ID_SECONDARY"] }); return !r.ok && r.codes.includes("MISSING_PRIMARY_GOVERNMENT_ID"); })());
  ok("E2 · proof of address present but primary absent => still blocked (proof of address never substitutes)",
    (() => { const r = validateSellerVerificationSubmission({ ...COMPLETE_INDIVIDUAL, documentTypes: ["PROOF_OF_ADDRESS"] }); return !r.ok && r.codes.includes("MISSING_PRIMARY_GOVERNMENT_ID"); })());
  ok("E3 · neither GOVERNMENT_ID_SECONDARY nor PROOF_OF_ADDRESS ever appear in requiredDocumentTypesForBusinessType, any business type",
    (["INDIVIDUAL", "SOLE_PROPRIETOR", "PARTNERSHIP", "CORPORATION", null] as const).every((bt) => {
      const req = requiredDocumentTypesForBusinessType(bt);
      return !req.includes("GOVERNMENT_ID_SECONDARY") && !req.includes("PROOF_OF_ADDRESS");
    }));
  ok("E4 · complete INDIVIDUAL WITH extra optional docs attached => still allowed (optional docs never block)",
    validateSellerVerificationSubmission({ ...COMPLETE_INDIVIDUAL, documentTypes: ["GOVERNMENT_ID_PRIMARY", "GOVERNMENT_ID_SECONDARY", "PROOF_OF_ADDRESS"] }).ok === true);

  console.log("\n── H · error determinism ──");
  {
    const r1 = validateSellerVerificationSubmission({ ...COMPLETE_INDIVIDUAL, legalName: null });
    const r2 = validateSellerVerificationSubmission({ ...COMPLETE_INDIVIDUAL, legalName: null });
    ok("H1 · the same missing requirement produces the SAME error code on repeated calls",
      !r1.ok && !r2.ok && JSON.stringify(r1.codes) === JSON.stringify(r2.codes) && r1.codes.length === 1 && r1.codes[0] === "MISSING_LEGAL_NAME");
  }
  {
    const businessTypeNull = validateSellerVerificationSubmission({ ...COMPLETE_INDIVIDUAL, businessType: null });
    ok("· no business type selected resolves to the INDIVIDUAL (least-restrictive) tier — no MISSING_BUSINESS_* code, no false block",
      businessTypeNull.ok === true);
  }

  // ── F — production (READ-ONLY): Axiaro remains exempt, untouched ────────
  console.log("\n── F · FIRST_PARTY (Axiaro) exemption ──");
  {
    const axiaro = await prisma.seller.findFirst({ where: { displayName: "Axiaro" }, select: { type: true, status: true } });
    ok("F1 · Axiaro is still FIRST_PARTY / APPROVED", axiaro?.type === "FIRST_PARTY" && axiaro?.status === "APPROVED", JSON.stringify(axiaro));
    ok("F2 · Axiaro still has zero SellerVerification rows (this phase creates none)",
      (await prisma.sellerVerification.count({ where: { seller: { displayName: "Axiaro" } } })) === 0);
  }

  // ── G/I — real, committed fixtures (cleaned up explicitly at the end) ───
  const t = Date.now().toString(36);
  const supabase = createAdminClient();
  const uploadedPaths: string[] = [];
  const fixtureSellerIds: string[] = [];
  const fixtureUserIds: string[] = [];

  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 9)]);
  const EMPTY_PATCH: SellerVerificationDraftPatch = {
    legalName: null, phone: null, addressLine1: null, addressLine2: null, barangay: null,
    city: null, province: null, postalCode: null, country: null, businessType: null,
    businessName: null, businessRegistrationNumber: null, dtiRegistrationNumber: null,
    secRegistrationNumber: null, tin: null,
  };

  async function seedSellerWithOwner(tag: string): Promise<{ ctx: SellerContext; sellerId: string; userId: string }> {
    const user = await prisma.user.create({ data: { email: `p9v-${tag}-${Math.random().toString(36).slice(2, 8)}@t.test`, name: "P9V User" }, select: { id: true } });
    const created = await createSeller(
      { displayName: `P9V Store ${tag}`, slug: `p9v-store-${tag}-${Math.random().toString(36).slice(2, 7)}`, supportEmail: `p9v-support-${tag}@t.test` },
      prisma,
    );
    if (!created.ok) throw new Error(`fixture setup failed: ${JSON.stringify(created)}`);
    const sellerUser = await prisma.sellerUser.create({ data: { sellerId: created.sellerId, userId: user.id, role: "OWNER", status: "ACTIVE" } });
    return {
      userId: user.id,
      sellerId: created.sellerId,
      ctx: {
        sellerId: created.sellerId, sellerName: created.displayName, sellerUserId: sellerUser.id,
        userId: user.id, role: "OWNER", permissions: new Set(["manage_seller_settings"]),
      },
    };
  }

  try {
    console.log("\n── G · server-side enforcement (real submit path) ──");
    // G1 — an incomplete INDIVIDUAL (no document at all) is blocked server-side.
    const { ctx: ctxG1, sellerId: sellerG1, userId: userG1 } = await seedSellerWithOwner(`g1-${t}`);
    fixtureSellerIds.push(sellerG1); fixtureUserIds.push(userG1);
    const draftG1 = await saveSellerVerificationDraft(ctxG1, {
      ...EMPTY_PATCH, legalName: "Test Seller", phone: "09171234567", addressLine1: "1 Test St",
      city: "Quezon City", province: "Metro Manila", postalCode: "1100", country: "PH", businessType: "INDIVIDUAL",
    });
    if (!draftG1.ok) throw new Error("fixture draftG1 failed");
    const submitG1 = await submitSellerVerificationForReview(ctxG1);
    ok("G1 · calling submit directly (no UI) on an incomplete INDIVIDUAL (no document) is blocked",
      !submitG1.ok && submitG1.status === "INVALID" && Boolean(submitG1.codes?.includes("MISSING_PRIMARY_GOVERNMENT_ID")), JSON.stringify(submitG1));
    const rowAfterG1 = await prisma.sellerVerification.findUniqueOrThrow({ where: { id: draftG1.verification.id } });
    ok("G1 · the verification stays DRAFT after the blocked submission", rowAfterG1.status === "DRAFT");

    // G2 — complete it, then submission succeeds.
    const uploadG1 = await uploadSellerVerificationDocument(ctxG1, { buffer: PNG, sizeBytes: PNG.length, declaredType: "image/png", documentType: "GOVERNMENT_ID_PRIMARY" });
    ok("fixture · primary ID uploaded", uploadG1.ok, JSON.stringify(uploadG1));
    if (uploadG1.ok) {
      const rawDoc = await prisma.sellerVerificationDocument.findUniqueOrThrow({ where: { id: uploadG1.document.id } });
      uploadedPaths.push(rawDoc.storagePath);
    }
    const submitG2 = await submitSellerVerificationForReview(ctxG1);
    ok("G2 · after uploading the required primary ID, the SAME submit path now succeeds", submitG2.ok === true, JSON.stringify(submitG2));

    // G3 — a business seller (SOLE_PROPRIETOR) missing the business-registration document is blocked.
    const { ctx: ctxG3, sellerId: sellerG3, userId: userG3 } = await seedSellerWithOwner(`g3-${t}`);
    fixtureSellerIds.push(sellerG3); fixtureUserIds.push(userG3);
    const draftG3 = await saveSellerVerificationDraft(ctxG3, {
      ...EMPTY_PATCH, legalName: "Biz Owner", phone: "09171234567", addressLine1: "1 Biz St",
      city: "Manila", province: "Metro Manila", postalCode: "1000", country: "PH",
      businessType: "SOLE_PROPRIETOR", businessName: "Biz Store",
    });
    if (!draftG3.ok) throw new Error("fixture draftG3 failed");
    const uploadG3 = await uploadSellerVerificationDocument(ctxG3, { buffer: PNG, sizeBytes: PNG.length, declaredType: "image/png", documentType: "GOVERNMENT_ID_PRIMARY" });
    if (uploadG3.ok) {
      const rawDoc = await prisma.sellerVerificationDocument.findUniqueOrThrow({ where: { id: uploadG3.document.id } });
      uploadedPaths.push(rawDoc.storagePath);
    }
    const submitG3 = await submitSellerVerificationForReview(ctxG3);
    ok("G3 · SOLE_PROPRIETOR with a primary ID but NO business registration document is blocked",
      !submitG3.ok && Boolean(submitG3.codes?.includes("MISSING_BUSINESS_REGISTRATION")), JSON.stringify(submitG3));

    const uploadG3b = await uploadSellerVerificationDocument(ctxG3, { buffer: PNG, sizeBytes: PNG.length, declaredType: "image/png", documentType: "BUSINESS_REGISTRATION" });
    if (uploadG3b.ok) {
      const rawDoc = await prisma.sellerVerificationDocument.findUniqueOrThrow({ where: { id: uploadG3b.document.id } });
      uploadedPaths.push(rawDoc.storagePath);
    }
    const submitG3b = await submitSellerVerificationForReview(ctxG3);
    ok("G3b · after adding the business registration document, submission now succeeds", submitG3b.ok === true, JSON.stringify(submitG3b));

    // ── I — existing behaviour unchanged ────────────────────────────────────
    console.log("\n── I · existing behaviour unchanged ──");
    const adminUser = await prisma.user.create({ data: { email: `p9v-admin-${t}@t.test`, name: "P9V Admin" }, select: { id: true } });
    fixtureUserIds.push(adminUser.id);

    // REJECTED seller can still start a new DRAFT.
    const { ctx: ctxI1, sellerId: sellerI1, userId: userI1 } = await seedSellerWithOwner(`i1-${t}`);
    fixtureSellerIds.push(sellerI1); fixtureUserIds.push(userI1);
    const draftI1 = await saveSellerVerificationDraft(ctxI1, {
      ...EMPTY_PATCH, legalName: "Reject Me", phone: "09171234567", addressLine1: "1 St",
      city: "Manila", province: "Metro Manila", postalCode: "1000", country: "PH", businessType: "INDIVIDUAL",
    });
    if (!draftI1.ok) throw new Error("fixture draftI1 failed");
    const uploadI1 = await uploadSellerVerificationDocument(ctxI1, { buffer: PNG, sizeBytes: PNG.length, declaredType: "image/png", documentType: "GOVERNMENT_ID_PRIMARY" });
    if (uploadI1.ok) {
      const rawDoc = await prisma.sellerVerificationDocument.findUniqueOrThrow({ where: { id: uploadI1.document.id } });
      uploadedPaths.push(rawDoc.storagePath);
    }
    const submitI1 = await submitSellerVerificationForReview(ctxI1);
    ok("fixture · sellerI1 submits successfully", submitI1.ok, JSON.stringify(submitI1));
    if (submitI1.ok) {
      const reject = await reviewSellerVerificationForAdmin({ sellerId: sellerI1, verificationId: submitI1.verification.id, status: "REJECTED", reviewNote: "test rejection", reviewedBy: adminUser.id });
      ok("fixture · admin rejects sellerI1", reject.ok, JSON.stringify(reject));
      const resubmitDraft = await saveSellerVerificationDraft(ctxI1, { ...EMPTY_PATCH, legalName: "Second Attempt" });
      ok("I1 · REJECTED seller's save-draft still creates a fresh DRAFT (unchanged by this phase)",
        resubmitDraft.ok === true && resubmitDraft.verification.id !== draftI1.verification.id, JSON.stringify(resubmitDraft));
    }

    // APPROVED seller remains protected from reopening (Phase 8, unaffected).
    const { ctx: ctxI2, sellerId: sellerI2, userId: userI2 } = await seedSellerWithOwner(`i2-${t}`);
    fixtureSellerIds.push(sellerI2); fixtureUserIds.push(userI2);
    const draftI2 = await saveSellerVerificationDraft(ctxI2, {
      ...EMPTY_PATCH, legalName: "Approve Me", phone: "09171234567", addressLine1: "1 St",
      city: "Manila", province: "Metro Manila", postalCode: "1000", country: "PH", businessType: "INDIVIDUAL",
    });
    if (!draftI2.ok) throw new Error("fixture draftI2 failed");
    const uploadI2 = await uploadSellerVerificationDocument(ctxI2, { buffer: PNG, sizeBytes: PNG.length, declaredType: "image/png", documentType: "GOVERNMENT_ID_PRIMARY" });
    if (uploadI2.ok) {
      const rawDoc = await prisma.sellerVerificationDocument.findUniqueOrThrow({ where: { id: uploadI2.document.id } });
      uploadedPaths.push(rawDoc.storagePath);
    }
    const submitI2 = await submitSellerVerificationForReview(ctxI2);
    if (submitI2.ok) {
      const approve = await reviewSellerVerificationForAdmin({ sellerId: sellerI2, verificationId: submitI2.verification.id, status: "APPROVED", reviewNote: null, reviewedBy: adminUser.id });
      ok("fixture · admin approves sellerI2", approve.ok, JSON.stringify(approve));
      const restrayDraft = await saveSellerVerificationDraft(ctxI2, { ...EMPTY_PATCH, legalName: "Sneaky Reopen" });
      ok("I2 · APPROVED seller's stray save-draft attempt is STILL rejected (Phase 8 unaffected by this phase)",
        !restrayDraft.ok && restrayDraft.error === "This verification is no longer editable.", JSON.stringify(restrayDraft));
    }
  } finally {
    if (uploadedPaths.length) {
      await supabase.storage.from(SELLER_VERIFICATION_BUCKET).remove(uploadedPaths).catch(() => {});
    }
    if (fixtureSellerIds.length) {
      await prisma.seller.deleteMany({ where: { id: { in: fixtureSellerIds } } }).catch(() => {});
    }
    if (fixtureUserIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: fixtureUserIds } } }).catch(() => {});
    }
  }

  // ── isolation ─────────────────────────────────────────────────────────
  ok("isolation · no fixture User leaked", (await prisma.user.count({ where: { email: { contains: "p9v-" } } })) === 0);
  ok("isolation · no fixture Seller leaked", (await prisma.seller.count({ where: { displayName: { startsWith: "P9V Store " } } })) === 0);
  ok("isolation · no fixture SellerVerification leaked",
    (await prisma.sellerVerification.count({ where: { seller: { displayName: { startsWith: "P9V Store " } } } })) === 0);
  const { data: leftover } = await supabase.storage.from(SELLER_VERIFICATION_BUCKET).list("sellers");
  ok("isolation · no fixture storage objects leaked under sellers/", (leftover ?? []).length === 0, JSON.stringify(leftover));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
