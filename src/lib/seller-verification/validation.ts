import { z } from "zod";
import { COUNTRY_CODES, getCountry } from "@/lib/countries";
import { SELLER_VERIFICATION_BUSINESS_TYPES, BUSINESS_TYPES_WITH_REGISTRATION } from "@/lib/seller-verification/business-types";
import type { SellerVerificationBusinessType } from "@/lib/seller-verification/business-types";
import type { SellerVerificationDocumentType } from "@/lib/seller-verification/document-types";

/**
 * Seller Verification draft validation (Phase 2).
 *
 * Every field is optional — this is a DRAFT save, not a submission gate.
 * There is no "submit for review" transition yet (status stays DRAFT
 * throughout this phase), so nothing here may ever require a field to be
 * present; validation only checks the SHAPE of a value that was provided,
 * reusing the same country-aware phone/postal patterns the customer address
 * book already uses (src/lib/addresses.ts) rather than inventing new rules.
 * Registration-number fields (business registration, DTI, SEC, TIN) have no
 * project-established authoritative format, so they get only a loose sanity
 * check — never a hard pattern that could reject a real, valid number.
 */
const optionalText = (max: number) => z.string().trim().max(max).optional().or(z.literal(""));

export const sellerVerificationDraftSchema = z
  .object({
    legalName: optionalText(120),
    phone: optionalText(30),
    addressLine1: optionalText(120),
    addressLine2: optionalText(120),
    barangay: optionalText(80),
    city: optionalText(80),
    province: optionalText(80),
    postalCode: optionalText(12),
    country: z.enum(COUNTRY_CODES).optional().or(z.literal("")),
    businessType: z.enum(SELLER_VERIFICATION_BUSINESS_TYPES).optional().or(z.literal("")),
    businessName: optionalText(160),
    businessRegistrationNumber: optionalText(60),
    dtiRegistrationNumber: optionalText(60),
    secRegistrationNumber: optionalText(60),
    tin: optionalText(20),
  })
  .superRefine((val, ctx) => {
    const country = val.country ? getCountry(val.country) : undefined;
    if (val.phone && country && !country.phonePattern.test(val.phone)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["phone"], message: "That phone number doesn’t look right." });
    }
    if (val.postalCode && country && !country.postalPattern.test(val.postalCode)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["postalCode"],
        message: `That postal code doesn’t look right for ${country.name}.`,
      });
    }
    // Loose sanity check only (digits, spaces, dashes) — no authoritative
    // BIR TIN format is established anywhere else in this project.
    if (val.tin && !/^[\d\s-]{6,20}$/.test(val.tin)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tin"], message: "TIN should contain only digits and dashes." });
    }
  });

export type SellerVerificationDraftInput = z.infer<typeof sellerVerificationDraftSchema>;

// ---------------------------------------------------------------------------
// Submission requirements (Phase 9)
//
// Separate from the draft SHAPE schema above — this is the minimum-EVIDENCE
// gate `submitSellerVerificationForReview` (Phase 5) enforces before a DRAFT
// can move to PENDING. It replaces that phase's original, deliberately
// permissive "at least one document, of any type" rule with the actual
// business policy: which IDENTITY fields and DOCUMENT TYPES are required,
// and that they differ by business type.
//
// Deliberately NOT covered here (explicit business-policy scope limits):
//   - BUSINESS_PERMIT is never automatically required — "where applicable"
//     is an admin/business-policy judgment this phase does not automate.
//     An admin can still reject a PENDING submission that's missing one,
//     with a reason, using the existing Phase 4 review action — no new code
//     needed for that path.
//   - businessRegistrationNumber / dtiRegistrationNumber /
//     secRegistrationNumber / tin (the free-text fields) stay fully
//     optional — only the BUSINESS_REGISTRATION *document* is required for
//     a business seller, never a specific registration-number field.
//   - GOVERNMENT_ID_SECONDARY and PROOF_OF_ADDRESS remain allowed but never
//     required.
//   - A seller who has never picked a business type is treated as
//     INDIVIDUAL (the least-restrictive tier) for this check — there is no
//     "select a business type" requirement in this phase's policy, and
//     erring toward the lower bar avoids inventing a new blocking rule the
//     business policy never asked for.
// ---------------------------------------------------------------------------

/** Business types whose seller must also provide a BUSINESS_REGISTRATION document. */
const BUSINESS_TYPES_REQUIRING_REGISTRATION_DOCUMENT: readonly SellerVerificationBusinessType[] =
  BUSINESS_TYPES_WITH_REGISTRATION;

/**
 * The document types required for this business type. Shared by the
 * server-side submission gate and the seller-facing UI (Step 3), so what the
 * UI shows as "Required" can never drift from what the server actually
 * enforces. `businessType` of `null`/`""` (never selected) resolves to the
 * INDIVIDUAL tier — see the file-level note above.
 */
