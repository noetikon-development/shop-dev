import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { cleanUserText } from "@/lib/ugc";
import { productCreateSchema, productOptionsSchema } from "@/lib/admin/catalog-schemas";
import { generateProductSlug, generateVariantSku } from "@/lib/admin/catalog";
import { ensureFirstPartyOffer } from "@/lib/admin/offer-sync";
import { regenerateVariants } from "@/lib/admin/variants";
import { createSellerOffer } from "@/lib/marketplace/seller-repository";
import { isOfferCondition, type OfferCondition } from "@/lib/marketplace/conditions";
import type { SellerContext } from "@/lib/marketplace/types";

/**
 * Phase 9F-5c Part 4 — create a canonical Product from a PENDING
 * SellerProductRequest, then link the request to it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The seller's proposed values are ADVISORY. Everything here comes from the
 * admin-curated `curated` payload — name, brand, descriptions, category,
 * options, values, SKU, status are all the reviewer's final call.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Side effects — IDENTICAL to the existing Axiaro product-creation flow
 * (`createProduct` + `saveProductOptions` in src/lib/admin/catalog-actions.ts),
 * which 9E-3D did not touch:
 *   - Product                     — 1 row, ALWAYS status DRAFT (9F-24D P1-2 —
 *                                   a product born from a seller proposal is
 *                                   never auto-published; Axiaro activates it
 *                                   explicitly later, which is also what keeps
 *                                   the Axiaro FIRST_PARTY offer out of ACTIVE)
 *   - Variant                     — the default variant, then the option cartesian
 *   - Inventory                   — 1 birth-record row per variant, quantity 0
 *                                   (never an InventoryAdjustment)
 *   - Offer (FIRST_PARTY, NEW)    — 1 per variant, DRAFT (product is DRAFT)
 *   - OfferInventory              — 1 per variant, quantity 0
 *   - OfferAdjustment             — 1 MIGRATION_OPENING per variant, delta 0
 *   - SellerProductRequest        — status PENDING → APPROVED, resultProductId set
 * NO InventoryAdjustment, no Variant.stock mutation of an existing row, no
 * OfferAdjustment other than the opening balance. OfferInventory stays the
 * operational authority. Compatible with the 9E-3D-7 freeze (the observation
 * monitor's Inventory-mutation heuristic surfaces the birth-record row as an
 * advisory line — it is a creation, not a rewrite of a frozen quantity).
 *
 * 9F-24D (P1-1): the proposing seller's own THIRD_PARTY draft listings are
 * seeded separately by `seedSellerDraftOffers` (called from `actions.ts` after
 * this returns), so an approval leaves the seller with editable DRAFT offers to
 * price and stock — not an empty "create listing" form.
 */

export type CuratedProduct = {
  name: string;
  slug?: string;
  brand: string;
  shortDescription: string;
  description: string;
  categoryId: string;
  price: number;
  compareAtPrice?: number | null;
  weightGrams?: number;
  featured?: boolean;
  freeShipping?: boolean;
  sku?: string;
  options: { name: string; values: string[] }[];
  reviewNote?: string | null;
};

export type CreateFromRequestResult =
  | {
      ok: true;
      productId: string;
      productSlug: string;
      hasOptions: boolean;
      /** true when the option cartesian was NOT expanded (test path, externalTx) */
      variantGenDeferred: boolean;
      sellerId: string;
      productName: string;
      reviewedAt: Date;
      /** 9F-36B — the seller's proposed condition, carried through for offer seeding. */
      proposedCondition: string | null;
    }
  | { ok: false; code: "NOT_FOUND" | "CONFLICT" | "VALIDATION"; error: string; fieldErrors?: Record<string, string> };

/**
 * `externalTx` — pass a transaction client to run the claim + create inside it
 * and SKIP `regenerateVariants` (the option cartesian). Used by the test harness
 * so the whole thing rolls back; production callers omit it.
 */
