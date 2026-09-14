import { z } from "zod";
import { COUNTRY_CODES, getCountry } from "@/lib/countries";
import { SELLER_VERIFICATION_BUSINESS_TYPES } from "@/lib/seller-verification/business-types";

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
