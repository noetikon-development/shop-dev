"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/admin/rbac";
import { writeAudit } from "@/lib/admin/audit";

/**
 * Review moderation actions (Step 15). Every mutation requires the existing
 * `manage_reviews` permission, is validated server-side, recomputes the product
 * rating from APPROVED reviews, and writes an AdminAuditLog entry.
 *
 * Reviews are never hard-deleted here — moderation uses REJECTED / ARCHIVED so
 * the history stays auditable (spec §10 / §31).
 *
 * The public reviews section recomputes its average / count / distribution from
 * APPROVED rows on every render (see `getReviewSummary`), so a status change is
 * reflected as soon as the `products` cache tag is revalidated below. The
 * curated `Product.ratingAvg` / `ratingCount` merchandising columns are left
 * untouched (Step 15 report, item 19).
 */

export type ReviewModerationState = { ok?: boolean; error?: string };

const MODERATION_TARGETS = ["APPROVED", "REJECTED", "ARCHIVED", "PENDING"] as const;

const schema = z.object({
  id: z.string().min(1).max(64),
  status: z.enum(MODERATION_TARGETS),
});

const AUDIT_ACTION: Record<(typeof MODERATION_TARGETS)[number], string> = {
  APPROVED: "review.approved",
  REJECTED: "review.rejected",
  ARCHIVED: "review.archived",
  PENDING: "review.reopened",
};

export async function setReviewStatusAction(input: unknown): Promise<ReviewModerationState> {
  const admin = await requirePermission("manage_reviews");

  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const review = await prisma.review.findUnique({
    where: { id: parsed.data.id },
    select: {
      id: true,
      status: true,
      rating: true,
      product: { select: { name: true, slug: true } },
      user: { select: { email: true } },
    },
  });
  if (!review) return { ok: false, error: "That review wasn't found." };
  if (review.status === parsed.data.status) return { ok: true };

  await prisma.review.update({
    where: { id: review.id },
    data: { status: parsed.data.status },
  });

  await writeAudit({
    actorUserId: admin.user.id,
    action: AUDIT_ACTION[parsed.data.status],
    targetType: "review",
    targetId: review.id,
    summary: `${admin.user.email} set review of ${review.product.name} to ${parsed.data.status}`,
    meta: {
      from: review.status,
      to: parsed.data.status,
      rating: review.rating,
      productSlug: review.product.slug,
      reviewer: review.user.email,
    },
  });

  revalidateTag("products", "max");
  revalidatePath("/admin/reviews");
  revalidatePath(`/admin/reviews/${review.id}`);
  revalidatePath(`/p/${review.product.slug}`);
  return { ok: true };
}
