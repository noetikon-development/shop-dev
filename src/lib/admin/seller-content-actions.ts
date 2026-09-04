"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/admin/rbac";
import { writeAudit } from "@/lib/admin/audit";
import { cleanUserText } from "@/lib/ugc";

/**
 * Admin seller store-profile review (Phase 9F-4a).
 *
 * Reuses `manage_content` — NO new permission, `scripts/seed-rbac.ts` is not
 * touched. Only the moderation transitions PENDING → APPROVED (approve) and
 * PENDING → DRAFT (reject / request changes) are possible here. The admin never
 * edits the seller's profile fields in 9F-4a and never touches
 * `type` / `status` / `slug` / `commissionRate` (that is 9F-4b).
 *
 * These actions never revalidate the storefront — nothing renders the seller
 * profile to customers in 9F-4a.
 */

export type SellerReviewActionState = { ok?: boolean; error?: string; message?: string };

const schema = z.object({
  sellerId: z.string().min(1).max(64),
  note: z.string().trim().max(2000).optional().or(z.literal("")),
});

async function loadPending(sellerId: string) {
  return prisma.seller.findUnique({
    where: { id: sellerId },
    select: { id: true, displayName: true, contentStatus: true },
  });
}

export async function approveSellerContentAction(
  _prev: SellerReviewActionState,
  formData: FormData,
): Promise<SellerReviewActionState> {
  const admin = await requirePermission("manage_content");
  const parsed = schema.safeParse({
    sellerId: formData.get("sellerId"),
    note: formData.get("note") ?? "",
  });
  if (!parsed.success) return { error: "Invalid request." };

  const seller = await loadPending(parsed.data.sellerId);
  if (!seller) return { error: "Seller not found." };
  if (seller.contentStatus !== "PENDING") {
    return { error: `This profile is ${seller.contentStatus.toLowerCase()}, not awaiting review.` };
  }

  const note = parsed.data.note ? cleanUserText(parsed.data.note) : null;
  // Status-guarded — a concurrent seller edit that also lands PENDING is fine,
  // but a race that already moved it off PENDING must not be overwritten.
  const advanced = await prisma.seller.updateMany({
    where: { id: seller.id, contentStatus: "PENDING" },
    data: {
      contentStatus: "APPROVED",
      contentReviewedAt: new Date(),
      contentReviewedBy: admin.user.id,
      contentReviewNote: note,
    },
  });
  if (advanced.count === 0) return { error: "The profile changed while you were reviewing it. Reload and try again." };

  await writeAudit({
    actorUserId: admin.user.id,
    action: "seller.content.approved",
    targetType: "seller",
    targetId: seller.id,
    summary: `${admin.user.email} approved ${seller.displayName}'s store profile`,
    meta: { sellerId: seller.id, from: "PENDING", to: "APPROVED", note },
  });

  revalidatePath("/admin/sellers");
  revalidatePath(`/admin/sellers/${seller.id}`);
  revalidatePath("/seller/settings");
  return { ok: true, message: `Approved ${seller.displayName}'s profile.` };
}

export async function rejectSellerContentAction(
  _prev: SellerReviewActionState,
  formData: FormData,
): Promise<SellerReviewActionState> {
  const admin = await requirePermission("manage_content");
  const parsed = schema.safeParse({
    sellerId: formData.get("sellerId"),
    note: formData.get("note") ?? "",
  });
  if (!parsed.success) return { error: "Invalid request." };

  const note = parsed.data.note ? cleanUserText(parsed.data.note) : "";
  if (!note) return { error: "Add a note so the seller knows what to change." };

  const seller = await loadPending(parsed.data.sellerId);
  if (!seller) return { error: "Seller not found." };
  if (seller.contentStatus !== "PENDING") {
    return { error: `This profile is ${seller.contentStatus.toLowerCase()}, not awaiting review.` };
  }

  const advanced = await prisma.seller.updateMany({
    where: { id: seller.id, contentStatus: "PENDING" },
    data: {
      contentStatus: "DRAFT",
      contentReviewedAt: new Date(),
      contentReviewedBy: admin.user.id,
      contentReviewNote: note,
    },
  });
  if (advanced.count === 0) return { error: "The profile changed while you were reviewing it. Reload and try again." };

  await writeAudit({
    actorUserId: admin.user.id,
    action: "seller.content.rejected",
    targetType: "seller",
    targetId: seller.id,
    summary: `${admin.user.email} requested changes to ${seller.displayName}'s store profile`,
    meta: { sellerId: seller.id, from: "PENDING", to: "DRAFT", note },
  });

  revalidatePath("/admin/sellers");
  revalidatePath(`/admin/sellers/${seller.id}`);
  revalidatePath("/seller/settings");
  return { ok: true, message: "Changes requested. The seller can revise and resubmit." };
}
