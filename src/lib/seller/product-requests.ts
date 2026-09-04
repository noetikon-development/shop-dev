import "server-only";
import { prisma } from "@/lib/prisma";
import {
  listSellerRequests,
  countSellerRequests,
  getSellerRequestForSeller,
  checkRequestDuplicates,
  parseProposal,
  type SellerRequestStatus,
  type ProposedVariant,
  type ProposedOption,
  type DuplicateReport,
} from "@/lib/marketplace/seller-product-request-repository";
import type { SellerContext } from "@/lib/marketplace/types";

/**
 * Read models for `/seller/product-requests`. Every function takes the
 * established `SellerContext` and delegates to the seller-scoped repository —
 * there is no unscoped query here.
 */

const PAGE_SIZE = 20;

type Row = Awaited<ReturnType<typeof listSellerRequests>>[number];

export type SellerRequestRow = {
  id: string;
  status: string;
  name: string;
  categoryName: string | null;
  variantCount: number;
  imageCount: number;
  submittedAt: string | null;
  updatedAt: string;
};

function toRow(r: Row): SellerRequestRow {
  return {
    id: r.id,
    status: r.status,
    name: r.proposedName,
    categoryName: r.proposedCategory?.name ?? null,
    variantCount: parseProposal(r.proposedVariants).variants.length,
    imageCount: r.images.length,
    submittedAt: r.submittedAt?.toISOString() ?? null,
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function listSellerRequestsPage(
  ctx: SellerContext,
  opts: { status?: string; q?: string; page?: number } = {},
) {
  const page = Math.max(1, opts.page ?? 1);
  const status = opts.status && opts.status !== "ALL" ? (opts.status as SellerRequestStatus) : undefined;
  const [rows, total] = await Promise.all([
    listSellerRequests(ctx, { status, q: opts.q, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
    countSellerRequests(ctx, { status, q: opts.q }),
  ]);
  return {
    rows: rows.map(toRow),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}

export async function countOpenSellerRequests(ctx: SellerContext): Promise<number> {
  return countSellerRequests(ctx, { status: "PENDING" });
}

export type SellerRequestDetailView = {
  id: string;
  status: string;
  editable: boolean;
  name: string;
  brand: string | null;
  shortDesc: string | null;
  description: string | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryNote: string | null;
  barcode: string | null;
  options: ProposedOption[];
  variants: ProposedVariant[];
  sellerNote: string | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  submittedAt: string | null;
  resultProduct: { name: string; slug: string; listUrl: string } | null;
  images: { id: string; url: string; filename: string; role: string; sortOrder: number }[];
  createdAt: string;
  updatedAt: string;
  /** duplicate advisory — only computed for a DRAFT request */
  duplicates: DuplicateReport | null;
};

export async function getSellerRequestDetail(
  ctx: SellerContext,
  requestId: string,
): Promise<SellerRequestDetailView | null> {
  const r = await getSellerRequestForSeller(ctx, requestId);
  if (!r) return null;

  const { options, variants } = parseProposal(r.proposedVariants);
  const editable = r.status === "DRAFT";

  const duplicates = editable
    ? await checkRequestDuplicates(
        {
          proposedName: r.proposedName,
          proposedBrand: r.proposedBrand,
          proposedCategoryId: r.proposedCategoryId,
          barcode: r.barcode,
          proposedVariants: variants,
        },
        { excludeRequestId: r.id },
      )
    : null;

  // Post-approval "Create listing" deep-link (9F-5c Part 8). When the canonical
  // product has exactly one ACTIVE variant, preselect it; otherwise send the
  // seller to the catalog picker pre-filtered by the product name. This NEVER
  // creates an Offer — the seller still owns price / condition / stock.
  let resultProduct: SellerRequestDetailView["resultProduct"] = null;
  if (r.resultProductId && r.resultProduct) {
    const activeVariants = await prisma.variant.findMany({
      where: { productId: r.resultProductId, status: "ACTIVE" },
      select: { id: true },
      take: 2,
    });
    const listUrl =
      activeVariants.length === 1
        ? `/seller/offers/new?variantId=${activeVariants[0].id}`
        : `/seller/offers/new?q=${encodeURIComponent(r.resultProduct.name)}`;
    resultProduct = { name: r.resultProduct.name, slug: r.resultProduct.slug, listUrl };
  }

  return {
    id: r.id,
    status: r.status,
    editable,
    name: r.proposedName,
    brand: r.proposedBrand,
    shortDesc: r.proposedShortDesc,
    description: r.proposedDescription,
    categoryId: r.proposedCategoryId,
    categoryName: r.proposedCategory?.name ?? null,
    categoryNote: r.categoryNote,
    barcode: r.barcode,
    options,
    variants,
    sellerNote: r.sellerNote,
    reviewNote: r.reviewStatusNote,
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
    submittedAt: r.submittedAt?.toISOString() ?? null,
    resultProduct,
    images: r.images.map((i) => ({
      id: i.id,
      url: i.mediaAsset.url,
      filename: i.mediaAsset.filename,
      role: i.role,
      sortOrder: i.sortOrder,
    })),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    duplicates,
  };
}

/** Active categories for the request form's category picker (public catalog data). */
export async function listRequestCategoryOptions(): Promise<{ id: string; name: string; parentName: string | null }[]> {
  const cats = await prisma.category.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: { id: true, name: true, parent: { select: { name: true } } },
  });
  return cats.map((c) => ({ id: c.id, name: c.name, parentName: c.parent?.name ?? null }));
}
