"use server";

import { revalidateTag, revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { QUESTION_LIMITS, checkLength } from "@/lib/ugc";

/**
 * Customer Q&A actions (Step 15). The author is always the authenticated user;
 * the client cannot ask "as" another customer, cannot set a status, and cannot
 * write an answer (only admins answer — see src/lib/admin/question-actions.ts).
 * New questions are PENDING and are not shown publicly until moderated.
 */

export type QAActionState = { ok?: boolean; error?: string; fieldErrors?: Record<string, string> };

const askSchema = z.object({
  productId: z.string().min(1).max(64),
  body: z.string().max(10000),
});

function revalidateQA(slug?: string) {
  revalidateTag("qa", "max");
  if (slug) revalidatePath(`/p/${slug}`);
}

export async function askQuestionAction(
  _prev: QAActionState,
  formData: FormData,
): Promise<QAActionState> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Please sign in to ask a question." };

  const parsed = askSchema.safeParse({
    productId: formData.get("productId"),
    body: formData.get("body"),
  });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const product = await prisma.product.findUnique({
    where: { id: parsed.data.productId },
    select: { id: true, slug: true },
  });
  if (!product) return { ok: false, error: "That product no longer exists." };

  const check = checkLength(parsed.data.body, {
    min: QUESTION_LIMITS.bodyMin,
    max: QUESTION_LIMITS.bodyMax,
    label: "Your question",
  });
  if (!check.ok) return { ok: false, fieldErrors: { body: check.error } };

  await prisma.productQuestion.create({
    data: {
      productId: product.id,
      userId: user.id,
      body: check.value,
      status: "PENDING",
    },
  });

  revalidateQA(product.slug);
  return { ok: true };
}

const editSchema = z.object({
  questionId: z.string().min(1).max(64),
  body: z.string().max(10000),
});

export async function editQuestionAction(
  _prev: QAActionState,
  formData: FormData,
): Promise<QAActionState> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Please sign in." };

  const parsed = editSchema.safeParse({
    questionId: formData.get("questionId"),
    body: formData.get("body"),
  });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const question = await prisma.productQuestion.findUnique({
    where: { id: parsed.data.questionId },
    select: { id: true, userId: true, status: true, product: { select: { slug: true } } },
  });
  if (!question || question.userId !== user.id) {
    return { ok: false, error: "That question wasn't found." };
  }
  // Only a not-yet-moderated question can be edited by the customer.
  if (question.status !== "PENDING") {
    return { ok: false, error: "This question has already been reviewed and can no longer be edited." };
  }

  const check = checkLength(parsed.data.body, {
    min: QUESTION_LIMITS.bodyMin,
    max: QUESTION_LIMITS.bodyMax,
    label: "Your question",
  });
  if (!check.ok) return { ok: false, fieldErrors: { body: check.error } };

  await prisma.productQuestion.update({
    where: { id: question.id },
    data: { body: check.value },
  });
  revalidateQA(question.product.slug);
  return { ok: true };
}

const deleteSchema = z.object({ questionId: z.string().min(1).max(64) });

export async function deleteQuestionAction(input: unknown): Promise<QAActionState> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Please sign in." };

  const parsed = deleteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const question = await prisma.productQuestion.findUnique({
    where: { id: parsed.data.questionId },
    select: { id: true, userId: true, product: { select: { slug: true } } },
  });
  if (!question || question.userId !== user.id) {
    return { ok: false, error: "That question wasn't found." };
  }

  // Customer removing their own question — answers cascade with it.
  await prisma.productQuestion.delete({ where: { id: question.id } });
  revalidateQA(question.product.slug);
  return { ok: true };
}
