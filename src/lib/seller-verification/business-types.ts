/**
 * Seller Verification — controlled business-type vocabulary (Phase 2).
 *
 * Pure data — safe to import from client and server, matching the existing
 * convention for shared vocabularies (e.g. src/lib/countries.ts). Kept to the
 * four types explicitly approved for this phase; no more detailed legal
 * taxonomy (e.g. one-person corporation, cooperative) is assumed until the
 * project has an actual need for it.
 */

export const SELLER_VERIFICATION_BUSINESS_TYPES = [
  "INDIVIDUAL",
  "SOLE_PROPRIETOR",
  "PARTNERSHIP",
  "CORPORATION",
] as const;

export type SellerVerificationBusinessType = (typeof SELLER_VERIFICATION_BUSINESS_TYPES)[number];

export function isSellerVerificationBusinessType(v: string): v is SellerVerificationBusinessType {
  return (SELLER_VERIFICATION_BUSINESS_TYPES as readonly string[]).includes(v);
}

export const SELLER_VERIFICATION_BUSINESS_TYPE_LABELS: Record<SellerVerificationBusinessType, string> = {
  INDIVIDUAL: "Individual",
  SOLE_PROPRIETOR: "Sole proprietorship",
  PARTNERSHIP: "Partnership",
  CORPORATION: "Corporation",
};

/**
 * Business types for which a registration number (business registration,
 * DTI, SEC) is realistically applicable. An INDIVIDUAL seller has none of
 * these — the fields simply stay null for them, never required. This list
 * only drives which fields the UI *shows*; nothing in this phase enforces
 * them as required even when applicable, since Save Draft must always accept
 * partial data (there is no "submit for review" transition yet).
 */
export const BUSINESS_TYPES_WITH_REGISTRATION: readonly SellerVerificationBusinessType[] = [
  "SOLE_PROPRIETOR",
  "PARTNERSHIP",
  "CORPORATION",
];
