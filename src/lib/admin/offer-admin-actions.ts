"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import { requirePermission } from "@/lib/admin/rbac";
import { writeAudit } from "@/lib/admin/audit";
import { scheduleEmail } from "@/lib/email/schedule";
import { sendSellerOfferPublishedOps } from "@/lib/email/notifications";
import { adminSetOfferStatus } from "@/lib/admin/offer-status";

/**
 * Admin Offer status server action — Phase 9F-24D (P1-4).
 *
 * PERMISSION: `manage_settings` (SUPER_ADMIN always passes) — the same gate the
 * rest of `/admin/sellers` marketplace configuration uses. NO new RBAC key,
 * `scripts/seed-rbac.ts` untouched.
 *
 * Writes exactly one `adminAuditLog` row per real transition, revalidates the
 * storefront only when buy-box visibility actually changed, and — on a `→ ACTIVE`
 * publish — queues the same ops notice the seller path does. Touches only
 * `Offer.status`.
 */

export type AdminOfferActionState = {
  ok?: boolean;
  error?: string;
  message?: string;
};

const schema = z.object({
  offerId: z.string().min(1).max(64),
  status: z.enum(["DRAFT", "ACTIVE", "INACTIVE", "ARCHIVED"]),
});

export async function setAdminOfferStatusAction(
  _prev: AdminOfferActionState,
  formData: FormData,
): Promise<AdminOfferActionState> {
  const admin = await requirePermission("manage_settings");
  const parsed = schema.safeParse({
    offerId: formData.get("offerId"),
    status: formData.get("status"),
  });
  if (!parsed.success) return { error: "Invalid request." };

  const res = await adminSetOfferStatus(parsed.data.offerId, parsed.data.status);
  if (!res.ok) return { error: res.error };

  revalidatePath("/admin/offers");
  revalidatePath(`/admin/offers/${parsed.data.offerId}`);
  revalidatePath(`/admin/sellers/${res.sellerId}`);
  revalidatePath("/admin/audit");
  if (res.storefrontAffected) {
    revalidateTag("products", "max");
    revalidateTag("categories", "max");
  }

  if (res.previousStatus !== res.newStatus) {
    const auditId = await writeAudit({
      actorUserId: admin.user.id,
      action: "offer.status_changed",
      targetType: "offer",
      targetId: parsed.data.offerId,
      summary: `${admin.user.email} moved ${res.sellerName}'s listing "${res.productName}" (${res.variantSku}) ${res.previousStatus} → ${res.newStatus}`,
      meta: {
        actor: "admin",
        sellerId: res.sellerId,
        offerId: parsed.data.offerId,
        variantId: res.variantId,
        from: res.previousStatus,
        to: res.newStatus,
        storefrontAffected: res.storefrontAffected,
      },
    });
    if (res.newStatus === "ACTIVE" && res.sellerType === "THIRD_PARTY" && auditId) {
      scheduleEmail(() => sendSellerOfferPublishedOps(parsed.data.offerId, auditId));
    }
  }

  const verb =
    parsed.data.status === "ACTIVE"
      ? "published — it's now live"
      : parsed.data.status === "INACTIVE"
        ? "taken offline"
        : parsed.data.status === "ARCHIVED"
          ? "archived"
          : "moved to draft";
  return { ok: true, message: `Listing ${verb}.` };
}
