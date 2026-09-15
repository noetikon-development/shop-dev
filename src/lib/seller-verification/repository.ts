import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSellerVerificationSignedUrl, SELLER_VERIFICATION_BUCKET } from "@/lib/seller-verification/storage";
import { validateSellerVerificationUpload, buildSellerVerificationStoragePath } from "@/lib/seller-verification/upload-validation";
import { isSellerVerificationDocumentType } from "@/lib/seller-verification/document-types";
import type { SellerContext } from "@/lib/marketplace/types";

/**
 * Seller Verification — identity/business draft + document repository
 * (Phases 2–3).
 *
 * Every function takes a `SellerContext` (from `requireSellerSessionPermission`,
 * never a client-supplied sellerId) and re-scopes every query to
 * `ctx.sellerId` inside its own transaction — the same discipline as
 * `seller-profile-repository.ts`'s `updateSellerProfileDraft`. There is no
 * function anywhere in this module that reads or writes a verification row
 * (or a document) by a caller-supplied id without first confirming it
 * belongs to `ctx.sellerId` — a seller can only ever reach its OWN records.
 * The one exception, `getSellerVerificationDocumentSignedUrlForAdmin`, is
 * NOT seller-scoped by design — it is the admin-review authorization
 * boundary, and the caller (a future admin action) is responsible for its
 * own `requirePermission` check before ever reaching this function.
 *
 * A seller can accumulate more than one `SellerVerification` row over time
 * (a rejected one, then a fresh resubmission — see the model's own doc
 * comment), so every read/write here operates on the LATEST row only,
 * ordered by `createdAt`. Nothing creates a row automatically —
 * `getSellerVerification` returns `null` until the seller explicitly saves a
 * draft OR uploads a document for the first time (both count as "explicitly
 * starting verification").
 */

