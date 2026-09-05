"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requirePermission } from "@/lib/admin/rbac";
import { writeAudit } from "@/lib/admin/audit";
import { scheduleEmail } from "@/lib/email/schedule";
import {
  sendSellerAccountApproved,
  sendSellerAccountSuspended,
  sendSellerAccountClosed,
} from "@/lib/email/notifications";
import {
  createSeller,
  transitionSellerStatus,
  updateSellerConfig,
  type AdminSellerError,
} from "@/lib/admin/sellers/repository";
import {
  addSellerUserByEmail,
  setSellerUserRole,
  setSellerUserStatus,
  type SellerUserError,
} from "@/lib/admin/sellers/seller-users";
import { SELLER_STATUSES, sellerTransitionAction } from "@/lib/admin/sellers/lifecycle";

/**
 * Admin Seller Management server actions — Phase 9F-4b.
 *
 * PERMISSION: every lifecycle / config / membership mutation requires
 * `manage_settings` (currently SUPER_ADMIN-only; a store-configuration
 * permission an org can delegate later). NO new permission was added and
 * `src/lib/rbac/catalog.ts` / `scripts/seed-rbac.ts` are untouched.
 *
 * Seller-profile CONTENT approval/rejection is NOT here — it stays in
 * `src/lib/admin/seller-content-actions.ts` under `manage_content` (9F-4a).
 *
 * Every mutation writes exactly one `adminAuditLog` row via `writeAudit`. None
 * revalidate the storefront, and none write `Offer` / `OfferInventory` /
 * `Inventory` / `InventoryAdjustment` / `Variant` / `Product` / `StoreSetting`.
 */

export type SellerAdminActionState = {
  ok?: boolean;
  error?: string;
  message?: string;
};

function fromError(e: AdminSellerError | SellerUserError | { ok: false; code: string; error: string }): SellerAdminActionState {
  return { error: e.error };
}

