import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { cleanUserText } from "@/lib/ugc";
import {
  parseProposal,
  checkRequestDuplicates,
  type ProposedOption,
  type ProposedVariant,
  type DuplicateReport,
} from "@/lib/marketplace/seller-product-request-repository";

/**
 * Admin (cross-seller) Seller Product Request data layer — Phase 9F-5c.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The OPERATOR plane. Deliberately cross-seller: an Axiaro reviewer works every
 * seller's request from `/admin/seller-product-requests`. NOT seller-scoped and
 * must never be imported by `/seller` code.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Authorization + audit + email are the caller's job (`actions.ts`). Every
 * function here is a pure data mutation returning enough detail for the action
 * to write one `adminAuditLog` row and fire one notification.
 *
 * This module writes ONLY `SellerProductRequest` (status + review fields +
 * `resultProductId`). It NEVER writes `Product` / `Variant` / `Category` /
 * `ProductImage` / `ProductOption*` / `Offer` / `OfferInventory` / `Inventory` —
 * canonical creation lives in `create-canonical.ts`, image promotion in
 * `promote-image.ts`.
 */

type Client = Prisma.TransactionClient | typeof prisma;

export type AdminRequestError =
  | { ok: false; code: "NOT_FOUND"; error: string }
  | { ok: false; code: "VALIDATION"; error: string }
  | { ok: false; code: "CONFLICT"; error: string };

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type AdminRequestRow = {
  id: string;
  status: string;
  productName: string;
  sellerId: string;
  sellerName: string;
  categoryName: string | null;
  variantCount: number;
  imageCount: number;
  submittedAt: string | null;
  updatedAt: string;
};

export type AdminRequestListOptions = { status?: string; q?: string };

