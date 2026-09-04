import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { cleanUserText } from "@/lib/ugc";
import { getSellerMedia } from "@/lib/marketplace/seller-media-repository";
import type { SellerContext } from "@/lib/marketplace/types";

/**
 * Seller-scoped Seller Product Request data access (Phase 9F-5b).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The ONLY sanctioned seller-plane access to `SellerProductRequest` /
 * `SellerProductRequestImage`. A request is a SUBMISSION RECORD — nothing here
 * writes `Product` / `Variant` / `Category` / `ProductImage` / `ProductOption*` /
 * `Offer` / `OfferInventory` / `Inventory`.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Isolation contract (same as every other seller-*-repository):
 *   - every function REQUIRES a `SellerContext` and scopes to `ctx.sellerId`;
 *   - writes are `where: { id, sellerId: ctx.sellerId }` — a forged / stale id
 *     fails the guard, not just the route;
 *   - image attach re-checks `MediaAsset.sellerId === ctx.sellerId` (via the
 *     seller media repo, which is itself seller-scoped);
 *   - there is NO unscoped getter.
 *
 * Status: DRAFT → PENDING → (9F-5c) APPROVED | REJECTED. The seller can only
 * ever move DRAFT → PENDING (submit); it can never set APPROVED / REJECTED, and
 * a PENDING / APPROVED / REJECTED request is read-only to the seller.
 */

type Client = Prisma.TransactionClient | typeof prisma;

export type SellerRequestError =
  | { ok: false; code: "NOT_FOUND"; error: string }
  | { ok: false; code: "VALIDATION"; error: string }
  | { ok: false; code: "LOCKED"; error: string }
  | { ok: false; code: "CONFLICT"; error: string }
  | { ok: false; code: "BLOCKED"; error: string; blocks: DuplicateBlock[] };

export const REQUEST_STATUSES = ["DRAFT", "PENDING", "APPROVED", "REJECTED"] as const;
export type SellerRequestStatus = (typeof REQUEST_STATUSES)[number];

export const SELLER_REQUEST_IMAGE_CAP = 8;
const MAX_VARIANTS = 12;
const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const BARCODE_RE = /^[0-9]{8,14}$/;

export type ProposedVariant = {
  label: string;
  proposedSku?: string | null;
  barcode?: string | null;
  attributes?: string | null;
};

