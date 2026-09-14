"use server";

import { revalidatePath } from "next/cache";
import { requireSellerSessionPermission } from "@/lib/seller/session";
import { writeAudit } from "@/lib/admin/audit";
import { cleanUserText } from "@/lib/ugc";
import { zodFieldErrors } from "@/lib/addresses";
import { sellerVerificationDraftSchema } from "@/lib/seller-verification/validation";
import { saveSellerVerificationDraft } from "@/lib/seller-verification/repository";

/**
 * `/seller/verification` server action (Phase 2).
 *
 * Requires `manage_seller_settings` (OWNER + MANAGER) — the SAME permission
 * `/seller/settings` already requires, so no new seller-scoped permission
 * (src/lib/marketplace/seller-permissions.ts) or admin RBAC row is needed.
 * `requireSellerSessionPermission` derives `ctx.sellerId` from the
 * authenticated session's ACTIVE SellerUser membership — the browser never
 * supplies a sellerId, so this can never touch another seller's record (a
 * STAFF-only member, or someone with no membership at all, is rejected by
 * the session helper itself before this action body ever runs).
 *
 * No PII goes into the audit row's `meta` — only ids and non-sensitive flags,
 * matching `saveSellerContactAction`'s existing discipline of never writing
 * actual field values (email addresses there, identity/business data here)
 * into `AdminAuditLog`.
 */

export type SellerVerificationActionState = {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
  message?: string;
};

function toNullable(v: string | undefined): string | null {
  const t = (v ?? "").trim();
  return t ? t : null;
}

export async function saveSellerVerificationDraftAction(
  _prev: SellerVerificationActionState,
  formData: FormData,
): Promise<SellerVerificationActionState> {
  const { ctx } = await requireSellerSessionPermission("manage_seller_settings");

  const parsed = sellerVerificationDraftSchema.safeParse({
    legalName: formData.get("legalName") ?? undefined,
    phone: formData.get("phone") ?? undefined,
    addressLine1: formData.get("addressLine1") ?? undefined,
    addressLine2: formData.get("addressLine2") ?? undefined,
    barangay: formData.get("barangay") ?? undefined,
    city: formData.get("city") ?? undefined,
    province: formData.get("province") ?? undefined,
    postalCode: formData.get("postalCode") ?? undefined,
    country: formData.get("country") ?? undefined,
    businessType: formData.get("businessType") ?? undefined,
    businessName: formData.get("businessName") ?? undefined,
    businessRegistrationNumber: formData.get("businessRegistrationNumber") ?? undefined,
    dtiRegistrationNumber: formData.get("dtiRegistrationNumber") ?? undefined,
    secRegistrationNumber: formData.get("secRegistrationNumber") ?? undefined,
    tin: formData.get("tin") ?? undefined,
  });
  if (!parsed.success) {
    return { error: "Please check the highlighted fields.", fieldErrors: zodFieldErrors(parsed.error.issues) };
  }
  const d = parsed.data;

  const res = await saveSellerVerificationDraft(ctx, {
    legalName: toNullable(d.legalName ? cleanUserText(d.legalName) : d.legalName),
    phone: toNullable(d.phone),
    addressLine1: toNullable(d.addressLine1 ? cleanUserText(d.addressLine1) : d.addressLine1),
    addressLine2: toNullable(d.addressLine2 ? cleanUserText(d.addressLine2) : d.addressLine2),
    barangay: toNullable(d.barangay ? cleanUserText(d.barangay) : d.barangay),
    city: toNullable(d.city ? cleanUserText(d.city) : d.city),
    province: toNullable(d.province ? cleanUserText(d.province) : d.province),
    postalCode: toNullable(d.postalCode),
    country: toNullable(d.country),
    businessType: toNullable(d.businessType),
    businessName: toNullable(d.businessName ? cleanUserText(d.businessName) : d.businessName),
    businessRegistrationNumber: toNullable(d.businessRegistrationNumber),
    dtiRegistrationNumber: toNullable(d.dtiRegistrationNumber),
    secRegistrationNumber: toNullable(d.secRegistrationNumber),
    tin: toNullable(d.tin),
  });
  if (!res.ok) return { error: res.error };

  await writeAudit({
    actorUserId: ctx.userId,
    action: "seller.verification.draft_saved",
    targetType: "seller_verification",
    targetId: res.verification.id,
    summary: `seller ${ctx.sellerName} saved its verification details as a draft`,
    meta: {
      sellerId: ctx.sellerId,
      sellerVerificationId: res.verification.id,
      businessType: res.verification.businessType,
    },
  });

  revalidatePath("/seller/verification");
  return { ok: true, message: "Saved as a draft." };
}
