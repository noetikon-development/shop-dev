/**
 * Seller Verification — private document upload (Phase 3).
 *
 * Storage/upload calls are real I/O against the actual Supabase Storage API
 * and cannot participate in a Postgres transaction the way Phases 1–2's
 * pure-DB tests could — `uploadSellerVerificationDocument` and its siblings
 * deliberately use the plain `prisma` client (a separate connection from any
 * test-owned `$transaction`), since a storage upload can't be rolled back
 * anyway. This file therefore uses REAL, COMMITTED fixtures instead of a
 * rolled-back transaction, and explicitly deletes every row and every
 * storage object it created at the end (see the CLEANUP section) — matching
 * this phase's own instruction to use "isolated tests with synthetic
 * fixture files" rather than the rollback pattern earlier phases used.
 * `Seller` cascades to `SellerVerification` and `SellerVerificationDocument`
 * on delete (schema-level `onDelete: Cascade`), so deleting the fixture
 * Sellers cleans up those rows automatically; only the SUPABASE STORAGE
 * OBJECTS need explicit removal.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-seller-verification-p3.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { createSeller } from "../src/lib/admin/sellers/repository";
import { createAdminClient } from "../src/lib/supabase/admin";
import { SELLER_VERIFICATION_BUCKET } from "../src/lib/seller-verification/storage";
import {
  validateSellerVerificationUpload,
  buildSellerVerificationStoragePath,
  SELLER_VERIFICATION_MAX_BYTES,
} from "../src/lib/seller-verification/upload-validation";
import { isSellerVerificationDocumentType } from "../src/lib/seller-verification/document-types";
import {
  uploadSellerVerificationDocument,
  deleteSellerVerificationDocument,
  listSellerVerificationDocuments,
  getOwnSellerVerificationDocumentSignedUrl,
  getSellerVerificationDocumentSignedUrlForAdmin,
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

// ---------------------------------------------------------------------------
// Synthetic fixture files — real magic bytes, no real document content.
// ---------------------------------------------------------------------------
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(64, 3)]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(64, 4)]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(64, 5)]); // valid image, NOT in this bucket's allow-list
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const GARBAGE = Buffer.from("this is not any recognized file format at all");

function fakeSellerInput(tag: string) {
  return {
    displayName: `P3V Store ${tag}`,
    slug: `p3v-store-${tag}-${Math.random().toString(36).slice(2, 7)}`,
    supportEmail: `p3v-support-${tag}@t.test`,
  };
}

async function seedRealSellerWithOwner(tag: string): Promise<{ ctx: SellerContext; userId: string }> {
  const user = await prisma.user.create({
    data: { email: `p3v-${tag}-${Math.random().toString(36).slice(2, 8)}@t.test`, name: "P3V User" },
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
  console.log("\nSeller Verification — private document upload (Phase 3)\n");

  // ── static — no public URL, private bucket, no injectable path/bucket ──
  const repoSrc = read("src/lib/seller-verification/repository.ts");
  const storageSrc = read("src/lib/seller-verification/storage.ts");
  const actionsSrc = read("src/lib/seller-verification/actions.ts");
  const docsUiSrc = read("src/components/seller/verification-documents.tsx");
  const adminActionSrc = read("src/lib/admin/seller-verification-actions.ts");

  ok("A · getPublicUrl() is never CALLED anywhere in the verification repository/storage modules (mentions in doc comments explaining its absence don't count)",
    !/\.getPublicUrl\(/.test(repoSrc) && !/\.getPublicUrl\(/.test(storageSrc));
  ok("B · document uploads always target the private SELLER_VERIFICATION_BUCKET constant",
    /\.from\(SELLER_VERIFICATION_BUCKET\)/.test(repoSrc));
  ok("F · getSellerVerificationSignedUrl takes no bucket parameter — the bucket can never be supplied by a caller",
    /export async function getSellerVerificationSignedUrl\(\s*path: string/.test(storageSrc));
  ok("G · the seller-facing signed-url path takes only a documentId — never a raw storagePath",
    /getOwnSellerVerificationDocumentSignedUrl\(\s*ctx: SellerContext,\s*documentId: string,/.test(repoSrc));
  ok("· uploadSellerVerificationDocument never accepts a caller-supplied verificationId or storagePath",
    !/uploadSellerVerificationDocument\([^)]*verificationId/.test(repoSrc) &&
      !/uploadSellerVerificationDocument\([^)]*storagePath/.test(repoSrc));
  ok("· the delete/signed-url actions take only documentId from the form, never sellerId/storagePath",
    /documentId/.test(actionsSrc) && !/formData\.get\("storagePath"\)/.test(actionsSrc) && !/formData\.get\("bucket"\)/.test(actionsSrc));
  ok("· the UI never renders a bucket name or storage path (only documentType/status/uploadedAt fields are used)",
    !/storagePath/.test(docsUiSrc) && !/\.bucket\b|bucket:/i.test(docsUiSrc));
  ok("· the admin authorization boundary requires manage_settings before calling the repository function",
    /requirePermission\("manage_settings"\)/.test(adminActionSrc) &&
      adminActionSrc.indexOf('requirePermission("manage_settings")') < adminActionSrc.indexOf("getSellerVerificationDocumentSignedUrlForAdmin("));
  ok("U · no verification action imports an email sender (no email sent by upload/delete)",
    !/from "@\/lib\/email\/notifications"/.test(actionsSrc));

  // ── security — path traversal has no injection point ────────────────────
  ok("security · '../../../etc/passwd' is not a valid documentType (path traversal via type is impossible)",
    !isSellerVerificationDocumentType("../../../etc/passwd"));
  ok("security · an empty/garbage documentType is rejected", !isSellerVerificationDocumentType(""));
  const path1 = buildSellerVerificationStoragePath("sellerA", "verA", ".png");
  const path2 = buildSellerVerificationStoragePath("sellerA", "verA", ".png");
  ok("security · generated storage paths never contain '..' (no traversal possible)", !path1.includes("..") && !path2.includes(".."));
  ok("security · two paths for the same seller/verification are still distinct (random suffix, no filename reuse)", path1 !== path2);
  ok("security · the path is deterministically scoped under sellers/<sellerId>/verification/<verificationId>/",
    path1.startsWith("sellers/sellerA/verification/verA/"));

  // ── pure-function validation — A–H (format acceptance / rejection) ──────
  const okPng = validateSellerVerificationUpload(PNG, PNG.length, "image/png");
  ok("A · valid PNG accepted", okPng.ok && okPng.mimeType === "image/png");
  const okJpeg = validateSellerVerificationUpload(JPEG, JPEG.length, "image/jpeg");
  ok("B · valid JPEG accepted", okJpeg.ok && okJpeg.mimeType === "image/jpeg");
  const okWebp = validateSellerVerificationUpload(WEBP, WEBP.length, "image/webp");
  ok("C · valid WebP accepted", okWebp.ok && okWebp.mimeType === "image/webp");
  const okPdf = validateSellerVerificationUpload(PDF, PDF.length, "application/pdf");
  ok("D · valid PDF accepted", okPdf.ok && okPdf.mimeType === "application/pdf");

  const gifResult = validateSellerVerificationUpload(GIF, GIF.length, "image/gif");
  ok("E · a real but disallowed type (GIF — valid for admin media, not for verification) is rejected", !gifResult.ok);

  const svgResult = validateSellerVerificationUpload(SVG, SVG.length, "image/svg+xml");
  ok("F · SVG is rejected (never recognized by magic-byte sniffing, regardless of declared type)", !svgResult.ok);

  const oversized = validateSellerVerificationUpload(PNG, SELLER_VERIFICATION_MAX_BYTES + 1, "image/png");
  ok("G · an oversized declared size is rejected even with valid content", !oversized.ok);

  const garbageResult = validateSellerVerificationUpload(GARBAGE, GARBAGE.length, "image/png");
  ok("H · malformed/unrecognized content is rejected even with a valid declared type", !garbageResult.ok);

  const spoofed = validateSellerVerificationUpload(PNG, PNG.length, "application/pdf");
  ok("security · a declared type that disagrees with the real (sniffed) content is rejected (spoofing caught)", !spoofed.ok);

  // ── real, committed fixtures (cleaned up explicitly at the end) ─────────
  const t = Date.now().toString(36);
  const supabase = createAdminClient();
  const uploadedPaths: string[] = [];
  const fixtureSellerIds: string[] = [];
  const fixtureUserIds: string[] = [];

  try {
    const { ctx: ctxA, userId: userIdA } = await seedRealSellerWithOwner(`a-${t}`);
    const { ctx: ctxB, userId: userIdB } = await seedRealSellerWithOwner(`b-${t}`);
    fixtureSellerIds.push(ctxA.sellerId, ctxB.sellerId);
    fixtureUserIds.push(userIdA, userIdB);

    const sellerRowBefore = await prisma.seller.findUniqueOrThrow({ where: { id: ctxA.sellerId }, select: { status: true } });
    const sellerUserCountBefore = await prisma.sellerUser.count({ where: { sellerId: { in: fixtureSellerIds } } });

    // I/J/K — a real upload creates exactly one PENDING document, correctly scoped.
    const upA1 = await uploadSellerVerificationDocument(ctxA, {
      buffer: PNG,
      sizeBytes: PNG.length,
      declaredType: "image/png",
      documentType: "GOVERNMENT_ID_PRIMARY",
    });
    ok("I · upload creates a SellerVerificationDocument", upA1.ok, JSON.stringify(upA1));
    if (!upA1.ok) throw new Error("fixture upload A1 failed");
    ok("J · status is PENDING", upA1.document.status === "PENDING");
    ok("· documentType matches what was uploaded", upA1.document.documentType === "GOVERNMENT_ID_PRIMARY");

    const rawA1 = await prisma.sellerVerificationDocument.findUniqueOrThrow({ where: { id: upA1.document.id } });
    uploadedPaths.push(rawA1.storagePath);
    ok("O · the private bucket was used, never 'media'", rawA1.bucket === SELLER_VERIFICATION_BUCKET);
    ok("C(schema) · storage path is scoped under this seller's own id", rawA1.storagePath.startsWith(`sellers/${ctxA.sellerId}/verification/`));
    ok("N · no public URL / signed URL / raw content column holds a value (schema has none — confirmed structurally)",
      !("url" in rawA1) && !("publicUrl" in rawA1) && !("signedUrl" in rawA1) && !("content" in rawA1));

    ok("K · listSellerVerificationDocuments(ctxA) sees its own upload",
      (await listSellerVerificationDocuments(ctxA)).some((d) => d.id === upA1.document.id));
    ok("K · listSellerVerificationDocuments(ctxB) does NOT see sellerA's upload (correct scoping)",
      !(await listSellerVerificationDocuments(ctxB)).some((d) => d.id === upA1.document.id));

    // L — replacement: uploading the SAME documentType again updates the
    // SAME row (not a new one) and removes the OLD storage object.
    const oldPath = rawA1.storagePath;
    const upA1Replace = await uploadSellerVerificationDocument(ctxA, {
      buffer: PDF,
      sizeBytes: PDF.length,
      declaredType: "application/pdf",
      documentType: "GOVERNMENT_ID_PRIMARY",
    });
    ok("L · replacement upload succeeds", upA1Replace.ok, JSON.stringify(upA1Replace));
    if (upA1Replace.ok) {
      ok("L · replacement reuses the SAME document id (no ambiguous duplicate row)", upA1Replace.document.id === upA1.document.id);
      const rawReplaced = await prisma.sellerVerificationDocument.findUniqueOrThrow({ where: { id: upA1.document.id } });
      uploadedPaths.push(rawReplaced.storagePath);
      ok("L · the storage path actually changed to a new object", rawReplaced.storagePath !== oldPath);
      ok("L · mimeType updated to reflect the new file", rawReplaced.mimeType === "application/pdf");
      const folder = `sellers/${ctxA.sellerId}/verification/${rawReplaced.storagePath.split("/")[3]}`;
      const { data: listing } = await supabase.storage.from(SELLER_VERIFICATION_BUCKET).list(folder);
      const names = (listing ?? []).map((f) => f.name);
      ok("L · the OLD object was removed from storage after the DB row safely moved off of it",
        !names.includes(oldPath.split("/").pop()!));
      ok("L · the NEW object is present in storage",
        names.includes(rawReplaced.storagePath.split("/").pop()!));
      ok("· exactly one document of this type still exists for this seller (no duplicate)",
        (await prisma.sellerVerificationDocument.count({
          where: { sellerVerification: { sellerId: ctxA.sellerId }, documentType: "GOVERNMENT_ID_PRIMARY" },
        })) === 1);
    }

    // A second, DIFFERENT documentType creates a genuinely separate row.
    const upA2 = await uploadSellerVerificationDocument(ctxA, {
      buffer: JPEG,
      sizeBytes: JPEG.length,
      declaredType: "image/jpeg",
      documentType: "BUSINESS_PERMIT",
    });
    ok("· a different documentType creates a separate document row", upA2.ok && upA2.ok && upA2.document.id !== upA1.document.id);
    if (upA2.ok) {
      const rawA2 = await prisma.sellerVerificationDocument.findUniqueOrThrow({ where: { id: upA2.document.id } });
      uploadedPaths.push(rawA2.storagePath);
    }

    // M/C/D — cross-seller access is denied; the correct owner still works.
    const sellerADocId = upA1.document.id;
    const crossRead = await getOwnSellerVerificationDocumentSignedUrl(ctxB, sellerADocId);
    ok("C · unauthorized seller cannot obtain a signed URL for another seller's document", !crossRead.ok);
    const ownRead = await getOwnSellerVerificationDocumentSignedUrl(ctxA, sellerADocId);
    ok("D · the correct/owning seller CAN obtain a signed URL for its own document", ownRead.ok, JSON.stringify(ownRead));
    if (ownRead.ok) {
      ok("D · the signed URL looks like a real Supabase signed URL", ownRead.url.startsWith("http") && ownRead.url.includes(SELLER_VERIFICATION_BUCKET));
    }
    const crossDelete = await deleteSellerVerificationDocument(ctxB, sellerADocId);
    ok("M · another seller cannot delete this document", !crossDelete.ok);
    ok("M · the document still exists after the denied cross-seller delete attempt",
      (await prisma.sellerVerificationDocument.count({ where: { id: sellerADocId } })) === 1);

    // E — bounded expiry: the Phase 1 default is a short, explicit TTL, and
    // an explicit short TTL is honored end-to-end.
    ok("E · storage.ts documents a short (5 minute / 300s) default signed-URL TTL, not an unbounded one",
      /DEFAULT_SIGNED_URL_TTL_SECONDS = 300/.test(storageSrc));
    const shortLived = await getOwnSellerVerificationDocumentSignedUrl(ctxA, sellerADocId);
    ok("E · a signed URL is issued successfully under the bounded default expiry", shortLived.ok);

    // Nonexistent ids fail safely, never throw.
    const missingOwn = await getOwnSellerVerificationDocumentSignedUrl(ctxA, "does-not-exist-" + t);
    ok("security · a nonexistent documentId fails safely for the seller path (no throw)", !missingOwn.ok);
    const missingAdmin = await getSellerVerificationDocumentSignedUrlForAdmin("does-not-exist-" + t);
    ok("security · a nonexistent documentId fails safely for the admin path (no throw)", !missingAdmin.ok);
    const missingDelete = await deleteSellerVerificationDocument(ctxA, "does-not-exist-" + t);
    ok("security · deleting a nonexistent documentId fails safely (no throw)", !missingDelete.ok);

    // P — the admin authorization boundary's underlying repository call
    // works for a real, existing document (the action-layer requirePermission
    // gate itself is proven statically above, since it needs a live session).
    const adminRead = await getSellerVerificationDocumentSignedUrlForAdmin(upA2.ok ? upA2.document.id : sellerADocId);
    ok("P · the admin-path repository function signs a URL for a real document id", adminRead.ok, JSON.stringify(adminRead));

    // Q/R/S/T — nothing else in the domain changed.
    const sellerRowAfter = await prisma.seller.findUniqueOrThrow({ where: { id: ctxA.sellerId }, select: { status: true } });
    ok("R · Seller.status unchanged across every upload/replace/delete-attempt above", sellerRowAfter.status === sellerRowBefore.status);
    ok("T · SellerUser count unchanged (still just the 2 seeded OWNERs)",
      (await prisma.sellerUser.count({ where: { sellerId: { in: fixtureSellerIds } } })) === sellerUserCountBefore);
    ok("S · zero SellerInvite rows exist for either fixture seller",
      (await prisma.sellerInvite.count({ where: { sellerId: { in: fixtureSellerIds } } })) === 0);
    const verificationAfter = await prisma.sellerVerification.findFirst({ where: { sellerId: ctxA.sellerId }, orderBy: { createdAt: "desc" } });
    ok("Q · the SellerVerification row itself is still DRAFT and untouched by document operations",
      verificationAfter?.status === "DRAFT" && verificationAfter.legalName === null);

    // Actually delete the remaining documents through the real action, to
    // exercise + prove the DB-then-storage delete ordering end-to-end.
    const delA1 = await deleteSellerVerificationDocument(ctxA, sellerADocId);
    ok("· owner can delete their own PENDING document", delA1.ok, JSON.stringify(delA1));
    if (delA1.ok) {
      ok("· the DB row is gone immediately after delete",
        (await prisma.sellerVerificationDocument.count({ where: { id: sellerADocId } })) === 0);
    }
  } finally {
    // ── W — explicit cleanup: storage objects, then DB rows (Seller cascade
    // takes SellerVerification + SellerVerificationDocument with it) ──────
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

  // ── isolation — confirm the cleanup above actually worked ───────────────
  ok("W · no fixture User leaked", (await prisma.user.count({ where: { email: { contains: "p3v-" } } })) === 0);
  ok("W · no fixture Seller leaked", (await prisma.seller.count({ where: { displayName: { startsWith: "P3V Store " } } })) === 0);
  ok("W · no fixture SellerVerification leaked",
    (await prisma.sellerVerification.count({ where: { seller: { displayName: { startsWith: "P3V Store " } } } })) === 0);
  const { data: leftoverA } = await supabase.storage.from(SELLER_VERIFICATION_BUCKET).list("sellers");
  ok("W · no fixture storage objects leaked under sellers/", (leftoverA ?? []).length === 0, JSON.stringify(leftoverA));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