export type SellerRequestInput = {
  proposedName: string;
  proposedBrand?: string | null;
  proposedShortDesc?: string | null;
  proposedDescription?: string | null;
  proposedCategoryId?: string | null;
  categoryNote?: string | null;
  barcode?: string | null;
  proposedVariants?: ProposedVariant[];
  sellerNote?: string | null;
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function validateInput(
  input: SellerRequestInput,
): { ok: true; data: Prisma.SellerProductRequestUncheckedCreateInput } | SellerRequestError {
  const name = cleanUserText(input.proposedName ?? "");
  if (name.length < 2 || name.length > 160) {
    return { ok: false, code: "VALIDATION", error: "Product name must be 2–160 characters." };
  }
  const brand = input.proposedBrand != null ? cleanUserText(input.proposedBrand) : null;
  if (brand && brand.length > 80) return { ok: false, code: "VALIDATION", error: "Brand is too long (max 80)." };
  const shortDesc = input.proposedShortDesc != null ? cleanUserText(input.proposedShortDesc) : null;
  if (shortDesc && shortDesc.length > 300) return { ok: false, code: "VALIDATION", error: "Short description is too long (max 300)." };
  const description = input.proposedDescription != null ? cleanUserText(input.proposedDescription) : null;
  if (description && description.length > 8000) return { ok: false, code: "VALIDATION", error: "Description is too long (max 8000)." };
  const categoryNote = input.categoryNote != null ? cleanUserText(input.categoryNote) : null;
  if (categoryNote && categoryNote.length > 500) return { ok: false, code: "VALIDATION", error: "Category note is too long (max 500)." };
  const sellerNote = input.sellerNote != null ? cleanUserText(input.sellerNote) : null;
  if (sellerNote && sellerNote.length > 2000) return { ok: false, code: "VALIDATION", error: "Note is too long (max 2000)." };

  const barcode = input.barcode != null && input.barcode.trim() !== "" ? input.barcode.trim() : null;
  if (barcode && !BARCODE_RE.test(barcode)) {
    return { ok: false, code: "VALIDATION", error: "Barcode must be 8–14 digits (GTIN / EAN / UPC)." };
  }

  const rawVariants = input.proposedVariants ?? [];
  if (rawVariants.length > MAX_VARIANTS) {
    return { ok: false, code: "VALIDATION", error: `Too many variants (max ${MAX_VARIANTS}).` };
  }
  const variants: ProposedVariant[] = [];
  for (const v of rawVariants) {
    const label = cleanUserText(v.label ?? "").slice(0, 60);
    if (!label) return { ok: false, code: "VALIDATION", error: "Every variant needs a label." };
    const sku = v.proposedSku != null && v.proposedSku.trim() !== "" ? v.proposedSku.trim() : null;
    if (sku && (sku.length > 64 || !SKU_RE.test(sku))) {
      return { ok: false, code: "VALIDATION", error: `Proposed SKU "${sku}" is not a valid SKU.` };
    }
    const vBarcode = v.barcode != null && v.barcode.trim() !== "" ? v.barcode.trim() : null;
    if (vBarcode && !BARCODE_RE.test(vBarcode)) {
      return { ok: false, code: "VALIDATION", error: `Variant barcode "${vBarcode}" must be 8–14 digits.` };
    }
    const attributes = v.attributes != null ? cleanUserText(v.attributes).slice(0, 200) || null : null;
    variants.push({ label, proposedSku: sku, barcode: vBarcode, attributes });
  }

  return {
    ok: true,
    data: {
      sellerId: "", // filled by the caller
      proposedName: name,
      proposedBrand: brand,
      proposedShortDesc: shortDesc,
      proposedDescription: description,
      proposedCategoryId: input.proposedCategoryId?.trim() || null,
      categoryNote,
      barcode,
      proposedVariants: variants.length ? (variants as unknown as Prisma.InputJsonValue) : undefined,
      sellerNote,
    },
  };
}

async function assertCategory(client: Client, categoryId: string | null): Promise<SellerRequestError | null> {
  if (!categoryId) return null;
  const c = await client.category.findFirst({ where: { id: categoryId, active: true }, select: { id: true } });
  if (!c) return { ok: false, code: "VALIDATION", error: "That category isn't available — leave it blank and add a note instead." };
  return null;
}

// ---------------------------------------------------------------------------
// Duplicate detection (9F-5 audit §I) — exact / normalized only, no fuzzy/ML
// ---------------------------------------------------------------------------

export type DuplicateBlock = {
  kind: "sku";
  sku: string;
  productName: string;
  productSlug: string;
  message: string;
};
export type DuplicateWarning = {
  kind: "barcode" | "name";
  message: string;
  productSlug?: string;
};
export type DuplicateReport = { blocks: DuplicateBlock[]; warnings: DuplicateWarning[] };

export async function checkRequestDuplicates(
  input: SellerRequestInput,
  opts: { excludeRequestId?: string } = {},
  client: Client = prisma,
): Promise<DuplicateReport> {
  const blocks: DuplicateBlock[] = [];
  const warnings: DuplicateWarning[] = [];

  // 1. exact SKU conflict with the canonical catalog → BLOCK
  const skus = [...new Set((input.proposedVariants ?? []).map((v) => v.proposedSku?.trim()).filter((s): s is string => Boolean(s)))];
  if (skus.length) {
    const hits = await client.variant.findMany({
      where: { sku: { in: skus } },
      select: { sku: true, product: { select: { name: true, slug: true } } },
    });
    for (const h of hits) {
      blocks.push({
        kind: "sku",
        sku: h.sku,
        productName: h.product.name,
        productSlug: h.product.slug,
        message: `SKU "${h.sku}" is already in the Axiaro catalog (${h.product.name}). List a listing against it instead of requesting a new product.`,
      });
    }
  }

  // 2. barcode match → WARNING (canonical barcode isn't stored; match other requests)
  const barcodes = [...new Set(
    [input.barcode, ...(input.proposedVariants ?? []).map((v) => v.barcode)]
      .map((b) => b?.trim())
      .filter((b): b is string => Boolean(b)),
  )];
  if (barcodes.length) {
    const reqHits = await client.sellerProductRequest.findMany({
      where: {
        barcode: { in: barcodes },
        status: { not: "REJECTED" },
        ...(opts.excludeRequestId ? { id: { not: opts.excludeRequestId } } : {}),
      },
      select: { proposedName: true, status: true },
      take: 5,
    });
    for (const r of reqHits) {
      warnings.push({ kind: "barcode", message: `That barcode is already on a ${r.status.toLowerCase()} request ("${r.proposedName}").` });
    }
  }

  // 3. normalized name + brand + category → WARNING
  const norm = normalizeName(input.proposedName ?? "");
  if (norm) {
    const brandLc = input.proposedBrand?.trim().toLowerCase() ?? null;
    const catFilter = input.proposedCategoryId?.trim() ? { categoryId: input.proposedCategoryId.trim() } : {};
    const products = await client.product.findMany({
      where: { ...catFilter },
      select: { name: true, slug: true, brand: true },
      take: 400,
    });
    for (const p of products) {
      if (normalizeName(p.name) === norm && (!brandLc || p.brand.toLowerCase() === brandLc)) {
        warnings.push({
          kind: "name",
          message: `A catalog product looks like a match: "${p.name}". You may be able to list against it instead.`,
          productSlug: p.slug,
        });
      }
    }
    const reqCatFilter = input.proposedCategoryId?.trim() ? { proposedCategoryId: input.proposedCategoryId.trim() } : {};
    const otherReqs = await client.sellerProductRequest.findMany({
      where: {
        status: { not: "REJECTED" },
        ...reqCatFilter,
        ...(opts.excludeRequestId ? { id: { not: opts.excludeRequestId } } : {}),
      },
      select: { proposedName: true, status: true },
      take: 200,
    });
    for (const r of otherReqs) {
      if (normalizeName(r.proposedName) === norm) {
        warnings.push({ kind: "name", message: `Another ${r.status.toLowerCase()} request has the same name ("${r.proposedName}").` });
      }
    }
  }

  return { blocks, warnings: warnings.slice(0, 8) };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const REQUEST_SELECT = {
  id: true,
  status: true,
  proposedName: true,
  proposedBrand: true,
  proposedShortDesc: true,
  proposedDescription: true,
  proposedCategoryId: true,
  categoryNote: true,
  barcode: true,
  proposedVariants: true,
  sellerNote: true,
  reviewStatusNote: true,
  reviewedAt: true,
  submittedAt: true,
  resultProductId: true,
  createdAt: true,
  updatedAt: true,
  proposedCategory: { select: { name: true } },
  resultProduct: { select: { name: true, slug: true } },
  images: {
    orderBy: { sortOrder: "asc" as const },
    select: {
      id: true,
      sortOrder: true,
      role: true,
      mediaAsset: { select: { id: true, url: true, filename: true, mimeType: true } },
    },
  },
} satisfies Prisma.SellerProductRequestSelect;

export type SellerRequestListOptions = { status?: SellerRequestStatus; q?: string; skip?: number; take?: number };

export async function listSellerRequests(
  ctx: SellerContext,
  opts: SellerRequestListOptions = {},
  client: Client = prisma,
) {
  const where: Prisma.SellerProductRequestWhereInput = { sellerId: ctx.sellerId };
  if (opts.status) where.status = opts.status;
  if (opts.q?.trim()) where.proposedName = { contains: opts.q.trim(), mode: "insensitive" };
  return client.sellerProductRequest.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    skip: opts.skip,
    take: opts.take,
    select: REQUEST_SELECT,
  });
}

