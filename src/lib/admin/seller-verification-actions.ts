"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePermission } from "@/lib/admin/rbac";
import { writeAudit } from "@/lib/admin/audit";
import { cleanUserText } from "@/lib/ugc";
import { scheduleEmail } from "@/lib/email/schedule";
import { sendSellerVerificationApproved, sendSellerVerificationRejected } from "@/lib/email/notifications";
import {
  getSellerVerificationDocumentSignedUrlForAdmin,
  getSellerVerificationDocumentSignedUrlForAdminScoped,
  reviewSellerVerificationDocumentForAdmin,
  reviewSellerVerificationForAdmin,
} from "@/lib/seller-verification/repository";

/**
 * Admin Seller Verification — review actions (Phase 4).
 *
 * Every action requires `manage_settings` — the SAME permission
 * `admin/sellers/actions.ts` already requires for seller lifecycle decisions
 * (approve/suspend/close) and Phase 3's signed-url action already used. No
 * new permission was added, `scripts/seed-rbac.ts` is untouched.
 *
 * None of these ever touch `Seller.status`, create a `SellerUser`, or touch
 * `SellerInvite` — verification review is a fully independent decision from
 * seller activation, exactly as required.
 *
 * Phase 7 — `reviewSellerVerificationAction`'s overall PENDING→APPROVED/
 * REJECTED decision (never the per-document review) additionally schedules
 * one outcome email, AFTER the DB transition and audit write have both
 * already committed — mirroring `transitionSellerAction`'s exact placement
 * (`src/lib/admin/sellers/actions.ts`). `scheduleEmail` defers the actual
 * send past the response via `after()`, so SMTP delivery (or its failure)
 * can never affect the review decision that already succeeded.
 */

export type SellerVerificationAdminActionState = {
  ok?: boolean;
  error?: string;
  message?: string;
};

export async function getSellerVerificationDocumentSignedUrlForAdminAction(
  documentId: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  await requirePermission("manage_settings");
  if (!documentId || typeof documentId !== "string") return { ok: false, error: "Invalid request." };
  return getSellerVerificationDocumentSignedUrlForAdmin(documentId);
}

const viewSchema = z.object({
  sellerId: z.string().min(1).max(64),
  verificationId: z.string().min(1).max(64),
  documentId: z.string().min(1).max(64),
});

/**
 * The action the review page's "View" button actually calls — verifies the
 * full sellerId → verificationId → documentId chain server-side before ever
 * issuing a signed URL (see getSellerVerificationDocumentSignedUrlForAdminScoped),
 * so a stale or tampered form value can never sign a URL outside that chain.
 */
export async function getScopedSellerVerificationDocumentSignedUrlAction(
  input: { sellerId: string; verificationId: string; documentId: string },
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  await requirePermission("manage_settings");
  const parsed = viewSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  return getSellerVerificationDocumentSignedUrlForAdminScoped(parsed.data);
}

const documentReviewSchema = z.object({
  sellerId: z.string().min(1).max(64),
  verificationId: z.string().min(1).max(64),
  documentId: z.string().min(1).max(64),
  status: z.enum(["APPROVED", "REJECTED"]),
  reviewNote: z.string().trim().max(2000).optional().or(z.literal("")),
});

