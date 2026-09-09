"use server";

import { revalidatePath } from "next/cache";
import { revalidateTag } from "next/cache";
import { z } from "zod";
import { requirePermission } from "@/lib/admin/rbac";
import { writeAudit } from "@/lib/admin/audit";
import { scheduleEmail } from "@/lib/email/schedule";
import {
  sendSellerProductRequestApproved,
  sendSellerProductRequestRejected,
} from "@/lib/email/notifications";
import {
  requestChanges,
  rejectRequest,
  linkExistingProduct,
} from "@/lib/admin/seller-product-requests/repository";
import {
  approveByCreatingProduct,
  seedSellerDraftOffers,
} from "@/lib/admin/seller-product-requests/create-canonical";
import { promoteRequestImage } from "@/lib/admin/seller-product-requests/promote-image";
import { pesosToCentavos } from "@/lib/admin/catalog-schemas";

/**
 * Admin Seller Product Request review — server actions (Phase 9F-5c).
 *
 * PERMISSIONS (reuse only — no new RBAC key, `rbac/catalog.ts` +
 * `scripts/seed-rbac.ts` untouched):
 *   - `manage_content`        — request review / status (changes, reject, link)
 *   - `create_products`       — create a canonical Product from a request
 *   - `manage_product_images` — promote a seller image to a ProductImage
 *
 * Every state change writes one `adminAuditLog` row and fires exactly one seller
 * notification. Status re-checks are transactional in the repository so a
 * repeated approval can't process the same request twice.
 */

export type RequestReviewState = {
  ok?: boolean;
  error?: string;
  message?: string;
  fieldErrors?: Record<string, string>;
};

function revalidate(requestId: string, sellerId?: string) {
  revalidatePath("/admin/seller-product-requests");
  revalidatePath(`/admin/seller-product-requests/${requestId}`);
  if (sellerId) revalidatePath(`/admin/sellers/${sellerId}`);
  revalidatePath("/admin/audit");
  revalidatePath("/admin/offers");
  revalidatePath(`/seller/product-requests/${requestId}`);
  revalidatePath("/seller/product-requests");
  revalidatePath("/seller/offers");
  revalidatePath("/seller");
}

/**
 * 9F-24D (P1-1) — after an approval, hand the proposing seller a set of DRAFT
 * listings for the result product's ACTIVE variants + one audit row. Best-effort:
 * a failure here never unwinds the approval (which already committed).
 */
async function seedAndAuditSellerDraftOffers(
  adminUserId: string,
  adminEmail: string,
  requestId: string,
  sellerId: string,
  productId: string,
  productName: string,
  /** 9F-36B — the request's `proposedCondition`; NULL/legacy → seeded as NEW. */
  proposedCondition: string | null,
) {
  try {
    const seeded = await seedSellerDraftOffers(sellerId, adminUserId, productId, proposedCondition);
    if (seeded.created.length > 0) {
      await writeAudit({
        actorUserId: adminUserId,
        action: "seller_offer.seeded_from_request",
        targetType: "seller_product_request",
        targetId: requestId,
        summary: `${adminEmail} created ${seeded.created.length} draft listing(s) (${seeded.condition}) for the seller from approved request "${productName}"`,
        meta: { sellerId, productId, offerIds: seeded.created, skipped: seeded.skipped, condition: seeded.condition },
      });
    }
  } catch (err) {
    console.error("[seller-product-requests] seedSellerDraftOffers", err);
  }
}

function revalidateStorefront() {
  revalidateTag("products", "max");
  revalidateTag("categories", "max");
}

// ---------------------------------------------------------------------------
// Request changes  (PENDING → DRAFT)
// ---------------------------------------------------------------------------

const noteSchema = z.object({
  requestId: z.string().min(1).max(64),
  note: z.string().trim().min(1).max(2000),
});