export async function countSellerRequests(
  ctx: SellerContext,
  opts: Pick<SellerRequestListOptions, "status" | "q"> = {},
  client: Client = prisma,
): Promise<number> {
  const where: Prisma.SellerProductRequestWhereInput = { sellerId: ctx.sellerId };
  if (opts.status) where.status = opts.status;
  if (opts.q?.trim()) where.proposedName = { contains: opts.q.trim(), mode: "insensitive" };
  return client.sellerProductRequest.count({ where });
}

/** One request, only if it belongs to `ctx.sellerId`. `null` for missing AND another seller's. */
export async function getSellerRequestForSeller(ctx: SellerContext, requestId: string, client: Client = prisma) {
  return client.sellerProductRequest.findFirst({
    where: { id: requestId, sellerId: ctx.sellerId },
    select: REQUEST_SELECT,
  });
}

// ---------------------------------------------------------------------------
// Writes — always scoped to ctx.sellerId, DRAFT-only for edits
// ---------------------------------------------------------------------------

export type CreateRequestResult = { ok: true; requestId: string } | SellerRequestError;
export type MutateRequestResult = { ok: true } | SellerRequestError;
export type SubmitRequestResult = { ok: true; warnings: DuplicateWarning[] } | SellerRequestError;

export async function createSellerRequest(
  ctx: SellerContext,
  input: SellerRequestInput,
  externalTx?: Prisma.TransactionClient,
): Promise<CreateRequestResult> {
  const validated = validateInput(input);
  if (!validated.ok) return validated;

  const run = async (tx: Prisma.TransactionClient): Promise<CreateRequestResult> => {
    const badCat = await assertCategory(tx, validated.data.proposedCategoryId ?? null);
    if (badCat) return badCat;
    const created = await tx.sellerProductRequest.create({
      data: { ...validated.data, sellerId: ctx.sellerId, status: "DRAFT" },
      select: { id: true },
    });
    return { ok: true, requestId: created.id };
  };

  try {
    if (externalTx) return await run(externalTx);
    return await prisma.$transaction(run);
  } catch (err) {
    console.error("[seller-product-request-repository] createSellerRequest failed", err);
    return { ok: false, code: "VALIDATION", error: "Could not create the request." };
  }
}

