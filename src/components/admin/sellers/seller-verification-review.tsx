"use client";

import { useEffect, useState } from "react";
import { Loader2, Check, X, ExternalLink } from "lucide-react";
import { FormField, StatusBadge, notify, usePersistentAction } from "@/components/admin/ui";
import {
  reviewSellerVerificationAction,
  reviewSellerVerificationDocumentAction,
  getScopedSellerVerificationDocumentSignedUrlAction,
  type SellerVerificationAdminActionState,
} from "@/lib/admin/seller-verification-actions";
import { SELLER_VERIFICATION_DOCUMENT_TYPE_LABELS, type SellerVerificationDocumentType } from "@/lib/seller-verification/document-types";

const STATUS_TONE: Record<string, "neutral" | "info" | "success" | "danger"> = {
  PENDING: "info",
  APPROVED: "success",
  REJECTED: "danger",
};

/**
 * Verification-level decision (Phase 4). Mirrors `SellerContentReviewPanel`'s
 * shape exactly (approve / reject with a note, reject requires one) — only
 * shown by the page when `verification.status === "PENDING"`. Approving or
 * rejecting here never touches `Seller.status`, `SellerUser`, or
 * `SellerInvite` — the server action enforces that, this panel just calls it.
 */
export function SellerVerificationDecisionPanel({
  sellerId,
  verificationId,
}: {
  sellerId: string;
  verificationId: string;
}) {
  const [note, setNote] = useState("");
  const decide = usePersistentAction<SellerVerificationAdminActionState>(reviewSellerVerificationAction, {});

  useEffect(() => {
    if (decide.state.ok && decide.state.message) notify.success(decide.state.message);
    if (decide.state.error) notify.error(decide.state.error);
  }, [decide.state]);

  return (
    <div className="space-y-3">
      <FormField label="Note" htmlFor="verification-review-note" hint="Required to reject; optional on approval.">
        <textarea
          id="verification-review-note"
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={2000}
          className="field text-sm"
        />
      </FormField>
      <div className="flex flex-wrap gap-2">
        <form onSubmit={decide.onSubmit}>
          <input type="hidden" name="sellerId" value={sellerId} />
          <input type="hidden" name="verificationId" value={verificationId} />
          <input type="hidden" name="status" value="APPROVED" />
          <input type="hidden" name="reviewNote" value={note} />
          <button type="submit" disabled={decide.pending} className="btn btn-primary py-2 text-sm">
            {decide.pending ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            Approve verification
          </button>
        </form>
        <form onSubmit={decide.onSubmit}>
          <input type="hidden" name="sellerId" value={sellerId} />
          <input type="hidden" name="verificationId" value={verificationId} />
          <input type="hidden" name="status" value="REJECTED" />
          <input type="hidden" name="reviewNote" value={note} />
          <button type="submit" disabled={decide.pending} className="btn btn-secondary py-2 text-sm">
            {decide.pending ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
            Reject verification
          </button>
        </form>
      </div>
    </div>
  );
}

export type AdminDocumentView = {
  id: string;
  documentType: string;
  status: string;
  uploadedAt: string;
  mimeType: string;
  sizeBytes: number;
  reviewedAt: string | null;
  reviewNote: string | null;
};

/**
 * One document's admin card: metadata, a "View" button that requests a
 * short-lived signed URL through the SCOPED server action (never a direct
 * Storage call from the browser, never a raw bucket/path the client
 * controls), and — only while PENDING — approve/reject controls. An
 * already-decided document shows its outcome read-only; the server itself
 * also refuses to re-decide it (this UI reflects that, doesn't enforce it).
 */
export function SellerVerificationDocumentReviewCard({
  sellerId,
  verificationId,
  document,
}: {
  sellerId: string;
  verificationId: string;
  document: AdminDocumentView;
}) {
  const [viewing, setViewing] = useState(false);
  const [note, setNote] = useState("");
  const review = usePersistentAction<SellerVerificationAdminActionState>(reviewSellerVerificationDocumentAction, {});

  useEffect(() => {
    if (review.state.ok && review.state.message) notify.success(review.state.message);
    if (review.state.error) notify.error(review.state.error);
  }, [review.state]);

  async function handleView() {
    setViewing(true);
    try {
      const res = await getScopedSellerVerificationDocumentSignedUrlAction({
        sellerId,
        verificationId,
        documentId: document.id,
      });
      if (!res.ok) {
        notify.error(res.error);
        return;
      }
      window.open(res.url, "_blank", "noopener,noreferrer");
    } finally {
      setViewing(false);
    }
  }

  const label = SELLER_VERIFICATION_DOCUMENT_TYPE_LABELS[document.documentType as SellerVerificationDocumentType] ?? document.documentType;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-ink-faint">
            {document.mimeType} · {(document.sizeBytes / 1024).toFixed(0)} KB · uploaded{" "}
            {new Date(document.uploadedAt).toLocaleDateString()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge tone={STATUS_TONE[document.status] ?? "neutral"}>{document.status}</StatusBadge>
          <button
            type="button"
            onClick={handleView}
            disabled={viewing}
            className="inline-flex items-center gap-1 rounded-sm border border-line px-2 py-1 text-xs text-ink-soft hover:bg-surface-sunken"
          >
            {viewing ? <Loader2 size={12} className="animate-spin" /> : <ExternalLink size={12} />}
            View
          </button>
        </div>
      </div>

      {document.reviewedAt && (
        <p className="text-xs text-ink-faint">
          Reviewed {new Date(document.reviewedAt).toLocaleString()}
          {document.reviewNote ? ` — ${document.reviewNote}` : ""}
        </p>
      )}

      {document.status === "PENDING" && (
        <div className="space-y-2 rounded-sm border border-line bg-surface-sunken/40 p-3">
          <textarea
            placeholder="Note (required to reject)"
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={2000}
            className="field text-xs"
          />
          <div className="flex flex-wrap gap-2">
            <form onSubmit={review.onSubmit}>
              <input type="hidden" name="sellerId" value={sellerId} />
              <input type="hidden" name="verificationId" value={verificationId} />
              <input type="hidden" name="documentId" value={document.id} />
              <input type="hidden" name="status" value="APPROVED" />
              <input type="hidden" name="reviewNote" value={note} />
              <button type="submit" disabled={review.pending} className="btn btn-primary py-1.5 text-xs">
                {review.pending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                Approve
              </button>
            </form>
            <form onSubmit={review.onSubmit}>
              <input type="hidden" name="sellerId" value={sellerId} />
              <input type="hidden" name="verificationId" value={verificationId} />
              <input type="hidden" name="documentId" value={document.id} />
              <input type="hidden" name="status" value="REJECTED" />
              <input type="hidden" name="reviewNote" value={note} />
              <button type="submit" disabled={review.pending} className="btn btn-secondary py-1.5 text-xs">
                {review.pending ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
                Reject
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
