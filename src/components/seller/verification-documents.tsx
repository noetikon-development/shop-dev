"use client";

import { useActionState, useEffect, useRef } from "react";
import { Loader2, Upload, Trash2 } from "lucide-react";
import {
  uploadSellerVerificationDocumentAction,
  deleteSellerVerificationDocumentAction,
  type SellerVerificationUploadActionState,
} from "@/lib/seller-verification/actions";
import {
  SELLER_VERIFICATION_DOCUMENT_TYPES,
  SELLER_VERIFICATION_DOCUMENT_TYPE_LABELS,
  type SellerVerificationDocumentType,
} from "@/lib/seller-verification/document-types";
import { notify, usePersistentAction } from "@/components/seller/ui";

const ACCEPT = "image/png,image/jpeg,image/webp,application/pdf";

const STATUS_LABEL: Record<string, string> = {
  PENDING: "Uploaded — awaiting review",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

export type SellerVerificationDocumentListItem = {
  id: string;
  documentType: string;
  status: string;
  uploadedAt: string;
};

/**
 * Document upload section for `/seller/verification` (Phase 3).
 *
 * Deliberately shows metadata only — document type, status, upload date.
 * Never a filename (none is stored — the server never keys a file by its
 * original name, see upload-validation.ts), never a bucket name or storage
 * path, never a public or signed URL. Every upload/replace/delete goes
 * through a server action; no Supabase Storage client of any kind runs in
 * this file or anywhere else in the browser for this feature.
 */
export function SellerVerificationDocuments({
  documents,
  readOnly = false,
}: {
  documents: SellerVerificationDocumentListItem[];
  /** True once the verification is no longer DRAFT (Phase 5) — see verification-form.tsx's same prop. */
  readOnly?: boolean;
}) {
  const byType = new Map(documents.map((d) => [d.documentType, d]));

  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-faint">
        PNG, JPG, WEBP or PDF · up to 8 MB. Stored privately — never publicly accessible, and no type here is required yet.
      </p>
      {readOnly && (
        <p className="text-xs text-ink-faint">Documents can no longer be added or changed once submitted.</p>
      )}
      {SELLER_VERIFICATION_DOCUMENT_TYPES.map((type) => (
        <DocumentSlot key={type} type={type} document={byType.get(type) ?? null} readOnly={readOnly} />
      ))}
    </div>
  );
}

function DocumentSlot({
  type,
  document,
  readOnly,
}: {
  type: SellerVerificationDocumentType;
  document: SellerVerificationDocumentListItem | null;
  readOnly: boolean;
}) {
  const [state, formAction, pending] = useActionState<SellerVerificationUploadActionState, FormData>(
    uploadSellerVerificationDocumentAction,
    {},
  );
  const formRef = useRef<HTMLFormElement>(null);
  const del = usePersistentAction<SellerVerificationUploadActionState>(deleteSellerVerificationDocumentAction, {});

  useEffect(() => {
    if (state.ok) {
      notify.success(state.message ?? "Uploaded");
      formRef.current?.reset();
    }
    if (state.error) notify.error(state.error);
  }, [state]);
  useEffect(() => {
    if (del.state.ok && del.state.message) notify.success(del.state.message);
    if (del.state.error) notify.error(del.state.error);
  }, [del.state]);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-sm border border-line p-3">
      <div>
        <p className="text-sm font-medium">{SELLER_VERIFICATION_DOCUMENT_TYPE_LABELS[type]}</p>
        <p className="text-xs text-ink-faint">
          {document
            ? `${STATUS_LABEL[document.status] ?? document.status} · uploaded ${new Date(document.uploadedAt).toLocaleDateString()}`
            : "Not uploaded yet"}
        </p>
      </div>
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <form ref={formRef} action={formAction} className="flex items-center gap-2">
            <input type="hidden" name="documentType" value={type} />
            <input
              type="file"
              name="file"
              required
              accept={ACCEPT}
              className="max-w-[180px] text-xs file:mr-2 file:rounded-sm file:border-0 file:bg-ink file:px-2 file:py-1 file:text-[11px] file:text-paper"
            />
            <button type="submit" disabled={pending} className="btn btn-outline py-1.5 text-xs">
              {pending ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
              {document ? "Replace" : "Upload"}
            </button>
          </form>
          {document && (
            <form onSubmit={del.onSubmit}>
              <input type="hidden" name="documentId" value={document.id} />
              <button
                type="submit"
                className="inline-flex items-center gap-1 rounded-sm border border-line px-1.5 py-1 text-[11px] text-ink-soft hover:bg-surface-sunken"
              >
                <Trash2 size={11} /> Delete
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