export async function requestChangesAction(
  _prev: RequestReviewState,
  formData: FormData,
): Promise<RequestReviewState> {
  const admin = await requirePermission("manage_content");
  const parsed = noteSchema.safeParse({ requestId: formData.get("requestId"), note: formData.get("note") });
  if (!parsed.success) return { error: "Add a note so the seller knows what to change." };

  const res = await requestChanges(parsed.data.requestId, admin.user.id, parsed.data.note);
  if (!res.ok) return { error: res.error };

  await writeAudit({
    actorUserId: admin.user.id,
    action: "seller_product_request.changes_requested",
    targetType: "seller_product_request",
    targetId: parsed.data.requestId,
    summary: `${admin.user.email} sent product request "${res.productName}" back for changes`,
    // 9F-40B — the review note per round, so the Admin Activity view can show
    // each round's actual feedback (the single `reviewStatusNote` field only
    // ever holds the latest).
    meta: { sellerId: res.sellerId, from: "PENDING", to: "DRAFT", note: res.reviewNote },
  });
  scheduleEmail(() => sendSellerProductRequestRejected(parsed.data.requestId));

  revalidate(parsed.data.requestId, res.sellerId);
  return { ok: true, message: "Sent back to the seller as a draft." };
}

// ---------------------------------------------------------------------------
// Reject  (PENDING → REJECTED, terminal)
// ---------------------------------------------------------------------------

export async function rejectRequestAction(
  _prev: RequestReviewState,
  formData: FormData,
): Promise<RequestReviewState> {
  const admin = await requirePermission("manage_content");
  const parsed = noteSchema.safeParse({ requestId: formData.get("requestId"), note: formData.get("note") });
  if (!parsed.success) return { error: "Add a note explaining why." };

  const res = await rejectRequest(parsed.data.requestId, admin.user.id, parsed.data.note);
  if (!res.ok) return { error: res.error };

  await writeAudit({
    actorUserId: admin.user.id,
    action: "seller_product_request.rejected",
    targetType: "seller_product_request",
    targetId: parsed.data.requestId,
    summary: `${admin.user.email} rejected product request "${res.productName}"`,
    meta: { sellerId: res.sellerId, from: "PENDING", to: "REJECTED", note: res.reviewNote },
  });
  scheduleEmail(() => sendSellerProductRequestRejected(parsed.data.requestId));

  revalidate(parsed.data.requestId, res.sellerId);
  return { ok: true, message: "Request rejected." };
}

// ---------------------------------------------------------------------------
// Link to an existing product  (PENDING → APPROVED, resultProductId set)
// ---------------------------------------------------------------------------

const linkSchema = z.object({
  requestId: z.string().min(1).max(64),
  productId: z.string().min(1).max(64),
  note: z.string().trim().max(2000).optional().or(z.literal("")),
});

export async function linkExistingProductAction(
  _prev: RequestReviewState,
  formData: FormData,
): Promise<RequestReviewState> {
  const admin = await requirePermission("manage_content");
  const parsed = linkSchema.safeParse({
    requestId: formData.get("requestId"),
    productId: formData.get("productId"),
    note: formData.get("note") ?? "",
  });
  if (!parsed.success) return { error: "Pick a product to link to." };

  const res = await linkExistingProduct(
    parsed.data.requestId,
    parsed.data.productId,
    admin.user.id,
    parsed.data.note || null,
  );
  if (!res.ok) return { error: res.error };

  await writeAudit({
    actorUserId: admin.user.id,
    action: "seller_product_request.linked",
    targetType: "seller_product_request",
    targetId: parsed.data.requestId,
    summary: `${admin.user.email} linked product request "${res.productName}" to existing product ${res.productSlug}`,
    meta: { sellerId: res.sellerId, productId: res.productId, from: "PENDING", to: "APPROVED" },
  });
  await writeAudit({
    actorUserId: admin.user.id,
    action: "seller_product_request.approved",
    targetType: "seller_product_request",
    targetId: parsed.data.requestId,
    summary: `${admin.user.email} approved product request "${res.productName}" (linked)`,
    // 9F-40B — `note` is null when the reviewer approved without typing one (the
    // earlier `reviewStatusNote` is preserved, not shown here).
    meta: { sellerId: res.sellerId, productId: res.productId, mode: "link", note: res.reviewNote },
  });
  scheduleEmail(() => sendSellerProductRequestApproved(parsed.data.requestId));

  await seedAndAuditSellerDraftOffers(
    admin.user.id,
    admin.user.email,
    parsed.data.requestId,
    res.sellerId,
    res.productId,
    res.productName,
    res.proposedCondition,
  );

  revalidate(parsed.data.requestId, res.sellerId);
  return { ok: true, message: `Linked to ${res.productSlug}. Draft listings are ready for the seller to price and stock.` };
}

