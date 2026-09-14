"use server";

import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { scheduleEmail } from "@/lib/email/schedule";
import { sendSellerAccountSubmitted, sendSellerAccountSubmittedOps } from "@/lib/email/notifications";
import { submitSellerApplication, claimSellerOwnerInvite } from "@/lib/seller-onboarding/repository";

/**
 * Customer-facing seller-application server action — Seller Onboarding
 * Phase 2. Mirrors the shape of admin/sellers/actions.ts's createSellerAction
 * (zod pre-check, delegate to the repository, schedule the SAME existing
 * submitted email) with one difference: the actor here is the authenticated
 * customer applying for themselves, not an admin acting on someone else's
 * behalf, so there is no permission check — only `requireUser()`.
 */

export type SellerApplicationActionState = {
  ok?: boolean;
  error?: string;
};

const applySchema = z.object({
  displayName: z.string().trim().min(2).max(80),
  slug: z.string().trim().min(3).max(40),
  supportEmail: z.string().trim().max(200),
});

export async function submitSellerApplicationAction(
  _prev: SellerApplicationActionState,
  formData: FormData,
): Promise<SellerApplicationActionState> {
  // Identity comes ONLY from the authenticated session. `formData` is never
  // read for an applicant/user id — there is no such field on this form, and
  // `submitSellerApplication` below is only ever called with `user.id`, never
  // with anything sourced from the browser. This is deliberate: it is the
  // only thing standing between "you applied for yourself" and "you applied
  // on someone else's behalf."
  const user = await requireUser("/sell-on-axiaro/apply");

  const parsed = applySchema.safeParse({
    displayName: formData.get("displayName"),
    slug: formData.get("slug"),
    supportEmail: formData.get("supportEmail"),
  });
  if (!parsed.success) return { error: "Please check the highlighted fields." };

  const res = await submitSellerApplication(user.id, parsed.data);
  if (!res.ok) return { error: res.error };

  // Same call, same idempotency key, same email the admin-created path already
  // uses — see createSellerAction's identical scheduleEmail call.
  scheduleEmail(() => sendSellerAccountSubmitted(res.sellerId));

  // 9F-62 — Ops-only, self-service applications ONLY (never scheduled from
  // createSellerAction): the business need is "alert Axiaro when a CUSTOMER
  // applies" — an admin creating a seller already knows, so this would be
  // pure noise on that path. A separate notification, separate recipient,
  // separate idempotency key from the applicant ack above.
  scheduleEmail(() => sendSellerAccountSubmittedOps(res.sellerId));

  return { ok: true };
}

/**
 * Claim OWNER access for the caller's own approved application — Phase 4.
 *
 * Takes no form fields at all: there is no seller id, invite id, or user id
 * anywhere in `formData` for this action, by design. The ONLY input is the
 * authenticated session (`requireUser()`), and `claimSellerOwnerInvite`
 * itself re-derives everything (which Seller, which invite) from that one
 * user id — see its own doc comment for the full security model.
 */
export type ClaimSellerOwnerInviteActionState = {
  ok?: boolean;
  code?: "SUCCESS" | "ALREADY_CLAIMED" | "NOT_ELIGIBLE" | "NO_PENDING_INVITE";
  error?: string;
};

export async function claimSellerOwnerInviteAction(
  _prev: ClaimSellerOwnerInviteActionState,
  _formData: FormData,
): Promise<ClaimSellerOwnerInviteActionState> {
  const user = await requireUser("/sell-on-axiaro/status");

  const res = await claimSellerOwnerInvite(user.id);
  if (!res.ok) return { error: res.error, code: res.code };

  return { ok: true, code: res.code };
}
