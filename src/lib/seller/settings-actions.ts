"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSellerSessionPermission } from "@/lib/seller/session";
import { writeAudit } from "@/lib/admin/audit";
import {
  updateSellerProfileDraft,
  updateSellerContact,
  submitSellerProfile,
  setSellerProfileImage,
  type SellerProfileError,
} from "@/lib/marketplace/seller-profile-repository";
import {
  uploadSellerMedia,
  deleteSellerMedia,
  type SellerMediaError,
} from "@/lib/marketplace/seller-media-repository";
import { SELLER_SOCIAL_KEYS } from "@/lib/marketplace/types";

/**
 * `/seller/settings` server actions (Phase 9F-4a).
 *
 * All require `manage_seller_settings` (OWNER + MANAGER). Every mutation is
 * seller-scoped inside the repository — the browser never passes a sellerId, and
 * the repository re-checks `id: ctx.sellerId` inside its transaction.
 *
 * These NEVER touch the storefront (`products` tag / `/p/*` / `/c/*` are never
 * revalidated), never touch `Product` / `Variant` / `Offer` / `OfferInventory` /
 * `StoreSetting` / `Inventory`, and never let the seller set `contentStatus =
 * APPROVED` or write a protected `Seller` column.
 */

export type SellerSettingsActionState = {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
  message?: string;
};

function fromRepoError(e: SellerProfileError | SellerMediaError): SellerSettingsActionState {
  return { error: e.error };
}

function revalidateSeller() {
  revalidatePath("/seller/settings");
  revalidatePath("/seller");
}

// ---------------------------------------------------------------------------
// Moderated profile bundle
// ---------------------------------------------------------------------------

const profileSchema = z.object({
  bio: z.string().max(4000).optional(),
  returnPolicy: z.string().max(6000).optional(),
  shippingPolicy: z.string().max(6000).optional(),
  shipFromCity: z.string().max(200).optional(),
  shipFromCountry: z.string().max(2).optional(),
});

export async function saveSellerProfileAction(
  _prev: SellerSettingsActionState,
  formData: FormData,
): Promise<SellerSettingsActionState> {
  const { ctx } = await requireSellerSessionPermission("manage_seller_settings");

  const parsed = profileSchema.safeParse({
    bio: formData.get("bio") ?? undefined,
    returnPolicy: formData.get("returnPolicy") ?? undefined,
    shippingPolicy: formData.get("shippingPolicy") ?? undefined,
    shipFromCity: formData.get("shipFromCity") ?? undefined,
    shipFromCountry: formData.get("shipFromCountry") ?? undefined,
  });
  if (!parsed.success) return { error: "Please check the highlighted fields." };

  const socialLinks: Record<string, string> = {};
  for (const k of SELLER_SOCIAL_KEYS) {
    const v = formData.get(`social.${k}`);
    if (typeof v === "string" && v.trim()) socialLinks[k] = v.trim();
  }

  const res = await updateSellerProfileDraft(ctx, {
    bio: parsed.data.bio ?? null,
    returnPolicy: parsed.data.returnPolicy ?? null,
    shippingPolicy: parsed.data.shippingPolicy ?? null,
    shipFromCity: parsed.data.shipFromCity ?? null,
    shipFromCountry: parsed.data.shipFromCountry ?? null,
    socialLinks,
  });
  if (!res.ok) return fromRepoError(res);

  await writeAudit({
    actorUserId: ctx.userId,
    action: "seller.profile.saved",
    targetType: "seller",
    targetId: ctx.sellerId,
    summary: `seller ${ctx.sellerName} edited its store profile (now ${res.contentStatus})`,
    meta: { sellerId: ctx.sellerId, contentStatus: res.contentStatus },
  });

  revalidateSeller();
  return {
    ok: true,
    message:
      res.contentStatus === "PENDING"
        ? "Saved. Your changes are back in review."
        : "Saved as a draft.",
  };
}

export async function submitSellerProfileAction(
  _prev: SellerSettingsActionState,
  formData: FormData,
): Promise<SellerSettingsActionState> {
  void formData; // no form fields — a pure DRAFT -> PENDING transition
  const { ctx } = await requireSellerSessionPermission("manage_seller_settings");

  const res = await submitSellerProfile(ctx);
  if (!res.ok) return fromRepoError(res);

  await writeAudit({
    actorUserId: ctx.userId,
    action: "seller.profile.submitted",
    targetType: "seller",
    targetId: ctx.sellerId,
    summary: `seller ${ctx.sellerName} submitted its store profile for review`,
    meta: { sellerId: ctx.sellerId, contentStatus: res.contentStatus },
  });

  revalidateSeller();
  return {
    ok: true,
    message:
      res.contentStatus === "PENDING"
        ? "Submitted for review. An Axiaro admin will approve it."
        : "Nothing to submit.",
  };
}

