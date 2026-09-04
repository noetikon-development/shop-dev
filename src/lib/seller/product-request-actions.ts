"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireSellerSessionPermission } from "@/lib/seller/session";
import { writeAudit } from "@/lib/admin/audit";
import { uploadSellerMedia } from "@/lib/marketplace/seller-media-repository";
import {
  createSellerRequest,
  updateSellerRequest,
  submitSellerRequest,
  attachRequestImage,
  detachRequestImage,
  type SellerRequestError,
  type ProposedVariant,
  type ProposedOption,
  type DuplicateBlock,
  type DuplicateWarning,
} from "@/lib/marketplace/seller-product-request-repository";
import { sendSellerProductRequestSubmitted } from "@/lib/email/notifications";
import { scheduleEmail } from "@/lib/email/schedule";

/**
 * `/seller/product-requests` server actions (Phase 9F-5b).
 *
 * Reuses the `manage_offers` permission (a product request is part of the
 * listing workflow — the 9F-5 audit confirmed no new permission is needed).
 * `requireSellerSessionPermission` already gates on an APPROVED seller + ACTIVE
 * membership, so a SUSPENDED / CLOSED seller can never reach these.
 *
 * These actions NEVER write `Product` / `Variant` / `Category` / `ProductImage` /
 * `Offer` / `OfferInventory` / `Inventory`, and never revalidate the storefront.
 */

export type SellerRequestActionState = {
  ok?: boolean;
  error?: string;
  message?: string;
  fieldErrors?: Record<string, string>;
  blocks?: DuplicateBlock[];
  warnings?: DuplicateWarning[];
};

function fromError(e: SellerRequestError): SellerRequestActionState {
  return e.code === "BLOCKED" ? { error: e.error, blocks: e.blocks } : { error: e.error };
}

const fieldsSchema = z.object({
  proposedName: z.string().trim().min(2).max(160),
  proposedBrand: z.string().trim().max(80).optional(),
  proposedShortDesc: z.string().trim().max(400).optional(),
  proposedDescription: z.string().trim().max(9000).optional(),
  proposedCategoryId: z.string().trim().max(64).optional(),
  categoryNote: z.string().trim().max(600).optional(),
  barcode: z.string().trim().max(20).optional(),
  sellerNote: z.string().trim().max(2200).optional(),
});

/** Parse `option.<i>.name` + `option.<i>.values` (newline / comma separated). */
function parseOptionForm(formData: FormData): ProposedOption[] {
  const idx = new Set<number>();
  for (const key of formData.keys()) {
    const m = key.match(/^option\.(\d+)\./);
    if (m) idx.add(Number(m[1]));
  }
  const out: ProposedOption[] = [];
  for (const i of [...idx].sort((a, b) => a - b)) {
    const name = String(formData.get(`option.${i}.name`) ?? "").trim();
    const values = [
      ...new Set(
        String(formData.get(`option.${i}.values`) ?? "")
          .split(/[\n,]/)
          .map((v) => v.trim())
          .filter(Boolean),
      ),
    ];
    if (!name && values.length === 0) continue;
    out.push({ name, values });
  }
  return out;
}

/**
 * Parse `variant.<i>.<field>` flat form entries into a ProposedVariant[].
 * `variant.<i>.optionValue.<Option Name>` entries become the structured map.
 */
function parseVariantForm(formData: FormData): ProposedVariant[] {
  const idx = new Set<number>();
  for (const key of formData.keys()) {
    const m = key.match(/^variant\.(\d+)\./);
    if (m) idx.add(Number(m[1]));
  }
  const out: ProposedVariant[] = [];
  for (const i of [...idx].sort((a, b) => a - b)) {
    const label = String(formData.get(`variant.${i}.label`) ?? "").trim();
    if (!label) continue;
    const optionValues: Record<string, string> = {};
    for (const [key, val] of formData.entries()) {
      const m = key.match(new RegExp(`^variant\\.${i}\\.optionValue\\.(.+)$`));
      if (m && String(val).trim()) optionValues[m[1]] = String(val).trim();
    }
    out.push({
      label,
      proposedSku: String(formData.get(`variant.${i}.sku`) ?? "").trim() || null,
      barcode: String(formData.get(`variant.${i}.barcode`) ?? "").trim() || null,
      optionValues: Object.keys(optionValues).length ? optionValues : null,
    });
  }
  return out;
}

function readFields(formData: FormData) {
  const s = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    return v === "" ? undefined : v;
  };
  return fieldsSchema.safeParse({
    proposedName: s("proposedName") ?? "",
    proposedBrand: s("proposedBrand"),
    proposedShortDesc: s("proposedShortDesc"),
    proposedDescription: s("proposedDescription"),
    proposedCategoryId: s("proposedCategoryId"),
    categoryNote: s("categoryNote"),
    barcode: s("barcode"),
    sellerNote: s("sellerNote"),
  });
}

function revalidate(requestId?: string) {
  revalidatePath("/seller/product-requests");
  if (requestId) revalidatePath(`/seller/product-requests/${requestId}`);
  revalidatePath("/seller");
}

// ---------------------------------------------------------------------------
// Create / edit
// ---------------------------------------------------------------------------

