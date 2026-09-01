import "server-only";
import { unstable_cache } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getStoreBrand } from "@/lib/site-settings";

/**
 * Product Q&A — read layer (Step 15).
 *
 * Public surfaces show APPROVED questions with their APPROVED answers only.
 * Official store answers are attributed to "<brand> Team" (brand from
 * `store.brand`); a customer answer is shown by first name. The internal user
 * id / email is never exposed.
 */

function firstName(name: string | null, brand: string): string {
  const t = (name ?? "").trim();
  return t ? t.split(/\s+/)[0] : `${brand} customer`;
}

export type PublicAnswer = {
  id: string;
  body: string;
  author: string;
  official: boolean;
  createdAt: string;
};

export type PublicQuestion = {
  id: string;
  body: string;
  author: string;
  createdAt: string;
  answers: PublicAnswer[];
};

export const getPublicQA = unstable_cache(
  async (productId: string): Promise<PublicQuestion[]> => {
    const brand = await getStoreBrand();
    const rows = await prisma.productQuestion.findMany({
      where: { productId, status: "APPROVED" },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        body: true,
        createdAt: true,
        user: { select: { name: true } },
        answers: {
          where: { status: "APPROVED" },
          orderBy: [{ authorType: "asc" }, { createdAt: "asc" }],
          select: {
            id: true,
            body: true,
            authorType: true,
            createdAt: true,
            author: { select: { name: true } },
          },
        },
      },
    });
    return rows.map((q) => ({
      id: q.id,
      body: q.body,
      author: firstName(q.user.name, brand),
      createdAt: q.createdAt.toISOString(),
      answers: q.answers.map((a) => ({
        id: a.id,
        body: a.body,
        official: a.authorType === "STORE",
        author: a.authorType === "STORE" ? `${brand} Team` : firstName(a.author?.name ?? null, brand),
        createdAt: a.createdAt.toISOString(),
      })),
    }));
  },
  ["product-qa"],
  { revalidate: 300, tags: ["qa"] },
);

export type MyQuestion = {
  id: string;
  body: string;
  status: string;
  createdAt: string;
  answers: { id: string; body: string; official: boolean; status: string }[];
};

/** The signed-in customer's own questions for a product — any status. */
export async function getMyQuestions(userId: string, productId: string): Promise<MyQuestion[]> {
  const rows = await prisma.productQuestion.findMany({
    where: { userId, productId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      body: true,
      status: true,
      createdAt: true,
      answers: {
        where: { status: "APPROVED" },
        orderBy: { createdAt: "asc" },
        select: { id: true, body: true, authorType: true, status: true },
      },
    },
  });
  return rows.map((q) => ({
    id: q.id,
    body: q.body,
    status: q.status,
    createdAt: q.createdAt.toISOString(),
    answers: q.answers.map((a) => ({
      id: a.id,
      body: a.body,
      official: a.authorType === "STORE",
      status: a.status,
    })),
  }));
}
