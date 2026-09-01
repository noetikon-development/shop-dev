import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getStoreBrand } from "@/lib/site-settings";

/**
 * Admin read layer for Product Q&A moderation (Step 15). Uncached. Server-side
 * search / filter / pagination; `ProductQuestion.status` and `.productId` are
 * indexed.
 */

export const QUESTIONS_PAGE_SIZE = 20;

export const QA_STATUSES = ["PENDING", "APPROVED", "REJECTED", "ARCHIVED"] as const;
export type QAStatus = (typeof QA_STATUSES)[number];

export type AdminQuestionSort = "newest" | "oldest";

export type AdminQuestionFilters = {
  q?: string;
  status?: string;
  answered?: "yes" | "no";
  sort?: AdminQuestionSort;
  page?: number;
};

export type AdminQuestionRow = {
  id: string;
  productName: string;
  productSlug: string;
  customer: string;
  excerpt: string;
  status: QAStatus;
  answerCount: number;
  createdAt: string;
};

function excerpt(body: string, max = 160): string {
  const s = body.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export async function listAdminQuestions(filters: AdminQuestionFilters) {
  const page = Math.max(1, filters.page ?? 1);
  const sort = filters.sort ?? "newest";

  const where: Prisma.ProductQuestionWhereInput = {};
  if (filters.status && QA_STATUSES.includes(filters.status as QAStatus)) {
    where.status = filters.status;
  }
  if (filters.answered === "yes") where.answers = { some: {} };
  if (filters.answered === "no") where.answers = { none: {} };
  if (filters.q) {
    const q = filters.q.trim();
    if (q) {
      where.OR = [
        { body: { contains: q, mode: "insensitive" } },
        { product: { name: { contains: q, mode: "insensitive" } } },
        { user: { name: { contains: q, mode: "insensitive" } } },
        { user: { email: { contains: q, mode: "insensitive" } } },
      ];
    }
  }

  const [rows, total] = await Promise.all([
    prisma.productQuestion.findMany({
      where,
      orderBy: { createdAt: sort === "oldest" ? "asc" : "desc" },
      skip: (page - 1) * QUESTIONS_PAGE_SIZE,
      take: QUESTIONS_PAGE_SIZE,
      select: {
        id: true,
        body: true,
        status: true,
        createdAt: true,
        product: { select: { name: true, slug: true } },
        user: { select: { name: true, email: true } },
        _count: { select: { answers: true } },
      },
    }),
    prisma.productQuestion.count({ where }),
  ]);

  const mapped: AdminQuestionRow[] = rows.map((q) => ({
    id: q.id,
    productName: q.product.name,
    productSlug: q.product.slug,
    customer: q.user.name ?? q.user.email,
    excerpt: excerpt(q.body),
    status: q.status as QAStatus,
    answerCount: q._count.answers,
    createdAt: q.createdAt.toISOString(),
  }));

  return {
    rows: mapped,
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / QUESTIONS_PAGE_SIZE)),
  };
}

export async function getQuestionCounts(): Promise<Record<QAStatus | "ALL", number>> {
  const groups = await prisma.productQuestion.groupBy({ by: ["status"], _count: { _all: true } });
  const out = { ALL: 0, PENDING: 0, APPROVED: 0, REJECTED: 0, ARCHIVED: 0 } as Record<
    QAStatus | "ALL",
    number
  >;
  for (const g of groups) {
    const key = g.status as QAStatus;
    if (key in out) out[key] = g._count._all;
    out.ALL += g._count._all;
  }
  return out;
}

export type AdminQuestionDetail = Awaited<ReturnType<typeof getAdminQuestion>>;

export async function getAdminQuestion(id: string) {
  const q = await prisma.productQuestion.findUnique({
    where: { id },
    select: {
      id: true,
      body: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      product: { select: { id: true, name: true, slug: true } },
      user: { select: { name: true, email: true } },
      answers: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          body: true,
          authorType: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          author: { select: { name: true, email: true } },
        },
      },
    },
  });
  if (!q) return null;
  const brand = await getStoreBrand();
  return {
    id: q.id,
    body: q.body,
    status: q.status as QAStatus,
    createdAt: q.createdAt.toISOString(),
    updatedAt: q.updatedAt.toISOString(),
    product: q.product,
    customer: { name: q.user.name, email: q.user.email },
    answers: q.answers.map((a) => ({
      id: a.id,
      body: a.body,
      authorType: a.authorType,
      official: a.authorType === "STORE",
      status: a.status as QAStatus,
      author: a.author ? (a.author.name ?? a.author.email) : `${brand} Team`,
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
    })),
  };
}