export async function reviewSellerVerificationDocumentAction(
  _prev: SellerVerificationAdminActionState,
  formData: FormData,
): Promise<SellerVerificationAdminActionState> {
  const admin = await requirePermission("manage_settings");

  const parsed = documentReviewSchema.safeParse({
    sellerId: formData.get("sellerId"),
    verificationId: formData.get("verificationId"),
    documentId: formData.get("documentId"),
    status: formData.get("status"),
    reviewNote: formData.get("reviewNote") ?? "",
  });
  if (!parsed.success) return { error: "Invalid request." };
  const { sellerId, verificationId, documentId, status } = parsed.data;

  const reviewNote = parsed.data.reviewNote ? cleanUserText(parsed.data.reviewNote) : "";
  if (status === "REJECTED" && !reviewNote) {
    return { error: "Add a reason so the seller knows what to fix." };
  }

  const res = await reviewSellerVerificationDocumentForAdmin({
    sellerId,
    verificationId,
    documentId,
    status,
    reviewNote: reviewNote || null,
    reviewedBy: admin.user.id,
  });
  if (!res.ok) return { error: res.error };

  // No document contents, no PII field values — only ids, the document TYPE
  // (a category, not personal data) and the admin's own reason text, the
  // same discipline the seller-lifecycle reject/reopen audits already use
  // for their `reason`/`note`.
  await writeAudit({
    actorUserId: admin.user.id,
    action: status === "APPROVED" ? "seller.verification_document_approved" : "seller.verification_document_rejected",
    targetType: "seller_verification_document",
    targetId: documentId,
    summary: `${admin.user.email} ${status === "APPROVED" ? "approved" : "rejected"} a ${(res.documentType ?? "").toLowerCase()} document for seller ${res.sellerName}`,
    meta: {
      sellerId,
      sellerVerificationId: verificationId,
      sellerVerificationDocumentId: documentId,
      documentType: res.documentType,
      status,
      ...(status === "REJECTED" ? { reason: reviewNote } : {}),
    },
  });

  revalidatePath(`/admin/sellers/${sellerId}/verification`);
  return { ok: true, message: status === "APPROVED" ? "Document approved." : "Document rejected." };
}

const verificationReviewSchema = z.object({
  sellerId: z.string().min(1).max(64),
  verificationId: z.string().min(1).max(64),
  status: z.enum(["APPROVED", "REJECTED"]),
  reviewNote: z.string().trim().max(2000).optional().or(z.literal("")),
});

/**
 * Decide the OVERALL verification. Deliberately does not touch
 * `Seller.status`, `SellerUser`, or `SellerInvite` — seller activation stays
 * a fully separate, later decision (Phase 4 spec section 8).
 */
export async function reviewSellerVerificationAction(
  _prev: SellerVerificationAdminActionState,
  formData: FormData,
): Promise<SellerVerificationAdminActionState> {
  const admin = await requirePermission("manage_settings");

  const parsed = verificationReviewSchema.safeParse({
    sellerId: formData.get("sellerId"),
    verificationId: formData.get("verificationId"),
    status: formData.get("status"),
    reviewNote: formData.get("reviewNote") ?? "",
  });
  if (!parsed.success) return { error: "Invalid request." };
  const { sellerId, verificationId, status } = parsed.data;

  const reviewNote = parsed.data.reviewNote ? cleanUserText(parsed.data.reviewNote) : "";
  if (status === "REJECTED" && !reviewNote) {
    return { error: "Add a reason so the seller knows what to fix." };
  }

  const res = await reviewSellerVerificationForAdmin({
    sellerId,
    verificationId,
    status,
    reviewNote: reviewNote || null,
    reviewedBy: admin.user.id,
  });
  if (!res.ok) return { error: res.error };

  const auditLogId = await writeAudit({
    actorUserId: admin.user.id,
    action: status === "APPROVED" ? "seller.verification_approved" : "seller.verification_rejected",
    targetType: "seller_verification",
    targetId: verificationId,
    summary: `${admin.user.email} ${status === "APPROVED" ? "approved" : "rejected"} ${res.sellerName}'s seller verification`,
    meta: {
      sellerId,
      sellerVerificationId: verificationId,
      status,
      ...(status === "REJECTED" ? { reason: reviewNote } : {}),
    },
  });

  // Phase 7 — notify the seller, never blocking the response on SMTP delivery.
  // The audit row's own id anchors the idempotency key (never Seller/verification
  // `updatedAt`, which an unrelated edit could also bump) — mirrors
  // `transitionSellerAction`'s exact placement and pattern.
  if (auditLogId) {
    if (status === "APPROVED") {
      scheduleEmail(() => sendSellerVerificationApproved(sellerId, verificationId, auditLogId));
    } else {
      scheduleEmail(() => sendSellerVerificationRejected(sellerId, verificationId, auditLogId));
    }
  }

  revalidatePath(`/admin/sellers/${sellerId}/verification`);
  return {
    ok: true,
    message:
      status === "APPROVED"
        ? "Verification approved. This does not change the seller's account status."
        : "Verification rejected.",
  };
}