// ---------------------------------------------------------------------------
// Create a new canonical product from the request  (PENDING → APPROVED)
// ---------------------------------------------------------------------------

// 9F-24D P1-2 — no `status` field. A product created from a seller proposal is
// ALWAYS a draft (see `approveByCreatingProduct`); the admin activates it later
// from `/admin/products/[id]` once it's genuinely ready. This is what stops an
// approval from creating an ACTIVE Axiaro (1P) offer against the seller's
// proposed product.
const createSchema = z.object({
  requestId: z.string().min(1).max(64),
  name: z.string().trim().min(2).max(160),
  slug: z.string().trim().max(120).optional().or(z.literal("")),
  brand: z.string().trim().min(1).max(80),
  shortDescription: z.string().trim().min(1).max(300),
  description: z.string().trim().min(1).max(8000),
  categoryId: z.string().trim().min(1).max(64),
  sku: z.string().trim().max(64).optional().or(z.literal("")),
  optionsJson: z.string().optional(),
  note: z.string().trim().max(2000).optional().or(z.literal("")),
});

export async function createProductFromRequestAction(
  _prev: RequestReviewState,
  formData: FormData,
): Promise<RequestReviewState> {
  const admin = await requirePermission("create_products");
  const parsed = createSchema.safeParse({
    requestId: formData.get("requestId"),
    name: formData.get("name"),
    slug: formData.get("slug") ?? "",
    brand: formData.get("brand") ?? "Axiaro",
    shortDescription: formData.get("shortDescription"),
    description: formData.get("description"),
    categoryId: formData.get("categoryId"),
    sku: formData.get("sku") ?? "",
    optionsJson: formData.get("optionsJson") ?? "[]",
    note: formData.get("note") ?? "",
  });
  if (!parsed.success) {
    return { error: "Fix the highlighted fields.", fieldErrors: fieldErrorsFrom(parsed.error.issues) };
  }

  const price = pesosToCentavos(formData.get("price"));
  if (price == null || Number.isNaN(price) || !Number.isInteger(price) || price < 0) {
    return { error: "Enter a valid price.", fieldErrors: { price: "Enter a valid amount" } };
  }
  const rawCompare = pesosToCentavos(formData.get("compareAtPrice"));
  const compareAtPrice = rawCompare == null || Number.isNaN(rawCompare) ? null : rawCompare;
  const rawWeight = Number(formData.get("weightGrams") ?? "");
  const weightGrams = Number.isFinite(rawWeight) && rawWeight > 0 ? Math.floor(rawWeight) : undefined;
  const freeShipping = formData.get("freeShipping") === "on" || formData.get("freeShipping") === "true";
  const featured = formData.get("featured") === "on" || formData.get("featured") === "true";

  let options: { name: string; values: string[] }[] = [];
  try {
    const raw = JSON.parse(parsed.data.optionsJson || "[]");
    if (Array.isArray(raw)) {
      options = raw
        .filter((o) => o && typeof o === "object")
        .map((o) => ({
          name: String(o.name ?? "").trim(),
          values: Array.isArray(o.values) ? o.values.map((v: unknown) => String(v).trim()).filter(Boolean) : [],
        }));
    }
  } catch {
    return { error: "The option data was malformed — re-enter the options and try again." };
  }

  const res = await approveByCreatingProduct(parsed.data.requestId, admin.user.id, {
    name: parsed.data.name,
    slug: parsed.data.slug || undefined,
    brand: parsed.data.brand,
    shortDescription: parsed.data.shortDescription,
    description: parsed.data.description,
    categoryId: parsed.data.categoryId,
    price,
    compareAtPrice,
    weightGrams,
    freeShipping,
    featured,
    sku: parsed.data.sku || undefined,
    options,
    reviewNote: parsed.data.note || null,
  });
  if (!res.ok) return { error: res.error, fieldErrors: res.fieldErrors };

  await writeAudit({
    actorUserId: admin.user.id,
    action: "seller_product_request.product_created",
    targetType: "seller_product_request",
    targetId: parsed.data.requestId,
    summary: `${admin.user.email} created product "${res.productName}" (${res.productSlug}) from a seller request`,
    meta: { sellerId: res.sellerId, productId: res.productId, hasOptions: res.hasOptions },
  });
  await writeAudit({
    actorUserId: admin.user.id,
    action: "seller_product_request.approved",
    targetType: "seller_product_request",
    targetId: parsed.data.requestId,
    summary: `${admin.user.email} approved product request "${res.productName}" (new product)`,
    meta: { sellerId: res.sellerId, productId: res.productId, mode: "create", note: res.reviewNote },
  });
  scheduleEmail(() => sendSellerProductRequestApproved(parsed.data.requestId));

  await seedAndAuditSellerDraftOffers(
    admin.user.id,
    admin.user.email,
    parsed.data.requestId,
    res.sellerId,
    res.productId,
    res.productName,
    res.proposedCondition,
  );

  revalidateStorefront();
  revalidate(parsed.data.requestId, res.sellerId);
  return { ok: true, message: `Created ${res.productSlug} as a draft. Draft listings are ready for the seller to price and stock.` };
}

