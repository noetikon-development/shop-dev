import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSellerVerificationSignedUrl, SELLER_VERIFICATION_BUCKET } from "@/lib/seller-verification/storage";
import { validateSellerVerificationUpload, buildSellerVerificationStoragePath } from "@/lib/seller-verification/upload-validation";
import { isSellerVerificationDocumentType } from "@/lib/seller-verification/document-types";
import {
  sellerVerificationDraftSchema,
  validateSellerVerificationSubmission,
  SELLER_VERIFICATION_SUBMISSION_FAILURE_MESSAGE,
  type SellerVerificationSubmissionFailureCode,
} from "@/lib/seller-verification/validation";
import type { SellerContext, SellerVerificationGateStatus } from "@/lib/marketplace/types";

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

// ---------------------------------------------------------------------------
// Verification gate status (Phase 6)
// ---------------------------------------------------------------------------

/**
 * Resolve the verification-gate status for one seller. FIRST_PARTY sellers
 * are always `"EXEMPT"` — Axiaro's own store has no third-party KYC concept
 * to satisfy, and this resolves without requiring any `SellerVerification`
 * row to exist. THIRD_PARTY sellers resolve to their LATEST row's status
 * (`orderBy: createdAt desc` — the SAME query every other verification read
 * in this file uses), or `"NONE"` when no row exists yet. Never "any row
 * ever APPROVED": a seller who was APPROVED and later resubmitted is judged
 * on their newest row only.
 *
 * Callers needing a fresh, race-safe read inside their own write transaction
 * (e.g. `setSellerOfferStatus`'s publish-readiness check) pass that
 * transaction's client; callers just resolving a session context omit it.
 */