export async function approveByCreatingProduct(
  requestId: string,
  adminUserId: string,
  curated: CuratedProduct,
  externalTx?: Prisma.TransactionClient,
): Promise<CreateFromRequestResult> {
  const db: Prisma.TransactionClient | typeof prisma = externalTx ?? prisma;
  // ── validate the curated payload (same rules as /admin/products/new) ──────
  const slugProvided = Boolean(curated.slug?.trim());
  const slug = slugProvided ? curated.slug!.trim().toLowerCase() : await generateProductSlug(curated.name || "product");
  const sku = curated.sku?.trim() || (await generateVariantSku(slug));

  const parsed = productCreateSchema.safeParse({
    name: curated.name,
    slug,
    shortDescription: curated.shortDescription,
    description: curated.description,
    categoryId: curated.categoryId,
    // 9F-24D P1-2 — always DRAFT. A product created from a seller proposal is
    // never born customer-visible; this is also what keeps its Axiaro
    // FIRST_PARTY offer out of ACTIVE (ensureFirstPartyOffer mirrors the
    // product status).
    status: "DRAFT",
    featured: curated.featured ?? false,
    freeShipping: curated.freeShipping ?? false,
    price: curated.price,
    compareAtPrice: curated.compareAtPrice ?? null,
    weightGrams: curated.weightGrams ?? 500,
    sku,
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const i of parsed.error.issues) {
      const k = i.path[0] != null ? String(i.path[0]) : "_";
      if (!fieldErrors[k]) fieldErrors[k] = i.message;
    }
    return { ok: false, code: "VALIDATION", error: "Fix the highlighted fields.", fieldErrors };
  }
  const data = parsed.data;

  const options = productOptionsSchema.safeParse(
    curated.options
      .map((o) => ({
        name: cleanUserText(o.name ?? "").trim(),
        values: [...new Set((o.values ?? []).map((v) => cleanUserText(String(v)).trim()).filter(Boolean))],
      }))
      .filter((o) => o.name && o.values.length),
  );
  if (!options.success) {
    return { ok: false, code: "VALIDATION", error: options.error.issues[0]?.message ?? "Invalid options." };
  }
  const optionDefs = options.data;
  if (new Set(optionDefs.map((o) => o.name.toLowerCase())).size !== optionDefs.length) {
    return { ok: false, code: "VALIDATION", error: "Each option type must have a unique name." };
  }

  const category = await db.category.findUnique({ where: { id: data.categoryId }, select: { id: true } });
  if (!category) return { ok: false, code: "VALIDATION", error: "That category no longer exists.", fieldErrors: { categoryId: "Choose a valid category" } };

  if (slugProvided) {
    const clash = await db.product.findUnique({ where: { slug: data.slug }, select: { id: true } });
    if (clash) return { ok: false, code: "CONFLICT", error: "That slug is already in use.", fieldErrors: { slug: "Already in use" } };
  }
  const skuClash = await db.variant.findUnique({ where: { sku: data.sku }, select: { id: true } });
  if (skuClash) {
    return { ok: false, code: "CONFLICT", error: "That SKU is already in use.", fieldErrors: { sku: "Already in use" } };
  }

  // ── claim + create, atomically ───────────────────────────────────────────
  let outcome:
    | {
        productId: string;
        productSlug: string;
        hasOptions: boolean;
        sellerId: string;
        productName: string;
        reviewedAt: Date;
        proposedCondition: string | null;
      }
    | { conflict: true }
    | { notFound: true };
  const claimAndCreate = async (tx: Prisma.TransactionClient) => {
      const req = await tx.sellerProductRequest.findUnique({
        where: { id: requestId },
        select: { status: true, sellerId: true, proposedName: true, proposedCondition: true },
      });
      if (!req) return { notFound: true as const };
      if (req.status !== "PENDING") return { conflict: true as const };

      const reviewedAt = new Date();
      const claimed = await tx.sellerProductRequest.updateMany({
        where: { id: requestId, status: "PENDING" },
        data: {
          status: "APPROVED",
          reviewStatusNote: curated.reviewNote ? cleanUserText(curated.reviewNote) : null,
          reviewedById: adminUserId,
          reviewedAt,
        },
      });
      if (claimed.count === 0) return { conflict: true as const };

      const product = await tx.product.create({
        data: {
          name: data.name,
          slug: data.slug,
          shortDescription: data.shortDescription,
          description: data.description,
          categoryId: data.categoryId,
          status: data.status,
          featured: data.featured,
          freeShipping: data.freeShipping,
          price: data.price,
          compareAtPrice: data.compareAtPrice ?? null,
          weightGrams: data.weightGrams ?? 500,
        },
        select: { id: true, slug: true, status: true, costPrice: true },
      });

      const variant = await tx.variant.create({
        data: {
          productId: product.id,
          sku: data.sku,
          price: data.price,
          compareAtPrice: data.compareAtPrice ?? null,
          status: "ACTIVE",
          stock: 0,
        },
        select: { id: true },
      });
      await tx.inventory.create({
        data: { variantId: variant.id, sku: data.sku, quantity: 0, reserved: 0, reorderPoint: 3 },
      });
      await ensureFirstPartyOffer(
        { id: variant.id, sku: data.sku, price: data.price, compareAtPrice: data.compareAtPrice ?? null },
        { productStatus: product.status, costPrice: product.costPrice },
        tx,
      );

      for (let i = 0; i < optionDefs.length; i++) {
        const def = optionDefs[i];
        const opt = await tx.productOption.create({
          data: { productId: product.id, name: def.name, sortOrder: i },
          select: { id: true },
        });
        for (let j = 0; j < def.values.length; j++) {
          const value = def.values[j];
          await tx.productOptionValue.create({
            data: {
              optionId: opt.id,
              value,
              sortOrder: j,
              // 9F-37B: swatchHex is stored NULL; the storefront resolves the
              // colour through the shared palette (`@/lib/marketplace/colours`)
              // at display time. An explicit override would still win.
              swatchHex: null,
            },
          });
        }
      }

      await tx.sellerProductRequest.update({ where: { id: requestId }, data: { resultProductId: product.id } });

      return {
        productId: product.id,
        productSlug: product.slug,
        hasOptions: optionDefs.length > 0,
        sellerId: req.sellerId,
        productName: req.proposedName,
        reviewedAt,
        proposedCondition: req.proposedCondition,
      };
  };

  try {
    outcome = externalTx ? await claimAndCreate(externalTx) : await prisma.$transaction(claimAndCreate);
  } catch (err) {
    console.error("[approveByCreatingProduct]", err);
    return { ok: false, code: "VALIDATION", error: "Could not create the product. Nothing was changed." };
  }

  if ("notFound" in outcome) return { ok: false, code: "NOT_FOUND", error: "That request no longer exists." };
  if ("conflict" in outcome) {
    return { ok: false, code: "CONFLICT", error: "This request is no longer pending — it may have been processed already." };
  }

  // Build the option cartesian OUTSIDE the transaction (mirrors saveProductOptions):
  // the product + its default variant + FIRST_PARTY offer already exist and the
  // request is linked, so a failure here leaves a real, editable product.
  // Skipped under an externalTx (test path) — regenerateVariants is not tx-aware.
  let variantGenDeferred = true;
  if (outcome.hasOptions && !externalTx) {
    variantGenDeferred = false;
    try {
      await regenerateVariants(outcome.productId);
    } catch (err) {
      console.error("[approveByCreatingProduct] regenerateVariants", err);
    }
  }

  return { ok: true, variantGenDeferred, ...outcome };
}

