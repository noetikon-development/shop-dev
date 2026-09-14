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

function safeParseMeta(value: string | null | undefined): { reason?: unknown } {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The status-page view of one applicant's own application — Phase 3.
 *
 * Only ever looked up by `applicantUserId` (never supportEmail, displayName,
 * slug, or any id supplied by the caller) — see `getSellerApplicationStatus`
 * below. Exposes only what an applicant should ever see about their own
 * application: never `commissionRate`, `contentReviewNote`, or any other
 * admin/moderation-only field.
 *
 * `reason` is the SAME authoritative value the rejection/reopen emails
 * already use — read back off the most recent matching `AdminAuditLog` row
 * (`seller.rejected` / `seller.reopened`, written by `transitionSellerAction`)
 * rather than re-derived or invented here. `null` when there is none (e.g. a
 * PENDING application that has never been rejected or reopened).
 */
export type SellerApplicationStatusView = {
  displayName: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  /** True only when the most recent status-defining event was a reopen
   *  (REJECTED → PENDING), so a PENDING page can say "back under review"
   *  instead of the plain first-submission copy. */
  reopened: boolean;
  /** The admin's actual reason/note for REJECTED or a reopened PENDING;
   *  null for every other state, and null if — despite the state — no
   *  audit row could be found (never invented as a fallback string). */
  reason: string | null;
};

export async function getSellerApplicationStatus(
  applicantUserId: string,
  client: Client = prisma,
): Promise<SellerApplicationStatusView | null> {
  const seller = await client.seller.findFirst({
    where: { applicantUserId },
    orderBy: { createdAt: "desc" },
    select: { id: true, displayName: true, status: true, createdAt: true, updatedAt: true },
  });
  if (!seller) return null;

  if (seller.status === "REJECTED") {
    const audit = await client.adminAuditLog.findFirst({
      where: { targetType: "seller", targetId: seller.id, action: "seller.rejected" },
      orderBy: { createdAt: "desc" },
      select: { meta: true },
    });
    const reason = safeParseMeta(audit?.meta).reason;
    return {
      displayName: seller.displayName,
      status: seller.status,
      createdAt: seller.createdAt,
      updatedAt: seller.updatedAt,
      reopened: false,
      reason: typeof reason === "string" && reason.trim() ? reason.trim() : null,
    };
  }

  if (seller.status === "PENDING") {
    const reopenAudit = await client.adminAuditLog.findFirst({
      where: { targetType: "seller", targetId: seller.id, action: "seller.reopened" },
      orderBy: { createdAt: "desc" },
      select: { meta: true },
    });
    if (reopenAudit) {
      const reason = safeParseMeta(reopenAudit.meta).reason;
      return {
        displayName: seller.displayName,
        status: seller.status,
        createdAt: seller.createdAt,
        updatedAt: seller.updatedAt,
        reopened: true,
        reason: typeof reason === "string" && reason.trim() ? reason.trim() : null,
      };
    }
  }

  return {
    displayName: seller.displayName,
    status: seller.status,
    createdAt: seller.createdAt,
    updatedAt: seller.updatedAt,
    reopened: false,
    reason: null,
  };
}
