"use server";

import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { scheduleEmail } from "@/lib/email/schedule";
import { sendSellerAccountSubmitted } from "@/lib/email/notifications";
import { submitSellerApplication } from "@/lib/seller-onboarding/repository";

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

  return { ok: true };
}