function revalidateSeller(sellerId?: string) {
  revalidatePath("/admin/sellers");
  if (sellerId) revalidatePath(`/admin/sellers/${sellerId}`);
  revalidatePath("/admin/audit");
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

const createSchema = z.object({
  displayName: z.string().trim().min(2).max(80),
  slug: z.string().trim().min(3).max(40),
  supportEmail: z.string().trim().max(200),
  commissionRate: z.coerce.number().int().min(0).max(10000).optional(),
});

export async function createSellerAction(
  _prev: SellerAdminActionState,
  formData: FormData,
): Promise<SellerAdminActionState> {
  const admin = await requirePermission("manage_settings");
  const parsed = createSchema.safeParse({
    displayName: formData.get("displayName"),
    slug: formData.get("slug"),
    supportEmail: formData.get("supportEmail"),
    commissionRate: formData.get("commissionRate") ?? undefined,
  });
  if (!parsed.success) return { error: "Please check the highlighted fields." };

  const res = await createSeller({
    displayName: parsed.data.displayName,
    slug: parsed.data.slug,
    supportEmail: parsed.data.supportEmail,
    commissionRate: parsed.data.commissionRate,
  });
  if (!res.ok) return fromError(res);

  await writeAudit({
    actorUserId: admin.user.id,
    action: "seller.created",
    targetType: "seller",
    targetId: res.sellerId,
    summary: `${admin.user.email} created seller ${res.displayName} (/${res.slug}, PENDING)`,
    meta: { sellerId: res.sellerId, slug: res.slug, commissionRate: res.commissionRate, type: "THIRD_PARTY" },
  });

  revalidateSeller(res.sellerId);
  redirect(`/admin/sellers/${res.sellerId}`);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const transitionSchema = z.object({
  sellerId: z.string().min(1).max(64),
  to: z.enum(SELLER_STATUSES),
});

export async function transitionSellerAction(
  _prev: SellerAdminActionState,
  formData: FormData,
): Promise<SellerAdminActionState> {
  const admin = await requirePermission("manage_settings");
  const parsed = transitionSchema.safeParse({ sellerId: formData.get("sellerId"), to: formData.get("to") });
  if (!parsed.success) return { error: "Invalid request." };

  const res = await transitionSellerStatus(parsed.data.sellerId, parsed.data.to);
  if (!res.ok) return fromError(res);

  if (res.from !== res.to) {
    const auditLogId = await writeAudit({
      actorUserId: admin.user.id,
      action: res.reactivate ? "seller.reactivated" : sellerTransitionAction(res.to),
      targetType: "seller",
      targetId: res.sellerId,
      summary: `${admin.user.email} moved seller ${res.displayName} ${res.from} → ${res.to}`,
      meta: { sellerId: res.sellerId, from: res.from, to: res.to },
    });

    // Notify the seller — never blocking the response on SMTP delivery. The
    // audit row's own id anchors the idempotency key (never `Seller.updatedAt`,
    // which an unrelated config edit also bumps).
    if (auditLogId) {
      if (res.to === "APPROVED") {
        scheduleEmail(() => sendSellerAccountApproved(res.sellerId, auditLogId));
      } else if (res.to === "SUSPENDED") {
        scheduleEmail(() => sendSellerAccountSuspended(res.sellerId, auditLogId));
      } else if (res.to === "CLOSED") {
        scheduleEmail(() => sendSellerAccountClosed(res.sellerId, auditLogId));
      }
    }
  }

  revalidateSeller(parsed.data.sellerId);
  return { ok: true, message: `Seller moved to ${parsed.data.to}.` };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const configSchema = z.object({
  sellerId: z.string().min(1).max(64),
  displayName: z.string().trim().max(80).optional(),
  supportEmail: z.string().trim().max(200).optional(),
  notifyEmail: z.string().trim().max(200).optional().or(z.literal("")),
  commissionRate: z.coerce.number().int().min(0).max(10000).optional(),
  slug: z.string().trim().max(40).optional(),
});

export async function updateSellerConfigAction(
  _prev: SellerAdminActionState,
  formData: FormData,
): Promise<SellerAdminActionState> {
  const admin = await requirePermission("manage_settings");
  const parsed = configSchema.safeParse({
    sellerId: formData.get("sellerId"),
    displayName: formData.get("displayName") ?? undefined,
    supportEmail: formData.get("supportEmail") ?? undefined,
    notifyEmail: formData.get("notifyEmail") ?? undefined,
    commissionRate: formData.get("commissionRate") ?? undefined,
    slug: formData.get("slug") ?? undefined,
  });
  if (!parsed.success) return { error: "Please check the highlighted fields." };

  const res = await updateSellerConfig(parsed.data.sellerId, {
    displayName: parsed.data.displayName,
    supportEmail: parsed.data.supportEmail,
    notifyEmail: parsed.data.notifyEmail === undefined ? undefined : parsed.data.notifyEmail || null,
    commissionRate: parsed.data.commissionRate,
    slug: parsed.data.slug,
  });
  if (!res.ok) return fromError(res);

  if (Object.keys(res.changes).length > 0) {
    await writeAudit({
      actorUserId: admin.user.id,
      action: "seller.updated",
      targetType: "seller",
      targetId: res.sellerId,
      summary: `${admin.user.email} updated seller ${res.displayName} (${Object.keys(res.changes).join(", ")})`,
      meta: { sellerId: res.sellerId, changes: res.changes, previousSlug: res.previousSlug },
    });
  }

  revalidateSeller(parsed.data.sellerId);
  return { ok: true, message: "Seller updated." };
}

// ---------------------------------------------------------------------------
// Seller users
// ---------------------------------------------------------------------------

const addUserSchema = z.object({
  sellerId: z.string().min(1).max(64),
  email: z.string().trim().max(200),
  role: z.enum(["OWNER", "MANAGER", "STAFF"]),
});

export async function addSellerUserAction(
  _prev: SellerAdminActionState,
  formData: FormData,
): Promise<SellerAdminActionState> {
  const admin = await requirePermission("manage_settings");
  const parsed = addUserSchema.safeParse({
    sellerId: formData.get("sellerId"),
    email: formData.get("email"),
    role: formData.get("role"),
  });
  if (!parsed.success) return { error: "Please check the highlighted fields." };

  const res = await addSellerUserByEmail(parsed.data.sellerId, parsed.data.email, parsed.data.role);
  if (!res.ok) return fromError(res);

  await writeAudit({
    actorUserId: admin.user.id,
    action: "seller_user.added",
    targetType: "seller_user",
    targetId: res.sellerUserId,
    summary: `${admin.user.email} ${res.verb} ${res.userEmail} to seller ${res.sellerName} as ${res.role}`,
    meta: { sellerId: parsed.data.sellerId, sellerUserId: res.sellerUserId, email: res.userEmail, role: res.role },
  });

  revalidateSeller(parsed.data.sellerId);
  return { ok: true, message: "Member added." };
}

const roleSchema = z.object({
  sellerId: z.string().min(1).max(64),
  sellerUserId: z.string().min(1).max(64),
  role: z.enum(["OWNER", "MANAGER", "STAFF"]),
});

export async function setSellerUserRoleAction(
  _prev: SellerAdminActionState,
  formData: FormData,
): Promise<SellerAdminActionState> {
  const admin = await requirePermission("manage_settings");
  const parsed = roleSchema.safeParse({
    sellerId: formData.get("sellerId"),
    sellerUserId: formData.get("sellerUserId"),
    role: formData.get("role"),
  });
  if (!parsed.success) return { error: "Invalid request." };

  const res = await setSellerUserRole(parsed.data.sellerId, parsed.data.sellerUserId, parsed.data.role);
  if (!res.ok) return fromError(res);

  if (!res.noop) {
    await writeAudit({
      actorUserId: admin.user.id,
      action: "seller_user.role_changed",
      targetType: "seller_user",
      targetId: res.sellerUserId,
      summary: `${admin.user.email} changed ${res.userEmail}'s role on ${res.sellerName}: ${res.from} → ${res.to}`,
      meta: { sellerId: parsed.data.sellerId, sellerUserId: res.sellerUserId, from: res.from, to: res.to },
    });
  }

  revalidateSeller(parsed.data.sellerId);
  return { ok: true, message: "Role updated." };
}

const statusSchema = z.object({
  sellerId: z.string().min(1).max(64),
  sellerUserId: z.string().min(1).max(64),
  status: z.enum(["ACTIVE", "DISABLED"]),
});

export async function setSellerUserStatusAction(
  _prev: SellerAdminActionState,
  formData: FormData,
): Promise<SellerAdminActionState> {
  const admin = await requirePermission("manage_settings");
  const parsed = statusSchema.safeParse({
    sellerId: formData.get("sellerId"),
    sellerUserId: formData.get("sellerUserId"),
    status: formData.get("status"),
  });
  if (!parsed.success) return { error: "Invalid request." };

  const res = await setSellerUserStatus(parsed.data.sellerId, parsed.data.sellerUserId, parsed.data.status);
  if (!res.ok) return fromError(res);

  if (!res.noop) {
    await writeAudit({
      actorUserId: admin.user.id,
      action: parsed.data.status === "DISABLED" ? "seller_user.disabled" : "seller_user.enabled",
      targetType: "seller_user",
      targetId: res.sellerUserId,
      summary: `${admin.user.email} ${parsed.data.status === "DISABLED" ? "disabled" : "enabled"} ${res.userEmail} on ${res.sellerName}`,
      meta: { sellerId: parsed.data.sellerId, sellerUserId: res.sellerUserId, from: res.from, to: res.to },
    });
  }

  revalidateSeller(parsed.data.sellerId);
  return { ok: true, message: parsed.data.status === "DISABLED" ? "Member disabled." : "Member enabled." };
}
