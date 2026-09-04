"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireSellerSessionPermission } from "@/lib/seller/session";
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
 * None of these revalidate `products` / touch the storefront: a seller offer
 * never reaches `status = "ACTIVE"` in 9F-1, so it is never buy-box-eligible and
 * the storefront output cannot change.
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
  condition: z.enum(["NEW", "REFURBISHED", "USED_LIKE_NEW", "USED_GOOD"]).default("NEW"),
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
    condition: z.enum(["NEW", "REFURBISHED", "USED_LIKE_NEW", "USED_GOOD"]),
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
// Status — DRAFT ↔ INACTIVE, or → ARCHIVED. Never → ACTIVE (9F-1 gate).
// ---------------------------------------------------------------------------

const statusSchema = z.object({
  offerId: z.string().min(1),
  status: z.enum(["DRAFT", "INACTIVE", "ARCHIVED"]),
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
  const verb =
    parsed.data.status === "INACTIVE" ? "deactivated" : parsed.data.status === "ARCHIVED" ? "archived" : "moved to draft";
  return { ok: true, message: `Offer ${verb}.` };
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
