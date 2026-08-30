"use server";

import { revalidateTag, revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { reviewEligibility } from "@/lib/reviews";
import { REVIEW_LIMITS, cleanUserText, checkLength } from "@/lib/ugc";

/**
 * Customer-facing review actions (Step 15).
 *
 * Security model:
 *  - the authenticated user is resolved server-side (getCurrentUser); the client
 *    never sends a userId.
 *  - `verified` and the establishing `orderId` are derived from a real DELIVERED
 *    order via reviewEligibility(); the client cannot set them, and cannot use
 *    another customer's order because eligibility is scoped to `userId`.
 *  - new reviews are created PENDING and are not publicly visible until an admin
 *    with `manage_reviews` approves them.
 *  - Zod strips unknown keys, so fake `status` / `verified` / `userId` fields in
 *    the payload are ignored.
 *
 * Editing behaviour (spec §9): when a customer edits their review it is set back
 * to PENDING and must be re-approved before it is public again. This keeps
 * moderation honest — approved text can never be swapped for unmoderated text.
 * The product rating is recomputed on every transition that can change the set
 * of APPROVED reviews.
 */

export type ReviewActionState = {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
};

const productIdSchema = z.string().min(1).max(64);

const submitSchema = z.object({
  productId: productIdSchema,
  rating: z.coerce.number().int().min(1, "Choose a rating from 1 to 5.").max(5, "Choose a rating from 1 to 5."),
  title: z.string().max(2000).optional(),
  body: z.string().max(20000),
});

function revalidateProduct(slug?: string) {
  revalidateTag("products", "max");
  if (slug) revalidatePath(`/p/${slug}`);
  revalidatePath("/account");
}

export async function submitReviewAction(
  _prev: ReviewActionState,
  formData: FormData,
): Promise<ReviewActionState> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Please sign in to write a review." };

  const parsed = submitSchema.safeParse({
    productId: formData.get("productId"),
    rating: formData.get("rating"),
    title: formData.get("title") ?? undefined,
    body: formData.get("body"),
  });
  if (!parsed.success) {
    const fe: Record<string, string> = {};
    for (const i of parsed.error.issues) {
      const k = String(i.path[0] ?? "_");
      if (!fe[k]) fe[k] = i.message;
    }
    return { ok: false, error: "Please fix the highlighted fields.", fieldErrors: fe };
  }

  const product = await prisma.product.findUnique({
    where: { id: parsed.data.productId },
    select: { id: true, slug: true },
  });
  if (!product) return { ok: false, error: "That product no longer exists." };

  const title = parsed.data.title ? cleanUserText(parsed.data.title) : null;
  if (title && title.length > REVIEW_LIMITS.titleMax) {
    return { ok: false, fieldErrors: { title: `Keep the title to ${REVIEW_LIMITS.titleMax} characters or fewer.` } };
  }
  const bodyCheck = checkLength(parsed.data.body, {
    min: REVIEW_LIMITS.bodyMin,
    max: REVIEW_LIMITS.bodyMax,
    label: "Your review",
  });
  if (!bodyCheck.ok) return { ok: false, fieldErrors: { body: bodyCheck.error } };

  const existing = await prisma.review.findUnique({
    where: { productId_userId: { productId: product.id, userId: user.id } },
    select: { id: true },
  });
  if (existing) {
    return { ok: false, error: "You've already reviewed this product. Edit your existing review instead." };
  }

  const eligibility = await reviewEligibility(user.id, product.id);
  if (!eligibility.eligible) {
    return {
      ok: false,
      error: "Only customers with a delivered order for this product can leave a review.",
    };
  }

  await prisma.review.create({
    data: {
      productId: product.id,
      userId: user.id,
      orderId: eligibility.orderId,
      rating: parsed.data.rating,
      title: title || null,
      body: bodyCheck.value,
      verified: true,
      status: "PENDING",
    },
  });

  revalidateProduct(product.slug);
  return { ok: true };
}

const editSchema = z.object({
  reviewId: z.string().min(1).max(64),
  rating: z.coerce.number().int().min(1, "Choose a rating from 1 to 5.").max(5, "Choose a rating from 1 to 5."),
  title: z.string().max(2000).optional(),
  body: z.string().max(20000),
});

export async function editReviewAction(
  _prev: ReviewActionState,
  formData: FormData,
): Promise<ReviewActionState> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Please sign in." };

  const parsed = editSchema.safeParse({
    reviewId: formData.get("reviewId"),
    rating: formData.get("rating"),
    title: formData.get("title") ?? undefined,
    body: formData.get("body"),
  });
  if (!parsed.success) {
    const fe: Record<string, string> = {};
    for (const i of parsed.error.issues) {
      const k = String(i.path[0] ?? "_");
      if (!fe[k]) fe[k] = i.message;
    }
    return { ok: false, error: "Please fix the highlighted fields.", fieldErrors: fe };
  }

  const review = await prisma.review.findUnique({
    where: { id: parsed.data.reviewId },
    select: { id: true, userId: true, product: { select: { slug: true } } },
  });
  if (!review || review.userId !== user.id) {
    return { ok: false, error: "That review wasn't found." };
  }

  const title = parsed.data.title ? cleanUserText(parsed.data.title) : null;
  if (title && title.length > REVIEW_LIMITS.titleMax) {
    return { ok: false, fieldErrors: { title: `Keep the title to ${REVIEW_LIMITS.titleMax} characters or fewer.` } };
  }
  const bodyCheck = checkLength(parsed.data.body, {
    min: REVIEW_LIMITS.bodyMin,
    max: REVIEW_LIMITS.bodyMax,
    label: "Your review",
  });
  if (!bodyCheck.ok) return { ok: false, fieldErrors: { body: bodyCheck.error } };

  await prisma.review.update({
    where: { id: review.id },
    data: {
      rating: parsed.data.rating,
      title: title || null,
      body: bodyCheck.value,
      // Edited content must be re-moderated before it is public again.
      status: "PENDING",
    },
  });

  revalidateProduct(review.product.slug);
  return { ok: true };
}

const deleteSchema = z.object({ reviewId: z.string().min(1).max(64) });

export async function deleteReviewAction(input: unknown): Promise<ReviewActionState> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Please sign in." };

  const parsed = deleteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const review = await prisma.review.findUnique({
    where: { id: parsed.data.reviewId },
    select: { id: true, userId: true, product: { select: { slug: true } } },
  });
  if (!review || review.userId !== user.id) {
    return { ok: false, error: "That review wasn't found." };
  }

  // A customer deleting their own review is a genuine removal (spec §10 allows
  // it). Admin-side moderation uses ARCHIVED instead so the moderation trail
  // stays intact.
  await prisma.review.delete({ where: { id: review.id } });
  revalidateProduct(review.product.slug);
  return { ok: true };
}