const VERIFICATION_SELECT = {
  id: true,
  sellerId: true,
  status: true,
  submittedAt: true,
  reviewedAt: true,
  reviewNote: true,
  legalName: true,
  phone: true,
  phoneVerifiedAt: true,
  addressLine1: true,
  addressLine2: true,
  barangay: true,
  city: true,
  province: true,
  postalCode: true,
  country: true,
  businessType: true,
  businessName: true,
  businessRegistrationNumber: true,
  dtiRegistrationNumber: true,
  secRegistrationNumber: true,
  tin: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type SellerVerificationView = Prisma.SellerVerificationGetPayload<{ select: typeof VERIFICATION_SELECT }>;

export type SellerVerificationDraftPatch = {
  legalName: string | null;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  barangay: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  country: string | null;
  businessType: string | null;
  businessName: string | null;
  businessRegistrationNumber: string | null;
  dtiRegistrationNumber: string | null;
  secRegistrationNumber: string | null;
  tin: string | null;
};

export type SellerVerificationResult =
  | { ok: true; verification: SellerVerificationView }
  | { ok: false; error: string };

/** The seller's own latest verification row, or null if it has never started one. */
export async function getSellerVerification(
  ctx: SellerContext,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<SellerVerificationView | null> {
  return client.sellerVerification.findFirst({
    where: { sellerId: ctx.sellerId },
    orderBy: { createdAt: "desc" },
    select: VERIFICATION_SELECT,
  });
}

/**
 * Save a draft. Creates a new row (status DRAFT) the FIRST time this seller
 * explicitly saves — never automatically, never on merely viewing the page.
 * On every later save, updates that same row in place as long as it is still
 * DRAFT. If the seller's latest row has already moved past DRAFT (a later
 * phase's PENDING/APPROVED/REJECTED — unreachable in this phase, but handled
 * correctly for when it is), a fresh DRAFT row is created instead of
 * mutating a submitted/reviewed one out from under a reviewer.
 */
async function findLatestVerification(tx: Prisma.TransactionClient, sellerId: string) {
  return tx.sellerVerification.findFirst({
    where: { sellerId },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true },
  });
}

/**
 * Return the seller's latest DRAFT verification, creating an empty one
 * (every identity/business field null) if none exists yet or the latest one
 * has already moved past DRAFT. Shared by the draft-save path (Phase 2) and
 * the document-upload path (Phase 3) — both count as "the seller explicitly
 * started verification", so both use the exact same creation rule.
 */
async function getOrCreateDraftVerification(
  tx: Prisma.TransactionClient,
  ctx: SellerContext,
): Promise<{ id: string; status: string }> {
  const existing = await findLatestVerification(tx, ctx.sellerId);
  if (existing && existing.status === "DRAFT") return existing;
  const created = await tx.sellerVerification.create({
    data: { sellerId: ctx.sellerId, status: "DRAFT" },
    select: { id: true, status: true },
  });
  return created;
}

export async function saveSellerVerificationDraft(
  ctx: SellerContext,
  patch: SellerVerificationDraftPatch,
  externalTx?: Prisma.TransactionClient,
): Promise<SellerVerificationResult> {
  const run = async (tx: Prisma.TransactionClient): Promise<SellerVerificationResult> => {
    const target = await getOrCreateDraftVerification(tx, ctx);
    const verification = await tx.sellerVerification.update({
      where: { id: target.id },
      data: patch,
      select: VERIFICATION_SELECT,
    });
    return { ok: true, verification };
  };

  try {
    return externalTx ? await run(externalTx) : await prisma.$transaction(run);
  } catch (err) {
    console.error("[seller-verification-repository] saveSellerVerificationDraft failed", err);
    return { ok: false, error: "Could not save your verification details." };
  }
}

// ---------------------------------------------------------------------------
// Documents (Phase 3)
// ---------------------------------------------------------------------------

/** UI-safe projection — deliberately excludes bucket/storagePath. */
const DOCUMENT_LIST_SELECT = {
  id: true,
  documentType: true,
  mimeType: true,
  sizeBytes: true,
  status: true,
  uploadedAt: true,
} as const;

export type SellerVerificationDocumentListItem = Prisma.SellerVerificationDocumentGetPayload<{
  select: typeof DOCUMENT_LIST_SELECT;
}>;

/** Every document on the seller's own latest verification. Never exposes bucket/storagePath. */
export async function listSellerVerificationDocuments(
  ctx: SellerContext,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<SellerVerificationDocumentListItem[]> {
  const verification = await client.sellerVerification.findFirst({
    where: { sellerId: ctx.sellerId },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!verification) return [];
  return client.sellerVerificationDocument.findMany({
    where: { sellerVerificationId: verification.id },
    orderBy: { documentType: "asc" },
    select: DOCUMENT_LIST_SELECT,
  });
}

export type UploadSellerVerificationDocumentResult =
  | { ok: true; document: SellerVerificationDocumentListItem }
  | { ok: false; error: string };

/**
 * Upload one verification document, validated server-side (size + real
 * content, never the declared type alone — see upload-validation.ts) and
 * stored ONLY in the private "seller-verification" bucket, never "media".
 *
 * Replacement behavior (one documentType per verification, enforced here in
 * application code — there is no DB uniqueness on (sellerVerificationId,
 * documentType) in this phase): uploading a type that already has a document
 * REPLACES it, rather than creating a second, ambiguous row. Ordering is
 * deliberate:
 *   1. upload the NEW file to a brand-new, random storage path;
 *   2. only once that succeeds, write/​update the DB row to point at the NEW
 *      path (status reset to PENDING, any prior review cleared — a fresh
 *      file is an unreviewed file);
 *   3. only once the DB write commits, best-effort remove the OLD storage
 *      object (a leftover orphan there is harmless — nothing references it
 *      once step 2 has moved the DB row's reference off of it; deleting it
 *      any earlier would risk the DB still pointing at a just-deleted
 *      object if step 2 then failed).
 * A DB-write failure after step 1 cleans up the just-uploaded NEW object
 * instead, since nothing would ever reference it.
 *
 * Never replaces a document that has already been reviewed (status
 * APPROVED/REJECTED) or belongs to a verification that is no longer DRAFT —
 * unreachable in this phase (nothing yet moves either status away from
 * PENDING/DRAFT), but enforced now so it is already correct once a review
 * phase exists.
 */
export async function uploadSellerVerificationDocument(
  ctx: SellerContext,
  input: { buffer: Buffer; sizeBytes: number; declaredType: string; documentType: string },
): Promise<UploadSellerVerificationDocumentResult> {
  if (!isSellerVerificationDocumentType(input.documentType)) {
    return { ok: false, error: "Invalid document type." };
  }
  const validated = validateSellerVerificationUpload(input.buffer, input.sizeBytes, input.declaredType);
  if (!validated.ok) return { ok: false, error: validated.error };

  const target = await prisma.$transaction((tx) => getOrCreateDraftVerification(tx, ctx));
  if (target.status !== "DRAFT") {
    return { ok: false, error: "This verification is no longer editable." };
  }

  const path = buildSellerVerificationStoragePath(ctx.sellerId, target.id, validated.extension);
  const supabase = createAdminClient();
  const { error: uploadError } = await supabase.storage
    .from(SELLER_VERIFICATION_BUCKET)
    .upload(path, input.buffer, { contentType: validated.mimeType, upsert: false });
  if (uploadError) return { ok: false, error: `Upload failed: ${uploadError.message}` };

  try {
    const existing = await prisma.sellerVerificationDocument.findFirst({
      where: { sellerVerificationId: target.id, documentType: input.documentType },
      select: { id: true, bucket: true, storagePath: true, status: true },
    });
    if (existing && existing.status !== "PENDING") {
      await supabase.storage.from(SELLER_VERIFICATION_BUCKET).remove([path]).catch(() => {});
      return { ok: false, error: "This document has already been reviewed and can't be replaced." };
    }

    const document = existing
      ? await prisma.sellerVerificationDocument.update({
          where: { id: existing.id },
          data: {
            bucket: SELLER_VERIFICATION_BUCKET,
            storagePath: path,
            mimeType: validated.mimeType,
            sizeBytes: input.sizeBytes,
            status: "PENDING",
            uploadedAt: new Date(),
            reviewedAt: null,
            reviewedBy: null,
            reviewNote: null,
          },
          select: DOCUMENT_LIST_SELECT,
        })
      : await prisma.sellerVerificationDocument.create({
          data: {
            sellerVerificationId: target.id,
            documentType: input.documentType,
            bucket: SELLER_VERIFICATION_BUCKET,
            storagePath: path,
            mimeType: validated.mimeType,
            sizeBytes: input.sizeBytes,
            status: "PENDING",
          },
          select: DOCUMENT_LIST_SELECT,
        });

    if (existing && existing.storagePath !== path) {
      await supabase.storage.from(existing.bucket).remove([existing.storagePath]).catch(() => {});
    }

    return { ok: true, document };
  } catch (err) {
    await supabase.storage.from(SELLER_VERIFICATION_BUCKET).remove([path]).catch(() => {});
    console.error("[seller-verification-repository] uploadSellerVerificationDocument DB write failed", err);
    return { ok: false, error: "Could not save your document." };
  }
}

/**
 * Delete one of the seller's OWN documents. Ownership is re-checked here via
 * a join through `sellerVerification.sellerId` — never trusts that a
 * documentId the caller supplies actually belongs to `ctx.sellerId`; a
 * mismatch (or a non-existent id) returns the same generic "not found" as a
 * caller-supplied id from someone else's records, so a probe can't tell the
 * two apart. Only a PENDING document on a still-DRAFT verification may be
 * deleted — never an already-reviewed one, never one on an APPROVED case.
 *
 * Ordering: the DB row is deleted FIRST (it is the source of truth for what
 * exists), then the storage object is removed best-effort. If the storage
 * removal fails, the result is a harmless orphaned object in the private
 * bucket that nothing references anymore — never a dangling DB row pointing
 * at an object that's already gone (the reverse ordering would risk exactly
 * that if the DB delete failed after storage succeeded).
 */
export async function deleteSellerVerificationDocument(
  ctx: SellerContext,
  documentId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const doc = await prisma.sellerVerificationDocument.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      status: true,
      bucket: true,
      storagePath: true,
      sellerVerification: { select: { sellerId: true, status: true } },
    },
  });
  if (!doc || doc.sellerVerification.sellerId !== ctx.sellerId) {
    return { ok: false, error: "Document not found." };
  }
  if (doc.status !== "PENDING") {
    return { ok: false, error: "This document has already been reviewed and can't be deleted." };
  }
  if (doc.sellerVerification.status !== "DRAFT") {
    return { ok: false, error: "This verification is no longer editable." };
  }

  try {
    await prisma.sellerVerificationDocument.delete({ where: { id: doc.id } });
  } catch (err) {
    console.error("[seller-verification-repository] deleteSellerVerificationDocument DB delete failed", err);
    return { ok: false, error: "Could not delete this document." };
  }

  const supabase = createAdminClient();
  await supabase.storage.from(doc.bucket).remove([doc.storagePath]).catch(() => {});

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Signed URL access (Phase 3)
// ---------------------------------------------------------------------------

export type SignedUrlResult = { ok: true; url: string } | { ok: false; error: string };

/**
 * A short-lived signed URL for one of the CALLING SELLER'S OWN documents.
 * Takes only a `documentId` — never a raw bucket or storagePath from the
 * caller — and re-derives + re-checks ownership from the database before
 * ever calling the storage layer, exactly like `deleteSellerVerificationDocument`.
 */
export async function getOwnSellerVerificationDocumentSignedUrl(
  ctx: SellerContext,
  documentId: string,
): Promise<SignedUrlResult> {
  const doc = await prisma.sellerVerificationDocument.findUnique({
    where: { id: documentId },
    select: { storagePath: true, sellerVerification: { select: { sellerId: true } } },
  });
  if (!doc || doc.sellerVerification.sellerId !== ctx.sellerId) {
    return { ok: false, error: "Document not found." };
  }
  const url = await getSellerVerificationSignedUrl(doc.storagePath);
  if (!url) return { ok: false, error: "Could not generate a link for this document." };
  return { ok: true, url };
}

/**
 * The ADMIN-REVIEW authorization boundary (Phase 3 foundation only — no
 * admin UI calls this yet). This function itself does NOT check an admin
 * permission — it only confirms the requested id is a REAL
 * SellerVerificationDocument before ever calling the storage layer. The
 * caller (a future admin server action) MUST call `requirePermission(...)`
 * — the same existing RBAC convention `admin/sellers/actions.ts` already
 * uses for seller-lifecycle decisions — before ever reaching this function.
 * Deliberately not seller-scoped: an authorized admin can review any
 * seller's documents, same as `/admin/sellers/[id]` today.
 */
export async function getSellerVerificationDocumentSignedUrlForAdmin(documentId: string): Promise<SignedUrlResult> {
  const doc = await prisma.sellerVerificationDocument.findUnique({
    where: { id: documentId },
    select: { storagePath: true },
  });
  if (!doc) return { ok: false, error: "Document not found." };
  const url = await getSellerVerificationSignedUrl(doc.storagePath);
  if (!url) return { ok: false, error: "Could not generate a link for this document." };
  return { ok: true, url };
}
