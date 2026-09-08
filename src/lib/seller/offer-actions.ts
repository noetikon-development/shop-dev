"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireSellerSessionPermission } from "@/lib/seller/session";
import { writeAudit } from "@/lib/admin/audit";
import { scheduleEmail } from "@/lib/email/schedule";
import { sendSellerOfferPublishedOps } from "@/lib/email/notifications";
import {
  createSellerOffer,
  updateSellerOffer,
  setSellerOfferStatus,
  adjustOfferStock,
  setSellerOfferReorderPoint,
  type SellerRepoError,
} from "@/lib/marketplace/seller-repository";

/**
 * `/seller` server actions.
 *
 * Every action re-establishes the seller session + permission server-side
 * (`requireSellerSessionPermission`) — the browser never passes a sellerId, and
 * the repository re-checks row ownership inside its transaction. A seller can
 * only ever mutate their own Offer / OfferInventory.
 *
 * 9F-24A: a `→ ACTIVE` (publish) or `ACTIVE → …` (unpublish) status change DOES
 * change what buyers see, so `setOfferStatusAction` revalidates the storefront
 * product cache for those transitions. Every other seller action still leaves
 * the storefront untouched.
 *
 * 9F-24D (P0-2 / P1-7): every real offer status transition writes one
 * `adminAuditLog` row ("who moved which listing from X to Y, when"), and a
 * `→ ACTIVE` publish also queues one ops notification so Axiaro knows a 3P
 * listing went live. Both are best-effort and never block the seller's action.
 */

export type SellerActionState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  ok?: boolean;
  message?: string;
};

function fromRepoError(e: SellerRepoError): SellerActionState {
  return { error: e.error };
}