export function requiredDocumentTypesForBusinessType(
  businessType: string | null | undefined,
): SellerVerificationDocumentType[] {
  const required: SellerVerificationDocumentType[] = ["GOVERNMENT_ID_PRIMARY"];
  if (
    businessType &&
    BUSINESS_TYPES_REQUIRING_REGISTRATION_DOCUMENT.includes(businessType as SellerVerificationBusinessType)
  ) {
    required.push("BUSINESS_REGISTRATION");
  }
  return required;
}

/** Whether this business type also requires a business name and registration evidence. */
export function businessTypeRequiresBusinessDetails(businessType: string | null | undefined): boolean {
  return Boolean(
    businessType && BUSINESS_TYPES_REQUIRING_REGISTRATION_DOCUMENT.includes(businessType as SellerVerificationBusinessType),
  );
}

/**
 * Deterministic, machine-readable submission-requirement failure codes.
 * `MISSING_BUSINESS_PERMIT` is defined for completeness (the business policy
 * names it explicitly) but is NEVER emitted by `validateSellerVerificationSubmission`
 * itself — see the file-level note above.
 */
export const SELLER_VERIFICATION_SUBMISSION_FAILURE_CODES = [
  "MISSING_LEGAL_NAME",
  "MISSING_PHONE",
  "MISSING_ADDRESS",
  "MISSING_BUSINESS_NAME",
  "MISSING_PRIMARY_GOVERNMENT_ID",
  "MISSING_BUSINESS_REGISTRATION",
  "MISSING_BUSINESS_PERMIT",
] as const;
export type SellerVerificationSubmissionFailureCode = (typeof SELLER_VERIFICATION_SUBMISSION_FAILURE_CODES)[number];

/** Human-readable, PII-free message for each failure code — never echoes the seller's own data back. */
export const SELLER_VERIFICATION_SUBMISSION_FAILURE_MESSAGE: Record<SellerVerificationSubmissionFailureCode, string> = {
  MISSING_LEGAL_NAME: "Add your legal name.",
  MISSING_PHONE: "Add your phone number.",
  MISSING_ADDRESS: "Complete your address (street, city, province, postal code, and country).",
  MISSING_BUSINESS_NAME: "Add your business name.",
  MISSING_PRIMARY_GOVERNMENT_ID: "Upload a primary government ID.",
  MISSING_BUSINESS_REGISTRATION: "Upload your business registration document.",
  MISSING_BUSINESS_PERMIT: "Upload your business permit.",
};

export type SellerVerificationSubmissionCheckInput = {
  businessType: string | null;
  legalName: string | null;
  phone: string | null;
  addressLine1: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  country: string | null;
  businessName: string | null;
  /** The distinct document TYPES currently attached and still PENDING (never reviewed documents — those are a separate, existing check). */
  documentTypes: string[];
};

export type SellerVerificationSubmissionCheck =
  | { ok: true }
  | { ok: false; codes: SellerVerificationSubmissionFailureCode[] };

const hasText = (v: string | null | undefined): boolean => typeof v === "string" && v.trim().length > 0;

/**
 * The single, reusable source of truth for "is this verification ready to
 * submit?" — called by the authoritative server-side submit path
 * (`submitSellerVerificationForReview`) and by the seller-facing UI (to show
 * what's required/missing before the seller even tries). The UI calling this
 * is a courtesy, never the enforcement — the server re-runs this same
 * function inside the submit transaction regardless of what the UI showed.
 */
export function validateSellerVerificationSubmission(
  input: SellerVerificationSubmissionCheckInput,
): SellerVerificationSubmissionCheck {
  const codes: SellerVerificationSubmissionFailureCode[] = [];

  if (!hasText(input.legalName)) codes.push("MISSING_LEGAL_NAME");
  if (!hasText(input.phone)) codes.push("MISSING_PHONE");
  if (!hasText(input.addressLine1) || !hasText(input.city) || !hasText(input.province) || !hasText(input.postalCode) || !hasText(input.country)) {
    codes.push("MISSING_ADDRESS");
  }

  if (businessTypeRequiresBusinessDetails(input.businessType)) {
    if (!hasText(input.businessName)) codes.push("MISSING_BUSINESS_NAME");
  }

  for (const requiredType of requiredDocumentTypesForBusinessType(input.businessType)) {
    if (!input.documentTypes.includes(requiredType)) {
      codes.push(requiredType === "GOVERNMENT_ID_PRIMARY" ? "MISSING_PRIMARY_GOVERNMENT_ID" : "MISSING_BUSINESS_REGISTRATION");
    }
  }

  return codes.length === 0 ? { ok: true } : { ok: false, codes };
}