// ---------------------------------------------------------------------------
// Logo / banner
// ---------------------------------------------------------------------------

const imageSchema = z.object({
  slot: z.enum(["logo", "banner"]),
  mediaId: z.string().max(64).optional().or(z.literal("")),
});

export async function setSellerImageAction(
  _prev: SellerSettingsActionState,
  formData: FormData,
): Promise<SellerSettingsActionState> {
  const { ctx } = await requireSellerSessionPermission("manage_seller_settings");
  const parsed = imageSchema.safeParse({
    slot: formData.get("slot"),
    mediaId: formData.get("mediaId") ?? "",
  });
  if (!parsed.success) return { error: "Invalid request." };

  const mediaId = parsed.data.mediaId && parsed.data.mediaId.length > 0 ? parsed.data.mediaId : null;
  const res = await setSellerProfileImage(ctx, parsed.data.slot, mediaId);
  if (!res.ok) return fromRepoError(res);

  await writeAudit({
    actorUserId: ctx.userId,
    action: "seller.profile.image",
    targetType: "seller",
    targetId: ctx.sellerId,
    summary: `seller ${ctx.sellerName} ${mediaId ? "set" : "cleared"} its ${parsed.data.slot} (now ${res.contentStatus})`,
    meta: { sellerId: ctx.sellerId, slot: parsed.data.slot, mediaId, contentStatus: res.contentStatus },
  });

  revalidateSeller();
  return { ok: true, message: mediaId ? `${parsed.data.slot === "logo" ? "Logo" : "Banner"} updated.` : "Cleared." };
}

// ---------------------------------------------------------------------------
// Media library
// ---------------------------------------------------------------------------

export async function uploadSellerMediaAction(
  _prev: SellerSettingsActionState,
  formData: FormData,
): Promise<SellerSettingsActionState> {
  const { ctx } = await requireSellerSessionPermission("manage_seller_settings");

  const file = formData.get("file");
  if (!(file instanceof File)) return { error: "Choose a file to upload." };
  const alt = String(formData.get("alt") ?? "");

  const res = await uploadSellerMedia(ctx, { file, alt });
  if (!res.ok) return fromRepoError(res);

  await writeAudit({
    actorUserId: ctx.userId,
    action: "seller.media.upload",
    targetType: "media",
    targetId: res.asset.id,
    summary: `seller ${ctx.sellerName} uploaded ${res.asset.filename}`,
    meta: { sellerId: ctx.sellerId, filename: res.asset.filename, mimeType: res.asset.mimeType, sizeBytes: res.asset.sizeBytes },
  });

  revalidateSeller();
  return { ok: true, message: `Uploaded ${res.asset.filename}.` };
}

const deleteSchema = z.object({ id: z.string().min(1).max(64) });

export async function deleteSellerMediaAction(
  _prev: SellerSettingsActionState,
  formData: FormData,
): Promise<SellerSettingsActionState> {
  const { ctx } = await requireSellerSessionPermission("manage_seller_settings");
  const parsed = deleteSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) return { error: "Invalid request." };

  const res = await deleteSellerMedia(ctx, parsed.data.id);
  if (!res.ok) return fromRepoError(res);

  await writeAudit({
    actorUserId: ctx.userId,
    action: "seller.media.delete",
    targetType: "media",
    targetId: parsed.data.id,
    summary: `seller ${ctx.sellerName} deleted a media file`,
    meta: { sellerId: ctx.sellerId, id: parsed.data.id },
  });

  revalidateSeller();
  return { ok: true, message: "File deleted." };
}

// ---------------------------------------------------------------------------
// Operational contact (immediate, not moderated)
// ---------------------------------------------------------------------------

const contactSchema = z.object({
  supportEmail: z.string().trim().max(200),
  notifyEmail: z.string().trim().max(200).optional().or(z.literal("")),
});

export async function saveSellerContactAction(
  _prev: SellerSettingsActionState,
  formData: FormData,
): Promise<SellerSettingsActionState> {
  const { ctx } = await requireSellerSessionPermission("manage_seller_settings");
  const parsed = contactSchema.safeParse({
    supportEmail: formData.get("supportEmail") ?? "",
    notifyEmail: formData.get("notifyEmail") ?? "",
  });
  if (!parsed.success) return { error: "Please check the highlighted fields." };

  const res = await updateSellerContact(ctx, {
    supportEmail: parsed.data.supportEmail,
    notifyEmail: parsed.data.notifyEmail ?? null,
  });
  if (!res.ok) return fromRepoError(res);

  await writeAudit({
    actorUserId: ctx.userId,
    action: "seller.contact.saved",
    targetType: "seller",
    targetId: ctx.sellerId,
    summary: `seller ${ctx.sellerName} updated its contact settings`,
    meta: { sellerId: ctx.sellerId },
  });

  revalidateSeller();
  return { ok: true, message: "Contact settings saved." };
}
