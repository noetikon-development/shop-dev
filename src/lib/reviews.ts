import "server-only";
import { prisma } from "@/lib/prisma";

/**
 * Product reviews — customer-facing server logic (Step 15).
 *
 * The public read path (approved reviews + rating summary) lives in
 * `src/lib/data.ts` (`getProductReviews` / `getReviewSummary`, cached, computed
 * from APPROVED review rows). This module holds the pieces that must stay
 * uncached and server-only: the verified-purchase eligibility check and the
 * current user's own review.
 *
 * Note on `Product.ratingAvg` / `ratingCount`: those denormalised columns are
 * curated merchandising figures (seeded independently, used by the product-list
 * sort/filter). Step 15 does NOT overwrite them from the review table — see the
 * Step 15 report, item 19.
 */

export const REVIEW_STATUSES = ["PENDING", "APPROVED", "REJECTED", "ARCHIVED"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

// ---------------------------------------------------------------------------
// Verified-purchase eligibility
// ---------------------------------------------------------------------------

export type ReviewEligibility = {
  eligible: boolean;
  /** The DELIVERED order that qualifies the customer, if any. */
  orderId: string | null;
};

/**
 * A customer may review a product only if their account has a DELIVERED order
 * that contains that product. DELIVERED is the app's completed order state
 * (Step 12/13). Eligibility is scoped to `userId`, so a customer can never use
 * another customer's order — and nothing here trusts a client-supplied id.
 */
export async function reviewEligibility(
  userId: string,
  productId: string,
): Promise<ReviewEligibility> {
  const order = await prisma.order.findFirst({
    where: {
      userId,
      status: "DELIVERED",
      items: { some: { productId } },
    },
    orderBy: { placedAt: "desc" },
    select: { id: true },
  });
  return order ? { eligible: true, orderId: order.id } : { eligible: false, orderId: null };
}

export type MyReview = {
  id: string;
  rating: number;
  title: string | null;
  body: string;
  status: ReviewStatus;
  verified: boolean;
  createdAt: string;
  updatedAt: string;
};

export async function getMyReview(userId: string, productId: string): Promise<MyReview | null> {
  const r = await prisma.review.findUnique({
    where: { productId_userId: { productId, userId } },
    select: {
      id: true,
      rating: true,
      title: true,
      body: true,
      status: true,
      verified: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!r) return null;
  return {
    id: r.id,
    rating: r.rating,
    title: r.title,
    body: r.body,
    status: r.status as ReviewStatus,
    verified: r.verified,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