export async function createRequestAction(
  _prev: SellerRequestActionState,
  formData: FormData,
): Promise<SellerRequestActionState> {
  const { ctx } = await requireSellerSessionPermission("manage_offers");
  const parsed = readFields(formData);
  if (!parsed.success) return { error: "Please check the highlighted fields." };

  const res = await createSellerRequest(ctx, {
    proposedName: parsed.data.proposedName,
    proposedBrand: parsed.data.proposedBrand ?? null,
    proposedShortDesc: parsed.data.proposedShortDesc ?? null,
    proposedDescription: parsed.data.proposedDescription ?? null,
    proposedCategoryId: parsed.data.proposedCategoryId ?? null,
    categoryNote: parsed.data.categoryNote ?? null,
    barcode: parsed.data.barcode ?? null,
    proposedOptions: parseOptionForm(formData),
    proposedVariants: parseVariantForm(formData),
    sellerNote: parsed.data.sellerNote ?? null,
  });
  if (!res.ok) return fromError(res);

  revalidate(res.requestId);
  redirect(`/seller/product-requests/${res.requestId}`);
}

export async function updateRequestAction(
  _prev: SellerRequestActionState,
  formData: FormData,
): Promise<SellerRequestActionState> {
  const { ctx } = await requireSellerSessionPermission("manage_offers");
  const requestId = String(formData.get("requestId") ?? "");
  if (!requestId) return { error: "Missing request." };

  const parsed = readFields(formData);
  if (!parsed.success) return { error: "Please check the highlighted fields." };

  const res = await updateSellerRequest(ctx, requestId, {
    proposedName: parsed.data.proposedName,
    proposedBrand: parsed.data.proposedBrand ?? null,
    proposedShortDesc: parsed.data.proposedShortDesc ?? null,
    proposedDescription: parsed.data.proposedDescription ?? null,
    proposedCategoryId: parsed.data.proposedCategoryId ?? null,
    categoryNote: parsed.data.categoryNote ?? null,
    barcode: parsed.data.barcode ?? null,
    proposedOptions: parseOptionForm(formData),
    proposedVariants: parseVariantForm(formData),
    sellerNote: parsed.data.sellerNote ?? null,
  });
  if (!res.ok) return fromError(res);

  revalidate(requestId);
  return { ok: true, message: "Draft saved." };
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

export async function submitRequestAction(
  _prev: SellerRequestActionState,
  formData: FormData,
): Promise<SellerRequestActionState> {
  const { ctx } = await requireSellerSessionPermission("manage_offers");
  const requestId = String(formData.get("requestId") ?? "");
  if (!requestId) return { error: "Missing request." };

  const res = await submitSellerRequest(ctx, requestId);
  if (!res.ok) return fromError(res);

  await writeAudit({
    actorUserId: ctx.userId,
    action: "seller.product_request.submitted",
    targetType: "seller_product_request",
    targetId: requestId,
    summary: `seller ${ctx.sellerName} submitted product request ${requestId}`,
    meta: { sellerId: ctx.sellerId, requestId, warnings: res.warnings.map((w) => w.message) },
  });

  // 9F-5c Part 11 — one "submitted for review" acknowledgement to the seller.
  scheduleEmail(() => sendSellerProductRequestSubmitted(requestId));

  revalidate(requestId);
  return {
    ok: true,
    message:
      res.warnings.length > 0
        ? "Submitted for review. Axiaro flagged a few possible matches — they'll check."
        : "Submitted for review. An Axiaro admin will look at it.",
    warnings: res.warnings,
  };
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export async function uploadRequestImageAction(
  _prev: SellerRequestActionState,
  formData: FormData,
): Promise<SellerRequestActionState> {
  const { ctx } = await requireSellerSessionPermission("manage_offers");
  const requestId = String(formData.get("requestId") ?? "");
  const file = formData.get("file");
  if (!requestId) return { error: "Missing request." };
  if (!(file instanceof File)) return { error: "Choose an image to upload." };

  const uploaded = await uploadSellerMedia(ctx, { file, alt: String(formData.get("alt") ?? "") });
  if (!uploaded.ok) return { error: uploaded.error };

  const attach = await attachRequestImage(ctx, requestId, uploaded.asset.id, {
    role: String(formData.get("role") ?? "gallery"),
  });
  if (!attach.ok) return fromError(attach);

  await writeAudit({
    actorUserId: ctx.userId,
    action: "seller.product_request.image_added",
    targetType: "seller_product_request",
    targetId: requestId,
    summary: `seller ${ctx.sellerName} added an image to product request ${requestId}`,
    meta: { sellerId: ctx.sellerId, requestId, mediaAssetId: uploaded.asset.id },
  });

  revalidate(requestId);
  return { ok: true, message: "Image added." };
}

const detachSchema = z.object({ requestId: z.string().min(1).max(64), imageId: z.string().min(1).max(64) });

export async function detachRequestImageAction(
  _prev: SellerRequestActionState,
  formData: FormData,
): Promise<SellerRequestActionState> {
  const { ctx } = await requireSellerSessionPermission("manage_offers");
  const parsed = detachSchema.safeParse({
    requestId: formData.get("requestId"),
    imageId: formData.get("imageId"),
  });
  if (!parsed.success) return { error: "Invalid request." };

  const res = await detachRequestImage(ctx, parsed.data.requestId, parsed.data.imageId);
  if (!res.ok) return fromError(res);

  revalidate(parsed.data.requestId);
  return { ok: true, message: "Image removed." };
}