export async function listAdminProductRequests(
  opts: AdminRequestListOptions = {},
  client: Client = prisma,
): Promise<AdminRequestRow[]> {
  const where: Prisma.SellerProductRequestWhereInput = {};
  if (opts.status && opts.status !== "ALL") where.status = opts.status;
  if (opts.q?.trim()) {
    const q = opts.q.trim();
    where.OR = [
      { proposedName: { contains: q, mode: "insensitive" } },
      { seller: { displayName: { contains: q, mode: "insensitive" } } },
    ];
  }
  const rows = await client.sellerProductRequest.findMany({
    where,
    orderBy: [{ submittedAt: "asc" }, { updatedAt: "desc" }],
    select: {
      id: true,
      status: true,
      proposedName: true,
      proposedVariants: true,
      submittedAt: true,
      updatedAt: true,
      seller: { select: { id: true, displayName: true } },
      proposedCategory: { select: { name: true } },
      _count: { select: { images: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    productName: r.proposedName,
    sellerId: r.seller.id,
    sellerName: r.seller.displayName,
    categoryName: r.proposedCategory?.name ?? null,
    variantCount: parseProposal(r.proposedVariants).variants.length,
    imageCount: r._count.images,
    submittedAt: r.submittedAt?.toISOString() ?? null,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function adminRequestStatusCounts(client: Client = prisma): Promise<Record<string, number>> {
  const rows = await client.sellerProductRequest.groupBy({ by: ["status"], _count: { _all: true } });
  const out: Record<string, number> = { DRAFT: 0, PENDING: 0, APPROVED: 0, REJECTED: 0 };
  for (const r of rows) out[r.status] = r._count._all;
  return out;
}

export type AdminRequestDetail = {
  id: string;
  status: string;
  sellerId: string;
  sellerName: string;
  sellerSupportEmail: string;
  proposedName: string;
  proposedBrand: string | null;
  proposedShortDesc: string | null;
  proposedDescription: string | null;
  proposedCategoryId: string | null;
  categoryName: string | null;
  categoryNote: string | null;
  barcode: string | null;
  options: ProposedOption[];
  variants: ProposedVariant[];
  sellerNote: string | null;
  reviewNote: string | null;
  reviewedByEmail: string | null;
  reviewedAt: string | null;
  submittedAt: string | null;
  createdAt: string;
  updatedAt: string;
  resultProduct: { id: string; name: string; slug: string; status: string } | null;
  images: {
    id: string;
    role: string;
    sortOrder: number;
    mediaAssetId: string;
    url: string;
    filename: string;
    mimeType: string;
    sellerOwned: boolean;
    alreadyPromoted: boolean;
  }[];
  duplicates: DuplicateReport;
  audit: { at: string; action: string; summary: string | null; actorEmail: string | null }[];
};

export async function getAdminProductRequest(
  id: string,
  client: Client = prisma,
): Promise<AdminRequestDetail | null> {
  const r = await client.sellerProductRequest.findUnique({
    where: { id },
    select: {
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
      reviewedById: true,
      reviewedAt: true,
      submittedAt: true,
      createdAt: true,
      updatedAt: true,
      seller: { select: { id: true, displayName: true, supportEmail: true } },
      proposedCategory: { select: { name: true } },
      resultProduct: { select: { id: true, name: true, slug: true, status: true } },
      images: {
        orderBy: { sortOrder: "asc" },
        select: {
          id: true,
          role: true,
          sortOrder: true,
          mediaAssetId: true,
          mediaAsset: {
            select: {
              url: true,
              filename: true,
              mimeType: true,
              sellerId: true,
              productImages: { select: { id: true }, take: 1 },
            },
          },
        },
      },
    },
  });
  if (!r) return null;

  const { options, variants } = parseProposal(r.proposedVariants);

  const reviewer = r.reviewedById
    ? await client.user.findUnique({ where: { id: r.reviewedById }, select: { email: true } })
    : null;

  const duplicates = await checkRequestDuplicates(
    {
      proposedName: r.proposedName,
      proposedBrand: r.proposedBrand,
      proposedCategoryId: r.proposedCategoryId,
      barcode: r.barcode,
      proposedVariants: variants,
    },
    { excludeRequestId: r.id },
    client,
  );

  const audit = await client.adminAuditLog.findMany({
    where: { targetType: "seller_product_request", targetId: id },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { createdAt: true, action: true, summary: true, actor: { select: { email: true } } },
  });

  return {
    id: r.id,
    status: r.status,
    sellerId: r.seller.id,
    sellerName: r.seller.displayName,
    sellerSupportEmail: r.seller.supportEmail,
    proposedName: r.proposedName,
    proposedBrand: r.proposedBrand,
    proposedShortDesc: r.proposedShortDesc,
    proposedDescription: r.proposedDescription,
    proposedCategoryId: r.proposedCategoryId,
    categoryName: r.proposedCategory?.name ?? null,
    categoryNote: r.categoryNote,
    barcode: r.barcode,
    options,
    variants,
    sellerNote: r.sellerNote,
    reviewNote: r.reviewStatusNote,
    reviewedByEmail: reviewer?.email ?? null,
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
    submittedAt: r.submittedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    resultProduct: r.resultProduct
      ? { id: r.resultProduct.id, name: r.resultProduct.name, slug: r.resultProduct.slug, status: r.resultProduct.status }
      : null,
    images: r.images.map((i) => ({
      id: i.id,
      role: i.role,
      sortOrder: i.sortOrder,
      mediaAssetId: i.mediaAssetId,
      url: i.mediaAsset.url,
      filename: i.mediaAsset.filename,
      mimeType: i.mediaAsset.mimeType,
      sellerOwned: i.mediaAsset.sellerId === r.seller.id,
      alreadyPromoted: i.mediaAsset.productImages.length > 0,
    })),
    duplicates,
    audit: audit.map((a) => ({
      at: a.createdAt.toISOString(),
      action: a.action,
      summary: a.summary,
      actorEmail: a.actor?.email ?? null,
    })),
  };
}

/** Lightweight catalog search for the "link to existing product" step. */
export type CatalogMatch = {
  id: string;
  name: string;
  slug: string;
  status: string;
  categoryName: string | null;
  variantCount: number;
};

export async function searchCatalogForLink(
  q: string,
  client: Client = prisma,
): Promise<CatalogMatch[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  const rows = await client.product.findMany({
    where: {
      OR: [
        { name: { contains: term, mode: "insensitive" } },
        { slug: { contains: term, mode: "insensitive" } },
        { variants: { some: { sku: { contains: term, mode: "insensitive" } } } },
      ],
    },
    orderBy: { updatedAt: "desc" },
    take: 20,
    select: {
      id: true,
      name: true,
      slug: true,
      status: true,
      category: { select: { name: true } },
      _count: { select: { variants: true } },
    },
  });
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
    status: p.status,
    categoryName: p.category?.name ?? null,
    variantCount: p._count.variants,
  }));
}

// ---------------------------------------------------------------------------
// Writes — request status only (no catalog write)
// ---------------------------------------------------------------------------

export type ReviewResult =
  | { ok: true; sellerId: string; productName: string; reviewedAt: Date }
  | AdminRequestError;

/** PENDING → DRAFT with a required note. The seller can then revise + resubmit. */
export async function requestChanges(
  requestId: string,
  adminUserId: string,
  note: string,
  client: Client = prisma,
): Promise<ReviewResult> {
  const clean = cleanUserText(note);
  if (!clean) return { ok: false, code: "VALIDATION", error: "Add a note so the seller knows what to change." };
  return advanceFromPending(requestId, "DRAFT", adminUserId, clean, client);
}

/** PENDING → REJECTED (terminal) with a required note. */
export async function rejectRequest(
  requestId: string,
  adminUserId: string,
  note: string,
  client: Client = prisma,
): Promise<ReviewResult> {
  const clean = cleanUserText(note);
  if (!clean) return { ok: false, code: "VALIDATION", error: "Add a note explaining why." };
  return advanceFromPending(requestId, "REJECTED", adminUserId, clean, client);
}

async function advanceFromPending(
  requestId: string,
  to: "DRAFT" | "REJECTED",
  adminUserId: string,
  note: string,
  client: Client,
): Promise<ReviewResult> {
  const current = await client.sellerProductRequest.findUnique({
    where: { id: requestId },
    select: { status: true, proposedName: true, sellerId: true },
  });
  if (!current) return { ok: false, code: "NOT_FOUND", error: "That request no longer exists." };
  if (current.status !== "PENDING") {
    return { ok: false, code: "CONFLICT", error: `This request is ${current.status.toLowerCase()}, not awaiting review.` };
  }
  const reviewedAt = new Date();
  const advanced = await client.sellerProductRequest.updateMany({
    where: { id: requestId, status: "PENDING" },
    data: { status: to, reviewStatusNote: note, reviewedById: adminUserId, reviewedAt },
  });
  if (advanced.count === 0) {
    return { ok: false, code: "CONFLICT", error: "The request changed while you were reviewing it. Reload and try again." };
  }
  return { ok: true, sellerId: current.sellerId, productName: current.proposedName, reviewedAt };
}

export type LinkResult =
  | { ok: true; sellerId: string; productName: string; productId: string; productSlug: string; reviewedAt: Date }
  | AdminRequestError;

/**
 * PENDING → APPROVED, linking the request to an EXISTING canonical product.
 * Creates nothing. The seller can then list against that product's variants.
 */
export async function linkExistingProduct(
  requestId: string,
  productId: string,
  adminUserId: string,
  note: string | null,
  client: Client = prisma,
): Promise<LinkResult> {
  const product = await client.product.findUnique({
    where: { id: productId },
    select: { id: true, name: true, slug: true, status: true },
  });
  if (!product) return { ok: false, code: "NOT_FOUND", error: "That product no longer exists." };
  if (product.status === "ARCHIVED") {
    return { ok: false, code: "VALIDATION", error: "That product is archived — pick a live product or create a new one." };
  }

  const current = await client.sellerProductRequest.findUnique({
    where: { id: requestId },
    select: { status: true, proposedName: true, sellerId: true },
  });
  if (!current) return { ok: false, code: "NOT_FOUND", error: "That request no longer exists." };
  if (current.status !== "PENDING") {
    return { ok: false, code: "CONFLICT", error: `This request is ${current.status.toLowerCase()}, not awaiting review.` };
  }

  const reviewedAt = new Date();
  const advanced = await client.sellerProductRequest.updateMany({
    where: { id: requestId, status: "PENDING" },
    data: {
      status: "APPROVED",
      resultProductId: productId,
      reviewStatusNote: note ? cleanUserText(note) : null,
      reviewedById: adminUserId,
      reviewedAt,
    },
  });
  if (advanced.count === 0) {
    return { ok: false, code: "CONFLICT", error: "The request changed while you were reviewing it. Reload and try again." };
  }
  return {
    ok: true,
    sellerId: current.sellerId,
    productName: current.proposedName,
    productId: product.id,
    productSlug: product.slug,
    reviewedAt,
  };
}
