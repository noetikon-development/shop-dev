/**
 * Seller Verification — controlled document-type vocabulary (Phase 3).
 *
 * Pure data — safe to import from client and server, matching the existing
 * convention (business-types.ts, src/lib/countries.ts). No type here is
 * universally mandatory; that decision belongs to a later review phase, not
 * the upload foundation.
 */

export const SELLER_VERIFICATION_DOCUMENT_TYPES = [
  "GOVERNMENT_ID_PRIMARY",
  "GOVERNMENT_ID_SECONDARY",
  "BUSINESS_PERMIT",
  "BUSINESS_REGISTRATION",
  "PROOF_OF_ADDRESS",
  "OTHER",
] as const;

export type SellerVerificationDocumentType = (typeof SELLER_VERIFICATION_DOCUMENT_TYPES)[number];

export function isSellerVerificationDocumentType(v: string): v is SellerVerificationDocumentType {
  return (SELLER_VERIFICATION_DOCUMENT_TYPES as readonly string[]).includes(v);
}

export const SELLER_VERIFICATION_DOCUMENT_TYPE_LABELS: Record<SellerVerificationDocumentType, string> = {
  GOVERNMENT_ID_PRIMARY: "Primary government ID",
  GOVERNMENT_ID_SECONDARY: "Secondary government ID",
  BUSINESS_PERMIT: "Business permit",
  BUSINESS_REGISTRATION: "Business registration",
  PROOF_OF_ADDRESS: "Proof of address",
  OTHER: "Other",
};

export const SELLER_VERIFICATION_DOCUMENT_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;
export type SellerVerificationDocumentStatus = (typeof SELLER_VERIFICATION_DOCUMENT_STATUSES)[number];