/** parse "₱1,234.50" / "1234.5" / "1234" → integer centavos, or null. */
function parsePesosToCentavos(raw: FormDataEntryValue | null): number | null {
  if (raw == null) return null;
  const s = String(raw).replace(/[₱,\s]/g, "").trim();
  if (s === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN as unknown as number;
  return Math.round(parseFloat(s) * 100);
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

const createSchema = z.object({
  variantId: z.string().min(1, "Choose a catalog product option"),
  condition: z.enum(["NEW", "REFURBISHED", "OPEN_BOX", "USED_LIKE_NEW", "USED_GOOD"]).default("NEW"),
  sellerSku: z.string().trim().max(64).optional().or(z.literal("")),
  handlingTimeDays: z.coerce.number().int().min(0).max(30).default(2),
  openingQuantity: z.coerce.number().int().min(0).max(1_000_000).default(0),
  reorderPoint: z.coerce.number().int().min(0).max(1_000_000).default(3),
});

export async function createOfferAction(
  _prev: SellerActionState,
  formData: FormData,
): Promise<SellerActionState> {
  const { ctx } = await requireSellerSessionPermission("manage_offers");

  const price = parsePesosToCentavos(formData.get("price"));
  const compareRaw = formData.get("compareAtPrice");
  const compareAtPrice =
    compareRaw == null || String(compareRaw).trim() === "" ? null : parsePesosToCentavos(compareRaw);

  if (price == null || Number.isNaN(price)) {
    return { fieldErrors: { price: "Enter a price like 1299 or 1299.00" } };
  }
  if (compareAtPrice !== null && Number.isNaN(compareAtPrice)) {
    return { fieldErrors: { compareAtPrice: "Enter an amount like 1499 or leave blank" } };
  }

  const parsed = createSchema.safeParse({
    variantId: formData.get("variantId"),
    condition: formData.get("condition") ?? "NEW",
    sellerSku: formData.get("sellerSku") ?? "",
    handlingTimeDays: formData.get("handlingTimeDays") ?? 2,
    openingQuantity: formData.get("openingQuantity") ?? 0,
    reorderPoint: formData.get("reorderPoint") ?? 3,
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const i of parsed.error.issues) fieldErrors[String(i.path[0])] = i.message;
    return { fieldErrors };
  }

  const res = await createSellerOffer(ctx, {
    variantId: parsed.data.variantId,
    price,
    compareAtPrice,
    condition: parsed.data.condition,
    sellerSku: parsed.data.sellerSku || null,
    handlingTimeDays: parsed.data.handlingTimeDays,
    openingQuantity: parsed.data.openingQuantity,
    reorderPoint: parsed.data.reorderPoint,
  });
  if (!res.ok) return fromRepoError(res);

  revalidatePath("/seller/offers");
  revalidatePath("/seller");
  redirect(`/seller/offers/${res.offerId}`);
}

// ---------------------------------------------------------------------------
// Edit commercials / price
// ---------------------------------------------------------------------------

export async function updateOfferAction(
  _prev: SellerActionState,
  formData: FormData,
): Promise<SellerActionState> {
  const { ctx } = await requireSellerSessionPermission("manage_offers");
  const offerId = String(formData.get("offerId") ?? "");
  if (!offerId) return { error: "Missing offer." };

  const price = parsePesosToCentavos(formData.get("price"));
  const compareRaw = formData.get("compareAtPrice");
  const compareProvided = compareRaw != null;
  const compareAtPrice =
    !compareProvided || String(compareRaw).trim() === "" ? null : parsePesosToCentavos(compareRaw);

  if (price == null || Number.isNaN(price)) {
    return { fieldErrors: { price: "Enter a price like 1299 or 1299.00" } };
  }
  if (compareAtPrice !== null && Number.isNaN(compareAtPrice)) {
    return { fieldErrors: { compareAtPrice: "Enter an amount like 1499 or leave blank" } };
  }

  const schema = z.object({
    sellerSku: z.string().trim().max(64).optional().or(z.literal("")),
    handlingTimeDays: z.coerce.number().int().min(0).max(30),
    condition: z.enum(["NEW", "REFURBISHED", "OPEN_BOX", "USED_LIKE_NEW", "USED_GOOD"]),
  });
  const parsed = schema.safeParse({
    sellerSku: formData.get("sellerSku") ?? "",
    handlingTimeDays: formData.get("handlingTimeDays") ?? 2,
    condition: formData.get("condition") ?? "NEW",
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const i of parsed.error.issues) fieldErrors[String(i.path[0])] = i.message;
    return { fieldErrors };
  }

  const res = await updateSellerOffer(ctx, offerId, {
    price,
    compareAtPrice,
    sellerSku: parsed.data.sellerSku || null,
    handlingTimeDays: parsed.data.handlingTimeDays,
    condition: parsed.data.condition,
  });
  if (!res.ok) return fromRepoError(res);

  revalidatePath(`/seller/offers/${offerId}`);
  revalidatePath("/seller/offers");
  return { ok: true, message: "Offer updated." };
}

// ---------------------------------------------------------------------------
// Status — DRAFT ↔ INACTIVE ↔ ACTIVE, or → ARCHIVED (terminal). A `→ ACTIVE`
// (publish) transition is gated by `setSellerOfferStatus`'s double-lock +
// publish-readiness check (9F-8c / 9F-24A). ARCHIVED can't be reactivated.
// ---------------------------------------------------------------------------

const statusSchema = z.object({
  offerId: z.string().min(1),
  status: z.enum(["DRAFT", "ACTIVE", "INACTIVE", "ARCHIVED"]),
});

export async function setOfferStatusAction(
  _prev: SellerActionState,
  formData: FormData,
): Promise<SellerActionState> {
  const { ctx } = await requireSellerSessionPermission("manage_offers");
  const parsed = statusSchema.safeParse({
    offerId: formData.get("offerId"),
    status: formData.get("status"),
  });
  if (!parsed.success) return { error: "Invalid request." };

  const res = await setSellerOfferStatus(ctx, parsed.data.offerId, parsed.data.status);
  if (!res.ok) return fromRepoError(res);

  revalidatePath(`/seller/offers/${parsed.data.offerId}`);
  revalidatePath("/seller/offers");
  revalidatePath("/seller");
  // 9F-24A: only bust the storefront cache when buy-box visibility actually
  // changed (offer was ACTIVE, or is now ACTIVE).
  if (res.storefrontAffected) {
    revalidateTag("products", "max");
    revalidateTag("categories", "max");
  }

  // 9F-24D (P0-2): audit the transition. `previousStatus === newStatus` is a
  // no-op (the seller re-submitted the status it already had) — nothing to log.
  if (res.previousStatus !== res.newStatus) {
    const auditId = await writeAudit({
      actorUserId: ctx.userId,
      action: "seller_offer.status_changed",
      targetType: "offer",
      targetId: parsed.data.offerId,
      summary: `${ctx.sellerName} moved listing "${res.productName}" (${res.variantSku}) ${res.previousStatus} → ${res.newStatus}`,
      meta: {
        actor: "seller",
        sellerId: ctx.sellerId,
        offerId: parsed.data.offerId,
        variantId: res.variantId,
        from: res.previousStatus,
        to: res.newStatus,
        storefrontAffected: res.storefrontAffected,
      },
    });
    // 9F-24D (P1-7): a listing going live is worth an ops heads-up. The audit
    // row id anchors the idempotency key (never `Offer.updatedAt`, which this
    // very write also bumps). The sender no-ops for a FIRST_PARTY offer.
    if (res.newStatus === "ACTIVE" && auditId) {
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

// ---------------------------------------------------------------------------
// OfferInventory
// ---------------------------------------------------------------------------

const SELLER_STOCK_REASONS = [
  "RESTOCK",
  "MANUAL_ADJUSTMENT",
  "DAMAGE",
  "LOSS",
  "CORRECTION",
] as const;

const adjustSchema = z.object({
  offerId: z.string().min(1),
  mode: z.enum(["increase", "decrease", "set"]),
  amount: z.coerce.number().int().min(0).max(1_000_000),
  reason: z.enum(SELLER_STOCK_REASONS),
  note: z.string().trim().max(300).optional().or(z.literal("")),
  currentQuantity: z.coerce.number().int().min(0),
});

export async function adjustOfferStockAction(
  _prev: SellerActionState,
  formData: FormData,
): Promise<SellerActionState> {
  const { ctx } = await requireSellerSessionPermission("manage_offer_inventory");
  const parsed = adjustSchema.safeParse({
    offerId: formData.get("offerId"),
    mode: formData.get("mode"),
    amount: formData.get("amount"),
    reason: formData.get("reason"),
    note: formData.get("note") ?? "",
    currentQuantity: formData.get("currentQuantity"),
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const i of parsed.error.issues) fieldErrors[String(i.path[0])] = i.message;
    return { fieldErrors };
  }
  const { offerId, mode, amount, reason, note, currentQuantity } = parsed.data;

  const delta =
    mode === "increase" ? amount : mode === "decrease" ? -amount : amount - currentQuantity;
  if (delta === 0) return { ok: true, message: "No change." };

  const res = await adjustOfferStock(ctx, offerId, delta, reason, note || null);
  if (!res.ok) return fromRepoError(res);

  revalidatePath(`/seller/offers/${offerId}`);
  revalidatePath("/seller/offers");
  revalidatePath("/seller");
  return { ok: true, message: `Stock updated to ${res.newQuantity}.` };
}

const reorderSchema = z.object({
  offerId: z.string().min(1),
  reorderPoint: z.coerce.number().int().min(0).max(1_000_000),
});

export async function setOfferReorderPointAction(
  _prev: SellerActionState,
  formData: FormData,
): Promise<SellerActionState> {
  const { ctx } = await requireSellerSessionPermission("manage_offer_inventory");
  const parsed = reorderSchema.safeParse({
    offerId: formData.get("offerId"),
    reorderPoint: formData.get("reorderPoint"),
  });
  if (!parsed.success) return { fieldErrors: { reorderPoint: "Enter a whole number ≥ 0" } };

  const res = await setSellerOfferReorderPoint(ctx, parsed.data.offerId, parsed.data.reorderPoint);
  if (!res.ok) return fromRepoError(res);

  revalidatePath(`/seller/offers/${parsed.data.offerId}`);
  return { ok: true, message: "Reorder point saved." };
}
