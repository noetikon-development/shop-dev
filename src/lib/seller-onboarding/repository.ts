import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createSeller, type AdminSellerError } from "@/lib/admin/sellers/repository";
import { writeAudit } from "@/lib/admin/audit";

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
  /** APPROVED only (Phase 4) — whether there's a PENDING SellerInvite the
   *  applicant can claim, and whether they already have an ACTIVE
   *  membership. Read-only detection for the status page's claim button —
   *  never creates an invite or membership itself. False for every other
   *  status without querying either table. */
  hasPendingInvite: boolean;
  hasActiveMembership: boolean;
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

  if (seller.status === "APPROVED") {
    const [pendingInvite, membership] = await Promise.all([
      client.sellerInvite.findFirst({ where: { sellerId: seller.id, status: "PENDING" }, select: { id: true } }),
      client.sellerUser.findUnique({
        where: { sellerId_userId: { sellerId: seller.id, userId: applicantUserId } },
        select: { status: true },
      }),
    ]);
    return {
      displayName: seller.displayName,
      status: seller.status,
      createdAt: seller.createdAt,
      updatedAt: seller.updatedAt,
      reopened: false,
      reason: null,
      hasPendingInvite: !!pendingInvite,
      hasActiveMembership: membership?.status === "ACTIVE",
    };
  }

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
      hasPendingInvite: false,
      hasActiveMembership: false,
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
        hasPendingInvite: false,
        hasActiveMembership: false,
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
    hasPendingInvite: false,
    hasActiveMembership: false,
  };
}

/**
 * Claim OWNER access for the caller's own approved application — Phase 4.
 *
 * Security model (audited, not a bearer-link / token / email-matched claim):
 *   requireUser() (caller's job) → Seller located ONLY by
 *   `applicantUserId === userId` → Seller.status must be APPROVED → a
 *   PENDING SellerInvite must exist for that Seller. There is no invite id,
 *   token, or email accepted from anywhere — `userId` is the only input, and
 *   it must come from the authenticated session, never form/query data.
 *
 * The actual state change (SellerUser create + SellerInvite→ACCEPTED) is one
 * atomic transaction that re-verifies everything from scratch (eligibility,
 * invite-still-PENDING, applicant match) rather than trusting the fast-path
 * checks above it — those exist only to avoid opening a transaction for the
 * common "nothing to claim" case. Replay-safe: a status-guarded
 * `updateMany(where: { status: "PENDING" })` on the invite means only the
 * first of any concurrent/replayed claim succeeds; every other caller lands
 * on ALREADY_CLAIMED. The `SellerUser` `@@unique([sellerId, userId])`
 * constraint (checked here the same way `addSellerUserByEmail` already
 * does, and enforced by the DB regardless) is the hard backstop against a
 * duplicate OWNER row.
 */
export type ClaimSellerOwnerInviteResult =
  | { ok: true; code: "SUCCESS"; sellerId: string }
  | { ok: true; code: "ALREADY_CLAIMED"; sellerId: string }
  | { ok: false; code: "NOT_ELIGIBLE"; error: string }
  | { ok: false; code: "NO_PENDING_INVITE"; error: string };

const NOT_ELIGIBLE_ERROR = "There's no approved application to activate for your account.";
const NO_PENDING_INVITE_ERROR = "There's no pending invitation for your account.";