export async function updateSellerRequest(
  ctx: SellerContext,
  requestId: string,
  input: SellerRequestInput,
  externalTx?: Prisma.TransactionClient,
): Promise<MutateRequestResult> {
  const validated = validateInput(input);
  if (!validated.ok) return validated;

  const run = async (tx: Prisma.TransactionClient): Promise<MutateRequestResult> => {
    const current = await tx.sellerProductRequest.findFirst({
      where: { id: requestId, sellerId: ctx.sellerId },
      select: { id: true, status: true },
    });
    if (!current) return { ok: false, code: "NOT_FOUND", error: "No such request for this seller." };
    if (current.status !== "DRAFT") {
      return { ok: false, code: "LOCKED", error: "Only a draft request can be edited." };
    }
    const badCat = await assertCategory(tx, validated.data.proposedCategoryId ?? null);
    if (badCat) return badCat;
    const { sellerId: _drop, ...data } = validated.data;
    void _drop;
    await tx.sellerProductRequest.update({
      where: { id: requestId },
      data: { ...data, proposedVariants: data.proposedVariants ?? Prisma.DbNull },
    });
    return { ok: true };
  };

  try {
    if (externalTx) return await run(externalTx);
    return await prisma.$transaction(run);
  } catch (err) {
    console.error("[seller-product-request-repository] updateSellerRequest failed", err);
    return { ok: false, code: "VALIDATION", error: "Could not save the request." };
  }
}

/**
 * DRAFT → PENDING. Runs duplicate detection first: an exact canonical-SKU
 * conflict BLOCKS the submission; name/barcode matches pass through as warnings
 * for the admin. Status-guarded so a concurrent edit can't be lost.
 */
export async function submitSellerRequest(
  ctx: SellerContext,
  requestId: string,
  externalTx?: Prisma.TransactionClient,
): Promise<SubmitRequestResult> {
  const run = async (tx: Prisma.TransactionClient): Promise<SubmitRequestResult> => {
    const current = await tx.sellerProductRequest.findFirst({
      where: { id: requestId, sellerId: ctx.sellerId },
      select: {
        id: true,
        status: true,
        proposedName: true,
        proposedBrand: true,
        proposedCategoryId: true,
        barcode: true,
        proposedVariants: true,
      },
    });
    if (!current) return { ok: false, code: "NOT_FOUND", error: "No such request for this seller." };
    if (current.status !== "DRAFT") {
      if (current.status === "PENDING") return { ok: true, warnings: [] };
      return { ok: false, code: "LOCKED", error: `A ${current.status.toLowerCase()} request can't be submitted.` };
    }

    const dup = await checkRequestDuplicates(
      {
        proposedName: current.proposedName,
        proposedBrand: current.proposedBrand,
        proposedCategoryId: current.proposedCategoryId,
        barcode: current.barcode,
        proposedVariants: (current.proposedVariants as unknown as ProposedVariant[]) ?? [],
      },
      { excludeRequestId: requestId },
      tx,
    );
    if (dup.blocks.length > 0) {
      return {
        ok: false,
        code: "BLOCKED",
        error: dup.blocks[0].message,
        blocks: dup.blocks,
      };
    }

    const advanced = await tx.sellerProductRequest.updateMany({
      where: { id: requestId, status: "DRAFT" },
      data: { status: "PENDING", submittedAt: new Date() },
    });
    if (advanced.count === 0) {
      return { ok: false, code: "CONFLICT", error: "The request changed while you were submitting it. Reload and try again." };
    }
    return { ok: true, warnings: dup.warnings };
  };

  try {
    if (externalTx) return await run(externalTx);
    return await prisma.$transaction(run);
  } catch (err) {
    console.error("[seller-product-request-repository] submitSellerRequest failed", err);
    return { ok: false, code: "VALIDATION", error: "Could not submit the request." };
  }
}