// ---------------------------------------------------------------------------
// Promote a seller image → ProductImage
// ---------------------------------------------------------------------------

const promoteSchema = z.object({
  requestId: z.string().min(1).max(64),
  imageId: z.string().min(1).max(64),
  optionValueId: z.string().trim().max(64).optional().or(z.literal("")),
  alt: z.string().trim().max(300).optional().or(z.literal("")),
});

export async function promoteRequestImageAction(
  _prev: RequestReviewState,
  formData: FormData,
): Promise<RequestReviewState> {
  const admin = await requirePermission("manage_product_images");
  const parsed = promoteSchema.safeParse({
    requestId: formData.get("requestId"),
    imageId: formData.get("imageId"),
    optionValueId: formData.get("optionValueId") ?? "",
    alt: formData.get("alt") ?? "",
  });
  if (!parsed.success) return { error: "Invalid request." };

  const res = await promoteRequestImage(parsed.data.requestId, parsed.data.imageId, {
    optionValueId: parsed.data.optionValueId || null,
    alt: parsed.data.alt || null,
  });
  if (!res.ok) return { error: res.error };

  await writeAudit({
    actorUserId: admin.user.id,
    action: "seller_product_request.image_promoted",
    targetType: "seller_product_request",
    targetId: parsed.data.requestId,
    summary: `${admin.user.email} promoted a seller image to a catalog image on "${res.productName}"`,
    meta: { sellerId: res.sellerId, productImageId: res.productImageId, imageId: parsed.data.imageId },
  });

  revalidateStorefront();
  revalidate(parsed.data.requestId, res.sellerId);
  return { ok: true, message: "Image added to the product." };
}

function fieldErrorsFrom(issues: readonly { path: readonly PropertyKey[]; message: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const k = i.path[0] != null ? String(i.path[0]) : "_";
    if (!out[k]) out[k] = i.message;
  }
  return out;
}