export async function resolveSellerVerificationGateStatus(
  seller: { id: string; type: string },
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<SellerVerificationGateStatus> {
  if (seller.type === "FIRST_PARTY") return "EXEMPT";
  const latest = await client.sellerVerification.findFirst({
    where: { sellerId: seller.id },
    orderBy: { createdAt: "desc" },
    select: { status: true },
  });
  return (latest?.status as SellerVerificationGateStatus | undefined) ?? "NONE";
}

/**
 * Save a draft. Creates a new row (status DRAFT) the FIRST time this seller
 * explicitly saves — never automatically, never on merely viewing the page.
 * On every later save, updates that same row in place as long as it is still
 * DRAFT. If the seller's latest row is PENDING or REJECTED, a fresh DRAFT
 * row is created instead of mutating a submitted/reviewed one out from
 * under a reviewer. If the latest row is APPROVED, no new row is created at
 * all — see `getOrCreateDraftVerification` (Phase 8) — the call fails safely
 * instead of silently reopening an approved decision.
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
 *
 * Phase 8 — an APPROVED verification is the one status this never reopens:
 * the existing row is returned AS-IS (status "APPROVED") instead of creating
 * a new DRAFT. Every caller already checks (or now checks, see
 * `saveSellerVerificationDraft` below) `status !== "DRAFT"` and fails safely
 * rather than silently starting a new cycle that would immediately re-block
 * an already-approved THIRD_PARTY seller's Phase 6 marketplace gate (the
 * latest row drives that gate). This exists specifically because both
 * callers are real server actions, reachable directly regardless of the
 * read-only UI a non-DRAFT status otherwise renders.
 *
 * PENDING and REJECTED are UNCHANGED from prior behavior — still fall
 * through to creating a fresh DRAFT row exactly as before. REJECTED needs
 * this (it's the seller's only resubmission path); PENDING's identical
 * behavior predates this phase and is preserved as-is, out of scope here.
 */
async function getOrCreateDraftVerification(
  tx: Prisma.TransactionClient,
  ctx: SellerContext,
): Promise<{ id: string; status: string }> {
  const existing = await findLatestVerification(tx, ctx.sellerId);
  if (existing && existing.status === "DRAFT") return existing;
  if (existing && existing.status === "APPROVED") return existing;
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
    // Phase 8 — mirrors the same guard uploadSellerVerificationDocument
    // already has. Only reachable for APPROVED today (see
    // getOrCreateDraftVerification above); a direct call to this action
    // while APPROVED fails safely instead of reopening a decided row.
    if (target.status !== "DRAFT") {
      return { ok: false, error: "This verification is no longer editable." };
    }
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
// Submit for review (Phase 5)
// ---------------------------------------------------------------------------

export type SubmitSellerVerificationStatus = "SUCCESS" | "NOT_FOUND" | "ALREADY_SUBMITTED" | "INVALID";
export type SubmitSellerVerificationResult =
  | { ok: true; status: "SUCCESS"; verification: SellerVerificationView }
  | {
      ok: false;
      status: Exclude<SubmitSellerVerificationStatus, "SUCCESS">;
      error: string;
      /**
       * Phase 9 — set only for the specific "missing evidence" failure mode
       * (deterministic, machine-readable). Absent for NOT_FOUND,
       * ALREADY_SUBMITTED, and the pre-existing shape/already-reviewed
       * INVALID cases, which keep their original plain-`error` shape.
       */
      codes?: SellerVerificationSubmissionFailureCode[];
    };

/**
 * The customer-side DRAFT → PENDING transition (Phase 5). ONE transaction,
 * matching the spec exactly: re-check ownership (`ctx.sellerId`, never a
 * caller-supplied id), confirm status is DRAFT, validate the stored
 * identity/business fields against the SAME Phase 2 schema they were saved
 * under, confirm every attached document is still PENDING (an
 * already-decided one staying attached would be stale data, not a fresh
 * submission), then a status-guarded `updateMany` (DRAFT → PENDING) so a
 * concurrent double-submit can only ever succeed once. Sets ONLY `status`
 * and `submittedAt` — never `reviewedAt`/`reviewedBy`/`reviewNote` (those
 * stay Admin-review-only, Phase 4) — and never touches any document's own
 * status (document decisions remain exclusively Admin's, per Phase 4).
 *
 * Phase 9 — "at least one document, of any type" (the original Phase 5 rule)
 * is replaced by `validateSellerVerificationSubmission` (validation.ts): the
 * actual business-policy minimum-evidence requirement, which differs by
 * business type. See that function's own doc comment for exactly what is
 * and isn't enforced.
 */
export async function submitSellerVerificationForReview(
  ctx: SellerContext,
  externalTx?: Prisma.TransactionClient,
): Promise<SubmitSellerVerificationResult> {
  const run = async (tx: Prisma.TransactionClient): Promise<SubmitSellerVerificationResult> => {
    const verification = await tx.sellerVerification.findFirst({
      where: { sellerId: ctx.sellerId },
      orderBy: { createdAt: "desc" },
    });
    if (!verification) {
      return { ok: false, status: "NOT_FOUND", error: "Start your verification before submitting it." };
    }
    if (verification.status !== "DRAFT") {
      return {
        ok: false,
        status: "ALREADY_SUBMITTED",
        error: `This verification is already ${verification.status.toLowerCase()}.`,
      };
    }

    const parsed = sellerVerificationDraftSchema.safeParse({
      legalName: verification.legalName ?? undefined,
      phone: verification.phone ?? undefined,
      addressLine1: verification.addressLine1 ?? undefined,
      addressLine2: verification.addressLine2 ?? undefined,
      barangay: verification.barangay ?? undefined,
      city: verification.city ?? undefined,
      province: verification.province ?? undefined,
      postalCode: verification.postalCode ?? undefined,
      country: verification.country ?? undefined,
      businessType: verification.businessType ?? undefined,
      businessName: verification.businessName ?? undefined,
      businessRegistrationNumber: verification.businessRegistrationNumber ?? undefined,
      dtiRegistrationNumber: verification.dtiRegistrationNumber ?? undefined,
      secRegistrationNumber: verification.secRegistrationNumber ?? undefined,
      tin: verification.tin ?? undefined,
    });
    if (!parsed.success) {
      return { ok: false, status: "INVALID", error: "Please fix the highlighted fields before submitting." };
    }

    // Scoped to THIS verification's id by construction — there is no query
    // shape here that could ever pull in another verification's document.
    const documents = await tx.sellerVerificationDocument.findMany({
      where: { sellerVerificationId: verification.id },
      select: { id: true, status: true, documentType: true },
    });
    if (documents.some((d) => d.status !== "PENDING")) {
      return {
        ok: false,
        status: "INVALID",
        error: "One of your documents has already been reviewed. Contact support before resubmitting.",
      };
    }

    // Phase 9 — the actual minimum-evidence business policy, replacing the
    // original "at least one document, of any type" rule.
    const pendingDocumentTypes = documents.filter((d) => d.status === "PENDING").map((d) => d.documentType);
    const evidence = validateSellerVerificationSubmission({
      businessType: verification.businessType,
      legalName: verification.legalName,
      phone: verification.phone,
      addressLine1: verification.addressLine1,
      city: verification.city,
      province: verification.province,
      postalCode: verification.postalCode,
      country: verification.country,
      businessName: verification.businessName,
      documentTypes: pendingDocumentTypes,
    });
    if (!evidence.ok) {
      return {
        ok: false,
        status: "INVALID",
        error: evidence.codes.map((c) => SELLER_VERIFICATION_SUBMISSION_FAILURE_MESSAGE[c]).join(" "),
        codes: evidence.codes,
      };
    }

    const updated = await tx.sellerVerification.updateMany({
      where: { id: verification.id, status: "DRAFT" },
      data: { status: "PENDING", submittedAt: new Date() },
    });
    if (updated.count === 0) {
      // A concurrent submission won the race between our read and this
      // write — never a second row, never a silent duplicate.
      return { ok: false, status: "ALREADY_SUBMITTED", error: "This verification was already submitted." };
    }

    const fresh = await tx.sellerVerification.findUniqueOrThrow({
      where: { id: verification.id },
      select: VERIFICATION_SELECT,
    });
    return { ok: true, status: "SUCCESS", verification: fresh };
  };

  try {
    return externalTx ? await run(externalTx) : await prisma.$transaction(run);
  } catch (err) {
    console.error("[seller-verification-repository] submitSellerVerificationForReview failed", err);
    return { ok: false, status: "INVALID", error: "Could not submit your verification." };
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
 * APPROVED/REJECTED) or belongs to a verification that is no longer DRAFT.
 * The latter is genuinely reachable once a verification is APPROVED —
 * `getOrCreateDraftVerification` (Phase 8) returns that row as-is instead of
 * starting a new DRAFT, so this check now actually fires rather than being
 * unreachable.
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

/**
 * Same as `getSellerVerificationDocumentSignedUrlForAdmin`, but additionally
 * verifies the FULL ownership chain the admin review page itself is built
 * around: the document belongs to the stated verification, which belongs to
 * the stated seller. Used by the actual review page's "View" action so a
 * forged/mismatched `sellerId`/`verificationId` in the request (even from an
 * authenticated admin's own browser) can never sign a URL for a document
 * outside that exact chain. `getSellerVerificationDocumentSignedUrlForAdmin`
 * above stays as the simpler, already-tested Phase 3 primitive.
 */
export async function getSellerVerificationDocumentSignedUrlForAdminScoped(input: {
  sellerId: string;
  verificationId: string;
  documentId: string;
}): Promise<SignedUrlResult> {
  const doc = await prisma.sellerVerificationDocument.findUnique({
    where: { id: input.documentId },
    select: { storagePath: true, sellerVerificationId: true, sellerVerification: { select: { sellerId: true } } },
  });
  if (!doc || doc.sellerVerificationId !== input.verificationId || doc.sellerVerification.sellerId !== input.sellerId) {
    return { ok: false, error: "Document not found." };
  }
  const url = await getSellerVerificationSignedUrl(doc.storagePath);
  if (!url) return { ok: false, error: "Could not generate a link for this document." };
  return { ok: true, url };
}

// ---------------------------------------------------------------------------
// Admin review (Phase 4)
// ---------------------------------------------------------------------------

const VERIFICATION_ADMIN_SELECT = {
  id: true,
  sellerId: true,
  status: true,
  submittedAt: true,
  reviewedAt: true,
  reviewedBy: true,
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

type SellerVerificationAdminRow = Prisma.SellerVerificationGetPayload<{ select: typeof VERIFICATION_ADMIN_SELECT }>;
export type SellerVerificationAdminView = SellerVerificationAdminRow & { reviewedByEmail: string | null };

/**
 * The seller's latest verification, for admin review — deliberately NOT
 * seller-scoped (an authorized admin can view any seller, same as
 * `/admin/sellers/[id]` itself); the caller is responsible for its own
 * `requirePermission` check. `reviewedByEmail` is resolved the same way
 * `getAdminSeller`'s `content.reviewedByEmail` already is (a plain lookup on
 * the snapshot `reviewedBy` User.id) — never a new pattern.
 */
export async function getSellerVerificationForAdmin(sellerId: string): Promise<SellerVerificationAdminView | null> {
  const verification = await prisma.sellerVerification.findFirst({
    where: { sellerId },
    orderBy: { createdAt: "desc" },
    select: VERIFICATION_ADMIN_SELECT,
  });
  if (!verification) return null;
  const reviewer = verification.reviewedBy
    ? await prisma.user.findUnique({ where: { id: verification.reviewedBy }, select: { email: true } })
    : null;
  return { ...verification, reviewedByEmail: reviewer?.email ?? null };
}

const DOCUMENT_ADMIN_SELECT = {
  id: true,
  documentType: true,
  status: true,
  uploadedAt: true,
  mimeType: true,
  sizeBytes: true,
  reviewedAt: true,
  reviewNote: true,
} as const;

export type SellerVerificationDocumentAdminView = Prisma.SellerVerificationDocumentGetPayload<{
  select: typeof DOCUMENT_ADMIN_SELECT;
}>;

/** Every document on one verification, for admin review. Never bucket/storagePath — see getSellerVerificationDocumentSignedUrlForAdminScoped for viewing. */
export async function listSellerVerificationDocumentsForAdmin(
  verificationId: string,
): Promise<SellerVerificationDocumentAdminView[]> {
  return prisma.sellerVerificationDocument.findMany({
    where: { sellerVerificationId: verificationId },
    orderBy: { documentType: "asc" },
    select: DOCUMENT_ADMIN_SELECT,
  });
}

export type AdminReviewResult =
  | { ok: true; sellerName: string; documentType?: string }
  | { ok: false; error: string };

/**
 * Approve or reject ONE document. Guards (section 10 of the Phase 4 spec):
 * the document must exist, must belong to the STATED verification, which
 * must belong to the STATED seller — none of `sellerId` / `verificationId` /
 * `documentId` is trusted alone, even though the caller is already an
 * authorized admin (defense in depth against a forged/stale form value).
 * Only a PENDING document can be decided — an already-finalized one
 * (APPROVED/REJECTED) is immutable from here, matching the same "no silent
 * overwrite of history" rule Phase 3 already enforces for seller-side
 * replace/delete. Status-guarded `updateMany` closes the same race a
 * concurrent second reviewer could otherwise hit (same pattern as
 * `approveSellerContentAction`'s `contentStatus: "PENDING"` guard).
 */
export async function reviewSellerVerificationDocumentForAdmin(input: {
  sellerId: string;
  verificationId: string;
  documentId: string;
  status: "APPROVED" | "REJECTED";
  reviewNote: string | null;
  reviewedBy: string;
}): Promise<AdminReviewResult> {
  const doc = await prisma.sellerVerificationDocument.findUnique({
    where: { id: input.documentId },
    select: {
      id: true,
      status: true,
      documentType: true,
      sellerVerificationId: true,
      sellerVerification: { select: { sellerId: true, seller: { select: { displayName: true } } } },
    },
  });
  if (!doc || doc.sellerVerificationId !== input.verificationId || doc.sellerVerification.sellerId !== input.sellerId) {
    return { ok: false, error: "Document not found." };
  }
  if (doc.status !== "PENDING") {
    return { ok: false, error: "This document has already been reviewed." };
  }

  const updated = await prisma.sellerVerificationDocument.updateMany({
    where: { id: doc.id, status: "PENDING" },
    data: { status: input.status, reviewedAt: new Date(), reviewedBy: input.reviewedBy, reviewNote: input.reviewNote },
  });
  if (updated.count === 0) {
    return { ok: false, error: "This document changed while you were reviewing it. Reload and try again." };
  }

  return { ok: true, sellerName: doc.sellerVerification.seller.displayName, documentType: doc.documentType };
}

/**
 * Approve or reject the OVERALL verification (PENDING → APPROVED/REJECTED
 * only — see the Phase 4 spec's own framing; nothing in Phases 1–3 ever
 * moves a verification out of DRAFT yet, so this can only act on a row a
 * test (or a later "submit for review" phase) has explicitly put into
 * PENDING first). Deliberately does NOT touch `Seller.status`, does NOT
 * create a `SellerUser`, and does NOT touch `SellerInvite` — those stay
 * fully separate, exactly as required; nothing below ever calls
 * `transitionSellerStatus`, `createOwnerInviteIfNeeded`, or any SellerUser
 * write.
 */
export async function reviewSellerVerificationForAdmin(input: {
  sellerId: string;
  verificationId: string;
  status: "APPROVED" | "REJECTED";
  reviewNote: string | null;
  reviewedBy: string;
}): Promise<AdminReviewResult> {
  const verification = await prisma.sellerVerification.findUnique({
    where: { id: input.verificationId },
    select: { id: true, sellerId: true, status: true, seller: { select: { displayName: true } } },
  });
  if (!verification || verification.sellerId !== input.sellerId) {
    return { ok: false, error: "Verification not found." };
  }
  if (verification.status !== "PENDING") {
    return { ok: false, error: `This verification is ${verification.status.toLowerCase()}, not awaiting review.` };
  }

  const updated = await prisma.sellerVerification.updateMany({
    where: { id: verification.id, status: "PENDING" },
    data: { status: input.status, reviewedAt: new Date(), reviewedBy: input.reviewedBy, reviewNote: input.reviewNote },
  });
  if (updated.count === 0) {
    return { ok: false, error: "This verification changed while you were reviewing it. Reload and try again." };
  }

  return { ok: true, sellerName: verification.seller.displayName };
}