// ---------------------------------------------------------------------------
// Images — seller-owned MediaAsset only, DRAFT request only
// ---------------------------------------------------------------------------

export async function attachRequestImage(
  ctx: SellerContext,
  requestId: string,
  mediaAssetId: string,
  opts: { role?: string; sortOrder?: number } = {},
  externalTx?: Prisma.TransactionClient,
): Promise<MutateRequestResult> {
  const role = ["main", "gallery", "variant"].includes(opts.role ?? "") ? opts.role! : "gallery";

  const run = async (tx: Prisma.TransactionClient): Promise<MutateRequestResult> => {
    const req = await tx.sellerProductRequest.findFirst({
      where: { id: requestId, sellerId: ctx.sellerId },
      select: { id: true, status: true, _count: { select: { images: true } } },
    });
    if (!req) return { ok: false, code: "NOT_FOUND", error: "No such request for this seller." };
    if (req.status !== "DRAFT") return { ok: false, code: "LOCKED", error: "Only a draft request's images can be changed." };
    if (req._count.images >= SELLER_REQUEST_IMAGE_CAP) {
      return { ok: false, code: "VALIDATION", error: `A request can have at most ${SELLER_REQUEST_IMAGE_CAP} images.` };
    }

    // Ownership: the asset MUST belong to this seller (seller media repo is
    // itself seller-scoped, so this returns null for another seller's asset).
    const asset = await getSellerMedia(ctx, mediaAssetId, tx);
    if (!asset) return { ok: false, code: "NOT_FOUND", error: "That image isn't in your media library." };
    if (!asset.mimeType.startsWith("image/")) {
      return { ok: false, code: "VALIDATION", error: "Only image files can be attached to a request." };
    }

    const dupe = await tx.sellerProductRequestImage.findUnique({
      where: { requestId_mediaAssetId: { requestId, mediaAssetId } },
      select: { id: true },
    });
    if (dupe) return { ok: false, code: "CONFLICT", error: "That image is already attached." };

    await tx.sellerProductRequestImage.create({
      data: { requestId, mediaAssetId, role, sortOrder: opts.sortOrder ?? req._count.images },
    });
    await tx.sellerProductRequest.update({ where: { id: requestId }, data: { updatedAt: new Date() } });
    return { ok: true };
  };

  try {
    if (externalTx) return await run(externalTx);
    return await prisma.$transaction(run);
  } catch (err) {
    console.error("[seller-product-request-repository] attachRequestImage failed", err);
    return { ok: false, code: "VALIDATION", error: "Could not attach the image." };
  }
}

export async function detachRequestImage(
  ctx: SellerContext,
  requestId: string,
  imageId: string,
  externalTx?: Prisma.TransactionClient,
): Promise<MutateRequestResult> {
  const run = async (tx: Prisma.TransactionClient): Promise<MutateRequestResult> => {
    const req = await tx.sellerProductRequest.findFirst({
      where: { id: requestId, sellerId: ctx.sellerId },
      select: { id: true, status: true },
    });
    if (!req) return { ok: false, code: "NOT_FOUND", error: "No such request for this seller." };
    if (req.status !== "DRAFT") return { ok: false, code: "LOCKED", error: "Only a draft request's images can be changed." };

    const removed = await tx.sellerProductRequestImage.deleteMany({ where: { id: imageId, requestId } });
    if (removed.count === 0) return { ok: false, code: "NOT_FOUND", error: "That image isn't on this request." };
    await tx.sellerProductRequest.update({ where: { id: requestId }, data: { updatedAt: new Date() } });
    return { ok: true };
  };

  try {
    if (externalTx) return await run(externalTx);
    return await prisma.$transaction(run);
  } catch (err) {
    console.error("[seller-product-request-repository] detachRequestImage failed", err);
    return { ok: false, code: "VALIDATION", error: "Could not remove the image." };
  }
}
