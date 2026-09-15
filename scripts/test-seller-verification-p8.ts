/**
 * Seller Verification — protect APPROVED from stray drafts (Phase 8).
 *
 * `getOrCreateDraftVerification` (shared by `saveSellerVerificationDraft` and
 * `uploadSellerVerificationDocument`) now returns an APPROVED latest row
 * AS-IS instead of silently starting a new DRAFT cycle. Both callers already
 * check (or now check) `status !== "DRAFT"` and fail safely.
 *
 * `reviewSellerVerificationForAdmin` uses the bare `prisma` client (no
 * injectable transaction — same as every prior phase's design), so this file
 * uses real, committed fixtures with explicit cleanup, matching Phases 3-7.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-seller-verification-p8.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { createSeller } from "../src/lib/admin/sellers/repository";
import { createAdminClient } from "../src/lib/supabase/admin";
import { SELLER_VERIFICATION_BUCKET } from "../src/lib/seller-verification/storage";
import {
  saveSellerVerificationDraft,
  uploadSellerVerificationDocument,
  submitSellerVerificationForReview,
  reviewSellerVerificationForAdmin,
  type SellerVerificationDraftPatch,
} from "../src/lib/seller-verification/repository";
import { createSellerOffer, setSellerOfferStatus } from "../src/lib/marketplace/seller-repository";
import type { SellerContext } from "../src/lib/marketplace/types";

const prisma = new PrismaClient();

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const EMPTY_PATCH: SellerVerificationDraftPatch = {
  legalName: null, phone: null, addressLine1: null, addressLine2: null, barangay: null,
  city: null, province: null, postalCode: null, country: null, businessType: null,
  businessName: null, businessRegistrationNumber: null, dtiRegistrationNumber: null,
  secRegistrationNumber: null, tin: null,
};

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 8)]);

function fakeSellerInput(tag: string) {
  return {
    displayName: `P8V Store ${tag}`,
    slug: `p8v-store-${tag}-${Math.random().toString(36).slice(2, 7)}`,
    supportEmail: `p8v-support-${tag}@t.test`,
  };
}

async function seedSellerWithOwner(tag: string): Promise<{ ctx: SellerContext; userId: string; sellerId: string }> {
  const user = await prisma.user.create({
    data: { email: `p8v-${tag}-${Math.random().toString(36).slice(2, 8)}@t.test`, name: "P8V User" },
    select: { id: true },
  });
  const created = await createSeller(fakeSellerInput(tag), prisma);
  if (!created.ok) throw new Error(`fixture setup failed: ${JSON.stringify(created)}`);
  // Seller.status defaults to PENDING on creation — approve it here so the
  // fixture can exercise the Phase 6 offer gate meaningfully (that gate
  // requires Seller.status APPROVED as a separate, unrelated blocker). This
  // is test-fixture setup only; Phase 8 itself never touches Seller.status.
  await prisma.seller.update({ where: { id: created.sellerId }, data: { status: "APPROVED" } });
  const sellerUser = await prisma.sellerUser.create({
    data: { sellerId: created.sellerId, userId: user.id, role: "OWNER", status: "ACTIVE" },
  });
  return {
    userId: user.id,
    sellerId: created.sellerId,
    ctx: {
      sellerId: created.sellerId,
      sellerName: created.displayName,
      sellerUserId: sellerUser.id,
      userId: user.id,
      role: "OWNER",
      permissions: new Set(["manage_seller_settings", "manage_offers", "manage_offer_inventory"]),
    },
  };
}

async function main() {
  console.log("\nSeller Verification — protect APPROVED from stray drafts (Phase 8)\n");

  // ── static — the guard exists in the right place, scope discipline ──────
  const repoSrc = read("src/lib/seller-verification/repository.ts");
  ok("A · getOrCreateDraftVerification returns an APPROVED row as-is (no new DRAFT)",
    (() => {
      const m = repoSrc.match(/async function getOrCreateDraftVerification[\s\S]*?\n\}/);
      return !!m && /if \(existing && existing\.status === "APPROVED"\) return existing;/.test(m[0]);
    })());
  ok("A · saveSellerVerificationDraft fails safely when the target isn't DRAFT",
    (() => {
      const m = repoSrc.match(/export async function saveSellerVerificationDraft[\s\S]*?\n(?=export )/);
      return !!m && /if \(target\.status !== "DRAFT"\)/.test(m[0]) && /ok: false, error:/.test(m[0]);
    })());
  ok("scope · the Phase 6 latest-row resolver (resolveSellerVerificationGateStatus) is untouched",
    !/Phase 8/.test(read("src/lib/seller-verification/repository.ts").match(/export async function resolveSellerVerificationGateStatus[\s\S]*?\n\}/)?.[0] ?? ""));
  ok("scope · admin review logic (reviewSellerVerificationForAdmin) is untouched",
    !/Phase 8/.test(repoSrc.match(/export async function reviewSellerVerificationForAdmin[\s\S]*?\n\}/)?.[0] ?? ""));
  ok("scope · Seller.status / SellerUser / SellerInvite are never referenced by the new guard",
    (() => {
      const m = repoSrc.match(/async function getOrCreateDraftVerification[\s\S]*?\n\}/);
      return !!m && !/seller\.status|sellerUser\.|sellerInvite\./i.test(m[0]);
    })());
  ok("scope · scripts/seed-rbac.ts untouched by this phase",
    !/Phase 8/.test(read("scripts/seed-rbac.ts")));

  // ── real, committed fixtures (cleaned up explicitly at the end) ─────────
  const t = Date.now().toString(36);
  const supabase = createAdminClient();
  const uploadedPaths: string[] = [];
  const fixtureSellerIds: string[] = [];
  const fixtureUserIds: string[] = [];

  try {
    const { ctx: ctxA, sellerId: sellerA, userId: userA } = await seedSellerWithOwner(`a-${t}`);
    const { ctx: ctxR, sellerId: sellerR, userId: userR } = await seedSellerWithOwner(`r-${t}`);
    const { ctx: ctxD, sellerId: sellerD, userId: userD } = await seedSellerWithOwner(`d-${t}`);
    const { ctx: ctxP, sellerId: sellerP, userId: userP } = await seedSellerWithOwner(`p-${t}`);
    fixtureSellerIds.push(sellerA, sellerR, sellerD, sellerP);
    fixtureUserIds.push(userA, userR, userD, userP);
    const adminUser = await prisma.user.create({ data: { email: `p8v-admin-${t}@t.test`, name: "P8V Admin" }, select: { id: true } });
    fixtureUserIds.push(adminUser.id);

    // ── A/E — APPROVED seller: direct save-draft call is rejected ─────────
    // Phase 9 — phone + complete address are now required to submit; this
    // fixture needs a genuinely submittable row, not just a legal name.
    const draftA = await saveSellerVerificationDraft(ctxA, {
      ...EMPTY_PATCH, legalName: "Before Approval", phone: "09171234567",
      addressLine1: "1 Test St", city: "Manila", province: "Metro Manila", postalCode: "1000",
      country: "PH", businessType: "INDIVIDUAL",
    });
    if (!draftA.ok) throw new Error("fixture draftA failed");
    const verificationIdA = draftA.verification.id;
    const uploadA = await uploadSellerVerificationDocument(ctxA, {
      buffer: PNG, sizeBytes: PNG.length, declaredType: "image/png", documentType: "GOVERNMENT_ID_PRIMARY",
    });
    ok("fixture · document uploaded before approval", uploadA.ok, JSON.stringify(uploadA));
    if (uploadA.ok) {
      const rawDoc = await prisma.sellerVerificationDocument.findUniqueOrThrow({ where: { id: uploadA.document.id } });
      uploadedPaths.push(rawDoc.storagePath);
    }
    const submitA = await submitSellerVerificationForReview(ctxA);
    ok("fixture · sellerA submits (DRAFT → PENDING) before admin can decide it", submitA.ok, JSON.stringify(submitA));
    const approve = await reviewSellerVerificationForAdmin({
      sellerId: sellerA, verificationId: verificationIdA, status: "APPROVED", reviewNote: null, reviewedBy: adminUser.id,
    });
    ok("fixture · admin approves sellerA's verification", approve.ok, JSON.stringify(approve));

    const restrayDraft = await saveSellerVerificationDraft(ctxA, { ...EMPTY_PATCH, legalName: "Sneaky Reopen Attempt" });
    ok("A/E · direct saveSellerVerificationDraft call on an APPROVED seller is rejected",
      !restrayDraft.ok && restrayDraft.error === "This verification is no longer editable.", JSON.stringify(restrayDraft));
    ok("A · no new SellerVerification row was created for sellerA",
      (await prisma.sellerVerification.count({ where: { sellerId: sellerA } })) === 1);
    const rowAfterAttempt = await prisma.sellerVerification.findUniqueOrThrow({ where: { id: verificationIdA } });
    ok("A · the existing row remains APPROVED, untouched (legalName unchanged)",
      rowAfterAttempt.status === "APPROVED" && rowAfterAttempt.legalName === "Before Approval");

    // ── bonus — the shared helper also protects document upload ───────────
    const uploadAfterApproval = await uploadSellerVerificationDocument(ctxA, {
      buffer: PNG, sizeBytes: PNG.length, declaredType: "image/png", documentType: "PROOF_OF_ADDRESS",
    });
    ok("bonus · uploadSellerVerificationDocument is ALSO protected (same shared helper) — this check was previously dead code",
      !uploadAfterApproval.ok && uploadAfterApproval.error === "This verification is no longer editable.", JSON.stringify(uploadAfterApproval));
    ok("bonus · still exactly one document exists for sellerA (no stray upload/row)",
      (await prisma.sellerVerificationDocument.count({ where: { sellerVerificationId: verificationIdA } })) === 1);

    // ── B — APPROVED seller: offer creation + activation remain allowed ───
    const category = await prisma.category.findFirst({ select: { id: true } });
    if (!category) {
      ok("(skipped B — no category to seed a fixture product against)", true);
    } else {
      const product = await prisma.product.create({
        data: { name: `P8B ${t}`, slug: `p8b-${t}`, shortDescription: "s", description: "d", categoryId: category.id, status: "ACTIVE", price: 1000 },
        select: { id: true },
      });
      const variant = await prisma.variant.create({
        data: { productId: product.id, sku: `v-p8b-${t}`, price: 1000, status: "ACTIVE", stock: 0 },
        select: { id: true },
      });
      const created = await createSellerOffer(ctxA, { variantId: variant.id, price: 1000, openingQuantity: 5, condition: "NEW" });
      ok("B · APPROVED seller can still create an offer", created.ok === true, JSON.stringify(created));
      if (created.ok) {
        const activated = await setSellerOfferStatus(ctxA, created.offerId, "ACTIVE");
        ok("B · APPROVED seller can still activate an offer", activated.ok === true, JSON.stringify(activated));
      }
    }

    // ── C — REJECTED seller: save-draft still creates a new DRAFT ─────────
    const draftR = await saveSellerVerificationDraft(ctxR, {
      ...EMPTY_PATCH, legalName: "First Attempt", phone: "09171234567",
      addressLine1: "1 Test St", city: "Manila", province: "Metro Manila", postalCode: "1000",
      country: "PH", businessType: "INDIVIDUAL",
    });
    if (!draftR.ok) throw new Error("fixture draftR failed");
    const uploadR = await uploadSellerVerificationDocument(ctxR, {
      buffer: PNG, sizeBytes: PNG.length, declaredType: "image/png", documentType: "GOVERNMENT_ID_PRIMARY",
    });
    if (uploadR.ok) {
      const rawDoc = await prisma.sellerVerificationDocument.findUniqueOrThrow({ where: { id: uploadR.document.id } });
      uploadedPaths.push(rawDoc.storagePath);
    }
    const submitR = await submitSellerVerificationForReview(ctxR);
    ok("fixture · sellerR submits (DRAFT → PENDING) before admin can decide it", submitR.ok, JSON.stringify(submitR));
    const reject = await reviewSellerVerificationForAdmin({
      sellerId: sellerR, verificationId: draftR.verification.id, status: "REJECTED", reviewNote: "needs a clearer ID photo", reviewedBy: adminUser.id,
    });
    ok("fixture · admin rejects sellerR's verification", reject.ok, JSON.stringify(reject));
    const resubmitDraft = await saveSellerVerificationDraft(ctxR, { ...EMPTY_PATCH, legalName: "Second Attempt" });
    ok("C · REJECTED seller's save-draft call still succeeds (creates a fresh DRAFT)",
      resubmitDraft.ok === true, JSON.stringify(resubmitDraft));
    if (resubmitDraft.ok) {
      ok("C · the new row is a DISTINCT row from the rejected one", resubmitDraft.verification.id !== draftR.verification.id);
      ok("C · the new row is DRAFT", resubmitDraft.verification.status === "DRAFT");
    }
    ok("C · sellerR now has TWO rows (rejected history preserved, not overwritten)",
      (await prisma.sellerVerification.count({ where: { sellerId: sellerR } })) === 2);

    // ── D — DRAFT seller: existing draft-save behavior unchanged ───────────
    const draftD1 = await saveSellerVerificationDraft(ctxD, { ...EMPTY_PATCH, legalName: "First Save" });
    if (!draftD1.ok) throw new Error("fixture draftD1 failed");
    const draftD2 = await saveSellerVerificationDraft(ctxD, { ...EMPTY_PATCH, legalName: "Second Save" });
    ok("D · saving a DRAFT again still succeeds", draftD2.ok === true, JSON.stringify(draftD2));
    if (draftD2.ok) {
      ok("D · the SAME row is updated in place (no new row)", draftD2.verification.id === draftD1.verification.id);
      ok("D · the update actually applied", draftD2.verification.legalName === "Second Save");
    }
    ok("D · sellerD has exactly ONE row", (await prisma.sellerVerification.count({ where: { sellerId: sellerD } })) === 1);

    // ── PENDING — explicitly confirm UNCHANGED (not broadened) behavior ────
    const draftP = await saveSellerVerificationDraft(ctxP, { ...EMPTY_PATCH, legalName: "Pending Attempt" });
    if (!draftP.ok) throw new Error("fixture draftP failed");
    const uploadP = await uploadSellerVerificationDocument(ctxP, {
      buffer: PNG, sizeBytes: PNG.length, declaredType: "image/png", documentType: "GOVERNMENT_ID_PRIMARY",
    });
    if (uploadP.ok) {
      const rawDoc = await prisma.sellerVerificationDocument.findUniqueOrThrow({ where: { id: uploadP.document.id } });
      uploadedPaths.push(rawDoc.storagePath);
    }
    await prisma.sellerVerification.update({ where: { id: draftP.verification.id }, data: { status: "PENDING", submittedAt: new Date() } });
    const draftPRetry = await saveSellerVerificationDraft(ctxP, { ...EMPTY_PATCH, legalName: "Attempted During Pending" });
    ok("PENDING · save-draft behavior is UNCHANGED by this phase (not newly blocked) — out of scope, preserved as-is",
      draftPRetry.ok === true, JSON.stringify(draftPRetry));
    if (draftPRetry.ok) {
      ok("PENDING · (pre-existing, unchanged behavior) a new row is created rather than mutating the PENDING one",
        draftPRetry.verification.id !== draftP.verification.id);
    }

    // ── F — no other domain change ──────────────────────────────────────────
    ok("· Seller.status untouched by Phase 8 (still APPROVED, as fixture setup left it)",
      (await prisma.seller.count({ where: { id: { in: fixtureSellerIds }, status: "APPROVED" } })) === fixtureSellerIds.length);
    ok("· no SellerInvite rows created for any fixture seller", (await prisma.sellerInvite.count({ where: { sellerId: { in: fixtureSellerIds } } })) === 0);
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
  ok("isolation · no fixture User leaked", (await prisma.user.count({ where: { email: { contains: "p8v-" } } })) === 0);
  ok("isolation · no fixture Seller leaked", (await prisma.seller.count({ where: { displayName: { startsWith: "P8V Store " } } })) === 0);
  ok("isolation · no fixture SellerVerification leaked",
    (await prisma.sellerVerification.count({ where: { seller: { displayName: { startsWith: "P8V Store " } } } })) === 0);
  const { data: leftover } = await supabase.storage.from(SELLER_VERIFICATION_BUCKET).list("sellers");
  ok("isolation · no fixture storage objects leaked under sellers/", (leftover ?? []).length === 0, JSON.stringify(leftover));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