export async function claimSellerOwnerInvite(
  userId: string,
  client: Client = prisma,
): Promise<ClaimSellerOwnerInviteResult> {
  // Fast path — never by email, never by an id supplied by a caller.
  const seller = await client.seller.findFirst({
    where: { applicantUserId: userId },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true },
  });
  if (!seller || seller.status !== "APPROVED") {
    return { ok: false, code: "NOT_ELIGIBLE", error: NOT_ELIGIBLE_ERROR };
  }

  const existingMembership = await client.sellerUser.findUnique({
    where: { sellerId_userId: { sellerId: seller.id, userId } },
    select: { status: true },
  });
  if (existingMembership?.status === "ACTIVE") {
    return { ok: true, code: "ALREADY_CLAIMED", sellerId: seller.id };
  }

  const invite = await client.sellerInvite.findFirst({
    where: { sellerId: seller.id, status: "PENDING" },
    select: { id: true },
  });
  if (!invite) {
    return { ok: false, code: "NO_PENDING_INVITE", error: NO_PENDING_INVITE_ERROR };
  }

  type ClaimRunResult =
    | { ok: true; code: "SUCCESS"; sellerId: string; sellerUserId: string }
    | { ok: true; code: "ALREADY_CLAIMED"; sellerId: string }
    | { ok: false; code: "NOT_ELIGIBLE"; error: string };

  const run = async (tx: Client): Promise<ClaimRunResult> => {
    // a/c — re-check Seller eligibility AND the applicant match from scratch,
    // never trusting the fast-path reads above (the Seller could have changed
    // status between them and here).
    const sellerNow = await tx.seller.findUnique({
      where: { id: seller.id },
      select: { status: true, applicantUserId: true },
    });
    if (!sellerNow || sellerNow.status !== "APPROVED" || sellerNow.applicantUserId !== userId) {
      return { ok: false, code: "NOT_ELIGIBLE", error: NOT_ELIGIBLE_ERROR };
    }

    // b — status-guarded claim: matches 1 row only if STILL PENDING right
    // now. This is the actual replay/concurrency guard.
    const claimed = await tx.sellerInvite.updateMany({
      where: { id: invite.id, status: "PENDING" },
      data: { status: "ACCEPTED", acceptedByUserId: userId, acceptedAt: new Date() },
    });
    if (claimed.count === 0) {
      return { ok: true, code: "ALREADY_CLAIMED", sellerId: seller.id };
    }

    // Hard backstop check before the write — the DB's own @@unique constraint
    // enforces this regardless, but checking first gives a clean idempotent
    // result instead of a thrown P2002 in the (already very unlikely, given
    // the guard above) case a membership appeared between the fast path and
    // here.
    const already = await tx.sellerUser.findUnique({
      where: { sellerId_userId: { sellerId: seller.id, userId } },
      select: { id: true },
    });
    if (already) {
      return { ok: true, code: "ALREADY_CLAIMED", sellerId: seller.id };
    }

    const sellerUser = await tx.sellerUser.create({
      data: { sellerId: seller.id, userId, role: "OWNER", status: "ACTIVE" },
      select: { id: true },
    });

    return { ok: true, code: "SUCCESS", sellerId: seller.id, sellerUserId: sellerUser.id };
  };

  const result = client === prisma ? await prisma.$transaction((tx) => run(tx)) : await run(client);

  // Audit is written AFTER the state-changing transaction commits — same
  // best-effort discipline as cascadeSellerOrderFromParent's own cascade
  // audit and applyPaid's payment.paid audit (a logging failure must never
  // undo an already-committed claim). Only on a genuinely NEW claim this
  // call actually performed — never on an ALREADY_CLAIMED replay, which
  // would otherwise write a second, misleading audit row for one real event.
  if (result.ok && result.code === "SUCCESS") {
    await writeAudit(
      {
        actorUserId: userId,
        action: "seller.owner_claimed",
        targetType: "seller_user",
        targetId: result.sellerUserId,
        summary: `User claimed OWNER access for seller ${result.sellerId}`,
        meta: { sellerId: result.sellerId, inviteId: invite.id },
      },
      client === prisma ? undefined : client,
    );
  }

  return result.ok && result.code === "SUCCESS"
    ? { ok: true, code: "SUCCESS", sellerId: result.sellerId }
    : result;
}

/**
 * Create the OWNER-claim invite for a Seller when it's approved for the
 * first time — called ONLY from the admin approval action, never from any
 * customer-facing code path.
 *
 * A no-op (never creates anything) when:
 *   - the Seller has no `applicantUserId` (admin-created, not self-service);
 *   - a PENDING SellerInvite for this Seller already exists — reused as-is,
 *     never duplicated (this is the "defensive duplicate check" layer; the
 *     caller's own `res.from !== res.to` guard is the first layer, so a
 *     replayed approval on an already-APPROVED seller never even reaches
 *     here — but this function is self-sufficient regardless of caller
 *     discipline).
 *
 * `email` is the applicant's CURRENT account email (`User.email`) — read
 * fresh at invite-creation time, not `Seller.supportEmail` (a plain,
 * non-identity contact string the applicant could have typed as anything)
 * and not derived from any other identity source. If the referenced User
 * row is somehow gone, this is a no-op rather than inventing a fallback
 * address — an invite with no valid recipient identity would be meaningless
 * (the claim flow itself never reads this field for authorization anyway;
 * it exists for display in a future invite email).
 */
export type CreateOwnerInviteResult =
  | { created: true; inviteId: string }
  | { created: false; inviteId: string | null };

export async function createOwnerInviteIfNeeded(
  sellerId: string,
  invitedById: string | null,
  client: Client = prisma,
): Promise<CreateOwnerInviteResult> {
  const seller = await client.seller.findUnique({
    where: { id: sellerId },
    select: { applicantUserId: true },
  });
  if (!seller?.applicantUserId) return { created: false, inviteId: null };

  const existing = await client.sellerInvite.findFirst({
    where: { sellerId, status: "PENDING" },
    select: { id: true },
  });
  if (existing) return { created: false, inviteId: existing.id };

  const applicant = await client.user.findUnique({
    where: { id: seller.applicantUserId },
    select: { email: true },
  });
  if (!applicant) return { created: false, inviteId: null };

  const invite = await client.sellerInvite.create({
    data: {
      sellerId,
      email: applicant.email,
      status: "PENDING",
      invitedById,
    },
    select: { id: true },
  });

  return { created: true, inviteId: invite.id };
}
