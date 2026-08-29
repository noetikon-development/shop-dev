import { z } from "zod";

/**
 * Server-side validation for catalog management (Step 5). Every product,
 * category and variant mutation runs its input through one of these before
 * touching the database. Client forms may mirror the rules for UX, but these
 * are the authority.
 */

export const PRODUCT_STATUSES = ["DRAFT", "ACTIVE", "ARCHIVED"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const VARIANT_STATUSES = ["ACTIVE", "ARCHIVED"] as const;
export type VariantStatus = (typeof VARIANT_STATUSES)[number];

/** URL-safe, lowercase, hyphen-separated. */
export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Slug is required")
  .max(120, "Slug is too long")
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and single hyphens");

/** Integer centavos, never negative, capped at ₱10,000,000. */
export const priceSchema = z
  .number("Enter a valid amount")
  .int("Amount must be a whole number of centavos")
  .min(0, "Amount can’t be negative")
  .max(10_000_000_00, "Amount is too large");

export const skuSchema = z
  .string()
  .trim()
  .min(1, "SKU is required")
  .max(64, "SKU is too long")
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "SKU may use letters, numbers and . _ / -");

const nameSchema = z.string().trim().min(2, "Enter a name").max(160, "Name is too long");

// ---------------------------------------------------------------------------
// Product
// ---------------------------------------------------------------------------

const productBase = z.object({
  name: nameSchema,
  slug: slugSchema,
  shortDescription: z.string().trim().min(1, "Enter a short description").max(300),
  description: z.string().trim().min(1, "Enter a description").max(8000),
  categoryId: z.string().trim().min(1, "Choose a category"),
  status: z.enum(PRODUCT_STATUSES),
  featured: z.boolean(),
  freeShipping: z.boolean(),
  price: priceSchema,
  compareAtPrice: priceSchema.nullable().optional(),
  weightGrams: z.number().int().min(0).max(1_000_000).optional(),
});

const compareAtRule = {
  check: (v: { compareAtPrice?: number | null; price: number }) =>
    v.compareAtPrice == null || v.compareAtPrice > v.price,
  message: "Compare-at price must be higher than the price",
  path: ["compareAtPrice"] as const,
};

export const productCreateSchema = productBase
  .extend({ sku: skuSchema }) // SKU for the initial default variant
  .refine(compareAtRule.check, { message: compareAtRule.message, path: ["compareAtPrice"] });

export const productUpdateSchema = productBase.refine(compareAtRule.check, {
  message: compareAtRule.message,
  path: ["compareAtPrice"],
});

// ---------------------------------------------------------------------------
// Category
// ---------------------------------------------------------------------------

export const categorySchema = z.object({
  name: nameSchema,
  slug: slugSchema,
  description: z.string().trim().max(2000).optional().or(z.literal("")),
  parentId: z.string().trim().optional().or(z.literal("")),
  heroColor: z
    .string()
    .trim()
    .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "Use a hex colour like #e7ece6")
    .optional()
    .or(z.literal("")),
  sortOrder: z.number().int().min(0).max(9999),
  featured: z.boolean(),
  active: z.boolean(),
});

// ---------------------------------------------------------------------------
// Variant / options
// ---------------------------------------------------------------------------

export const variantUpdateSchema = z.object({
  sku: skuSchema,
  price: priceSchema,
  compareAtPrice: priceSchema.nullable().optional(),
  status: z.enum(VARIANT_STATUSES),
}).refine((v) => v.compareAtPrice == null || v.compareAtPrice > v.price, {
  message: "Compare-at price must be higher than the price",
  path: ["compareAtPrice"],
});

/** One option type + its values, e.g. { name: "Colour", values: ["Oak","Walnut"] }. */
export const productOptionSchema = z.object({
  name: z.string().trim().min(1, "Option name is required").max(40),
  values: z
    .array(z.string().trim().min(1).max(60))
    .min(1, "Add at least one value")
    .max(24, "Too many values"),
});

export const productOptionsSchema = z
  .array(productOptionSchema)
  .max(3, "Up to 3 option types per product");

// ---------------------------------------------------------------------------
// Helpers for FormData parsing
// ---------------------------------------------------------------------------

/** Parse a centavos amount from a peso-string form field ("1,299.00" → 129900). */
export function pesosToCentavos(raw: FormDataEntryValue | null): number | null {
  if (raw == null) return null;
  const s = String(raw).replace(/[₱,\s]/g, "").trim();
  if (s === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

export function formBool(raw: FormDataEntryValue | null): boolean {
  return raw === "on" || raw === "true" || raw === "1";
}