// ---------------------------------------------------------------------------
// 9F-24D (P1-1) — seed the proposing seller's own draft listings
// ---------------------------------------------------------------------------

type SeedClient = Prisma.TransactionClient | typeof prisma;

export type SeedSellerDraftOffersResult = {
  /** Offer ids created for the seller (DRAFT, THIRD_PARTY). */
  created: string[];
  /** Variants where the seller already had an offer for this condition. */
  skipped: number;
  /** The condition the offers were seeded with (9F-36B). */
  condition: OfferCondition;
};

/**
 * After a request is APPROVED (new product created, or linked to an existing
 * one), give the proposing seller a `DRAFT` THIRD_PARTY offer for every ACTIVE
 * variant of the result product — pre-filled from the catalog price, zero
 * opening stock. The seller then only has to set their price and stock, instead
 * of hunting for the product in an empty "create listing" form.
 *
 * 9F-36B — the offers are seeded with the seller's proposed condition
 * (`request.proposedCondition`), falling back to `"NEW"` for a legacy request
 * that never carried one. The Axiaro FIRST_PARTY offer stays NEW (that is
 * `ensureFirstPartyOffer`'s job, not this function's).
 *
 * Reuses `createSellerOffer` (the sanctioned seller-plane path) with a synthetic
 * `SellerContext` for the proposing seller — it does its own dedupe on
 * `(sellerId, variantId, condition)`, so calling this twice (or after the seller
 * already listed that variant/condition) is safe. Best-effort: a per-variant
 * failure is logged and skipped, never thrown.
 *
 * Pass a transaction client for tests (each `createSellerOffer` then runs inside
 * it); production callers omit it and each offer gets its own transaction.
 */
export async function seedSellerDraftOffers(
  sellerId: string,
  actorUserId: string,
  productId: string,
  conditionInput?: string | null,
  client: SeedClient = prisma,
): Promise<SeedSellerDraftOffersResult> {
  // Legacy / unset proposed condition → NEW (preserves pre-9F-36B behaviour).
  const condition: OfferCondition = isOfferCondition(conditionInput) ? conditionInput : "NEW";
  const txArg = client === prisma ? undefined : (client as Prisma.TransactionClient);
  const ctx: SellerContext = {
    sellerId,
    sellerName: "",
    sellerUserId: actorUserId,
    userId: actorUserId,
    role: "OWNER",
    permissions: new Set<string>(),
  };

  const variants = await client.variant.findMany({
    where: { productId, status: "ACTIVE" },
    select: { id: true, price: true },
  });

  const created: string[] = [];
  let skipped = 0;
  for (const v of variants) {
    if (!Number.isInteger(v.price) || v.price <= 0) continue;
    const res = await createSellerOffer(
      ctx,
      { variantId: v.id, price: v.price, condition, openingQuantity: 0, reorderPoint: 3 },
      txArg,
    );
    if (res.ok) created.push(res.offerId);
    else if (res.code === "CONFLICT") skipped += 1;
    else console.error("[seedSellerDraftOffers] createSellerOffer failed", v.id, res.error);
  }
  return { created, skipped, condition };
}
