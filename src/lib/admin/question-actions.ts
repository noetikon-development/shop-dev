"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/admin/rbac";
import { writeAudit } from "@/lib/admin/audit";
import { ANSWER_LIMITS, checkLength } from "@/lib/ugc";

/**
 * Q&A moderation actions (Step 15). All require `manage_reviews`. Official
 * answers are written under the authenticated admin's identity and attributed to
 * "AXIARO Team" (authorType STORE) — the browser cannot fabricate the author.
 * Every mutation is audited.
 */

export type QAModerationState = { ok?: boolean; error?: string; fieldErrors?: Record<string, string> };

const STATUS_TARGETS = ["APPROVED", "REJECTED", "ARCHIVED", "PENDING"] as const;

function revalidateQuestion(questionId: string, slug: string) {
  revalidateTag("qa", "max");
  revalidatePath("/admin/reviews/questions");
  revalidatePath(`/admin/reviews/questions/${questionId}`);
  revalidatePath(`/p/${slug}`);
}

const setQuestionSchema = z.object({
  id: z.string().min(1).max(64),
  status: z.enum(STATUS_TARGETS),
});

const QUESTION_AUDIT: Record<(typeof STATUS_TARGETS)[number], string> = {
  APPROVED: "question.approved",
  REJECTED: "question.rejected",
  ARCHIVED: "question.archived",
  PENDING: "question.reopened",
};

export async function setQuestionStatusAction(input: unknown): Promise<QAModerationState> {
  const admin = await requirePermission("manage_reviews");
  const parsed = setQuestionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const question = await prisma.productQuestion.findUnique({
    where: { id: parsed.data.id },
    select: { id: true, status: true, product: { select: { name: true, slug: true } } },
  });
  if (!question) return { ok: false, error: "That question wasn't found." };
  if (question.status === parsed.data.status) return { ok: true };

  await prisma.productQuestion.update({
    where: { id: question.id },
    data: { status: parsed.data.status },
  });

  await writeAudit({
    actorUserId: admin.user.id,
    action: QUESTION_AUDIT[parsed.data.status],
    targetType: "product_question",
    targetId: question.id,
    summary: `${admin.user.email} set a question on ${question.product.name} to ${parsed.data.status}`,
    meta: { from: question.status, to: parsed.data.status, productSlug: question.product.slug },
  });

  revalidateQuestion(question.id, question.product.slug);
  return { ok: true };
}

const answerSchema = z.object({
  questionId: z.string().min(1).max(64),
  body: z.string().max(20000),
});

export async function answerQuestionAction(
  _prev: QAModerationState,
  formData: FormData,
): Promise<QAModerationState> {
  const admin = await requirePermission("manage_reviews");

  const parsed = answerSchema.safeParse({
    questionId: formData.get("questionId"),
    body: formData.get("body"),
  });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const question = await prisma.productQuestion.findUnique({
    where: { id: parsed.data.questionId },
    select: { id: true, status: true, product: { select: { name: true, slug: true } } },
  });
  if (!question) return { ok: false, error: "That question wasn't found." };

  const check = checkLength(parsed.data.body, {
    min: ANSWER_LIMITS.bodyMin,
    max: ANSWER_LIMITS.bodyMax,
    label: "The answer",
  });
  if (!check.ok) return { ok: false, fieldErrors: { body: check.error } };

  const answer = await prisma.productAnswer.create({
    data: {
      questionId: question.id,
      authorId: admin.user.id,
      authorType: "STORE",
      body: check.value,
      status: "APPROVED",
    },
  });

  // Answering a still-pending question approves it so the thread becomes public.
  if (question.status === "PENDING") {
    await prisma.productQuestion.update({ where: { id: question.id }, data: { status: "APPROVED" } });
  }

  await writeAudit({
    actorUserId: admin.user.id,
    action: "answer.created",
    targetType: "product_answer",
    targetId: answer.id,
    summary: `${admin.user.email} answered a question on ${question.product.name}`,
    meta: { questionId: question.id, productSlug: question.product.slug },
  });

  revalidateQuestion(question.id, question.product.slug);
  return { ok: true };
}

const editAnswerSchema = z.object({
  id: z.string().min(1).max(64),
  body: z.string().max(20000),
});

export async function editAnswerAction(
  _prev: QAModerationState,
  formData: FormData,
): Promise<QAModerationState> {
  const admin = await requirePermission("manage_reviews");

  const parsed = editAnswerSchema.safeParse({
    id: formData.get("id"),
    body: formData.get("body"),
  });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const answer = await prisma.productAnswer.findUnique({
    where: { id: parsed.data.id },
    select: { id: true, question: { select: { id: true, product: { select: { name: true, slug: true } } } } },
  });
  if (!answer) return { ok: false, error: "That answer wasn't found." };

  const check = checkLength(parsed.data.body, {
    min: ANSWER_LIMITS.bodyMin,
    max: ANSWER_LIMITS.bodyMax,
    label: "The answer",
  });
  if (!check.ok) return { ok: false, fieldErrors: { body: check.error } };

  await prisma.productAnswer.update({ where: { id: answer.id }, data: { body: check.value } });

  await writeAudit({
    actorUserId: admin.user.id,
    action: "answer.updated",
    targetType: "product_answer",
    targetId: answer.id,
    summary: `${admin.user.email} edited an answer on ${answer.question.product.name}`,
    meta: { questionId: answer.question.id },
  });

  revalidateQuestion(answer.question.id, answer.question.product.slug);
  return { ok: true };
}

const setAnswerStatusSchema = z.object({
  id: z.string().min(1).max(64),
  status: z.enum(["APPROVED", "ARCHIVED", "REJECTED"]),
});

export async function setAnswerStatusAction(input: unknown): Promise<QAModerationState> {
  const admin = await requirePermission("manage_reviews");
  const parsed = setAnswerStatusSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const answer = await prisma.productAnswer.findUnique({
    where: { id: parsed.data.id },
    select: {
      id: true,
      status: true,
      question: { select: { id: true, product: { select: { name: true, slug: true } } } },
    },
  });
  if (!answer) return { ok: false, error: "That answer wasn't found." };
  if (answer.status === parsed.data.status) return { ok: true };

  await prisma.productAnswer.update({ where: { id: answer.id }, data: { status: parsed.data.status } });

  await writeAudit({
    actorUserId: admin.user.id,
    action: parsed.data.status === "APPROVED" ? "answer.approved" : "answer.archived",
    targetType: "product_answer",
    targetId: answer.id,
    summary: `${admin.user.email} set an answer on ${answer.question.product.name} to ${parsed.data.status}`,
    meta: { from: answer.status, to: parsed.data.status, questionId: answer.question.id },
  });

  revalidateQuestion(answer.question.id, answer.question.product.slug);
  return { ok: true };
}
