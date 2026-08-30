import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { REVIEW_STATUSES, type ReviewStatus } from "@/lib/reviews";

/**
 * Admin read layer for review moderation (Step 15). Uncached — moderators see
 * live data. Server-side search / filter / pagination; indexes on
 * `Review.status` and `Review.productId` back the common queries.
 */

export const REVIEWS_PAGE_SIZE = 20;

export type AdminReviewSort = "newest" | "oldest" | "rating_high" | "rating_low";

export type AdminReviewFilters = {
  q?: string;
  status?: string;
  rating?: number;
  verified?: "yes" | "no";
  sort?: AdminReviewSort;
  page?: number;
};

export type AdminReviewRow = {
  id: string;
  productId: string;
  productName: string;
  productSlug: string;
  customer: string;
  rating: number;
  title: string | null;
  excerpt: string;
  verified: boolean;
  status: ReviewStatus;
  createdAt: string;
};

const SORT_ORDER: Record<AdminReviewSort, Prisma.ReviewOrderByWithRelationInput[]> = {
  newest: [{ createdAt: "desc" }],
  oldest: [{ createdAt: "asc" }],
  rating_high: [{ rating: "desc" }, { createdAt: "desc" }],
  rating_low: [{ rating: "asc" }, { createdAt: "desc" }],
};

function excerpt(body: string, max = 140): string {
  const s = body.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export async function listAdminReviews(filters: AdminReviewFilters) {
  const page = Math.max(1, filters.page ?? 1);
  const sort = filters.sort ?? "newest";

  const where: Prisma.ReviewWhereInput = {};
  const and: Prisma.ReviewWhereInput[] = [];

  if (filters.status && REVIEW_STATUSES.includes(filters.status as ReviewStatus)) {
    where.status = filters.status;
  }
  if (filters.rating && filters.rating >= 1 && filters.rating <= 5) {
    where.rating = filters.rating;
  }
  if (filters.verified === "yes") where.verified = true;
  if (filters.verified === "no") where.verified = false;

  if (filters.q) {
    const q = filters.q.trim();
    if (q) {
      and.push({
        OR: [
          { title: { contains: q, mode: "insensitive" } },
          { body: { contains: q, mode: "insensitive" } },
          { product: { name: { contains: q, mode: "insensitive" } } },
          { user: { name: { contains: q, mode: "insensitive" } } },
          { user: { email: { contains: q, mode: "insensitive" } } },
        ],
      });
    }
  }
  if (and.length) where.AND = and;

  const [rows, total] = await Promise.all([
    prisma.review.findMany({
      where,
      orderBy: SORT_ORDER[sort],
      skip: (page - 1) * REVIEWS_PAGE_SIZE,
      take: REVIEWS_PAGE_SIZE,
      select: {
        id: true,
        productId: true,
        rating: true,
        title: true,
        body: true,
        verified: true,
        status: true,
        createdAt: true,
        product: { select: { name: true, slug: true } },
        user: { select: { name: true, email: true } },
      },
    }),
    prisma.review.count({ where }),
  ]);

  const mapped: AdminReviewRow[] = rows.map((r) => ({
    id: r.id,
    productId: r.productId,
    productName: r.product.name,
    productSlug: r.product.slug,
    customer: r.user.name ?? r.user.email,
    rating: r.rating,
    title: r.title,
    excerpt: excerpt(r.body),
    verified: r.verified,
    status: r.status as ReviewStatus,
    createdAt: r.createdAt.toISOString(),
  }));

  return {
    rows: mapped,
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / REVIEWS_PAGE_SIZE)),
  };
}

export async function getReviewCounts(): Promise<Record<ReviewStatus | "ALL", number>> {
  const groups = await prisma.review.groupBy({ by: ["status"], _count: { _all: true } });
  const out = { ALL: 0, PENDING: 0, APPROVED: 0, REJECTED: 0, ARCHIVED: 0 } as Record<
    ReviewStatus | "ALL",
    number
  >;
  for (const g of groups) {
    const key = g.status as ReviewStatus;
    if (key in out) out[key] = g._count._all;
    out.ALL += g._count._all;
  }
  return out;
}

export type AdminReviewDetail = Awaited<ReturnType<typeof getAdminReview>>;

export async function getAdminReview(id: string) {
  const r = await prisma.review.findUnique({
    where: { id },
    select: {
      id: true,
      rating: true,
      title: true,
      body: true,
      verified: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      product: { select: { id: true, name: true, slug: true, status: true } },
      user: { select: { id: true, name: true, email: true } },
      order: { select: { orderNumber: true, status: true, placedAt: true } },
    },
  });
  if (!r) return null;
  return {
    id: r.id,
    rating: r.rating,
    title: r.title,
    body: r.body,
    verified: r.verified,
    status: r.status as ReviewStatus,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    product: r.product,
    customer: { name: r.user.name, email: r.user.email },
    order: r.order
      ? {
          orderNumber: r.order.orderNumber,
          status: r.order.status,
          placedAt: r.order.placedAt.toISOString(),
        }
      : null,
  };
}
