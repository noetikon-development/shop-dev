import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createSeller, type AdminSellerError } from "@/lib/admin/sellers/repository";

type Client = Prisma.TransactionClient | typeof prisma;

/**
 * Customer-facing seller-application data layer — Seller Onboarding Phase 2.
 *
 * Deliberately thin: all field validation (displayName length, slug shape,
 * support-email format) and the actual `Seller` row creation are the existing
 * `createSeller()` admin repository function's job, reused as-is rather than
 * duplicated. The only new behavior here is (1) blocking a user who already
 * has an application in progress, and (2) stamping `applicantUserId` after
 * creation so the application can later be attributed back to its submitter
 * (status page, duplicate checks) — `createSeller()`'s own signature is
 * unmodified.
 *
 * A Seller in one of these statuses counts as "in progress" for duplicate
 * purposes. CLOSED and REJECTED are deliberately NOT included — a user whose
 * prior application was closed or rejected (and never reopened) may submit a
 * fresh one. This is an explicit, minimal reading of the current lifecycle,
 * not a considered product decision about re-application cooldowns or
 * whether a terminally-rejected applicant should be blocked for a period;
 * revisit if that turns out to matter.
 */
export const SELLER_APPLICATION_IN_PROGRESS_STATUSES = ["PENDING", "APPROVED", "SUSPENDED"] as const;

export type SellerApplicationInput = {
  displayName: string;
  slug: string;
  supportEmail: string;
};

export type SellerApplicationResult =
  | { ok: true; sellerId: string; displayName: string; slug: string }
  | AdminSellerError
  | { ok: false; code: "APPLICATION_IN_PROGRESS"; error: string };

/**
 * Submit a new self-service seller application for `applicantUserId`.
 * `commissionRate` is intentionally not accepted here — it stays
 * operator-controlled, seeded from the CMS default exactly as the admin path
 * already does inside `createSeller()`.
 */
export async function submitSellerApplication(
  applicantUserId: string,
  input: SellerApplicationInput,
  client: Client = prisma,
): Promise<SellerApplicationResult> {
  const existing = await client.seller.findFirst({
    where: { applicantUserId, status: { in: [...SELLER_APPLICATION_IN_PROGRESS_STATUSES] } },
    select: { id: true },
  });
  if (existing) {
    return {
      ok: false,
      code: "APPLICATION_IN_PROGRESS",
      error: "You already have a seller application in progress.",
    };
  }

  const created = await createSeller(
    { displayName: input.displayName, slug: input.slug, supportEmail: input.supportEmail },
    client,
  );
  if (!created.ok) return created;

  await client.seller.update({
    where: { id: created.sellerId },
    data: { applicantUserId },
  });

  return { ok: true, sellerId: created.sellerId, displayName: created.displayName, slug: created.slug };
}
