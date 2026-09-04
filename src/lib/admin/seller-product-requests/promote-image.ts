import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type Client = Prisma.TransactionClient | typeof prisma;

/**
 * Phase 9F-5c Part 6 — promote ONE seller-provided request image to a canonical
 * ProductImage.
 *
 * Rules:
 *   - the request must be APPROVED and linked to `productId` (its resultProduct);
 *   - the MediaAsset must currently belong to the request's seller
 *     (`sellerId === request.sellerId`) — a foreign / already-global asset is
 *     rejected;
 *   - promotion RE-SCOPES the asset to the catalog (`sellerId → null`,
 *     `folder → "products"`) and creates a `ProductImage` for it, appended to
 *     the target colour group so existing ordering is preserved;
 *   - once promoted the asset is referenced by a ProductImage, so
 *     `deleteSellerMedia` / `deleteMedia` both refuse it (unsafe-delete guard).
 * Never promotes more than the one requested image. Never runs from seller code.
 */

export type PromoteImageResult =
  | { ok: true; productImageId: string; productName: string; sellerId: string }
  | { ok: false; code: "NOT_FOUND" | "VALIDATION" | "CONFLICT"; error: string };

export async function promoteRequestImage(
  requestId: string,
  imageId: string,
  opts: { optionValueId?: string | null; alt?: string | null } = {},
  externalTx?: Prisma.TransactionClient,
): Promise<PromoteImageResult> {
  const db: Client = externalTx ?? prisma;
  const req = await db.sellerProductRequest.findUnique({
    where: { id: requestId },
    select: {
      status: true,
      sellerId: true,
      resultProductId: true,
      resultProduct: { select: { id: true, name: true } },
    },
  });
  if (!req) return { ok: false, code: "NOT_FOUND", error: "That request no longer exists." };
  if (req.status !== "APPROVED" || !req.resultProductId || !req.resultProduct) {
    return { ok: false, code: "VALIDATION", error: "Approve and link the request to a product first." };
  }

  const image = await db.sellerProductRequestImage.findFirst({
    where: { id: imageId, requestId },
    select: {
      mediaAssetId: true,
      mediaAsset: { select: { id: true, url: true, alt: true, mimeType: true, sellerId: true } },
    },
  });
  if (!image) return { ok: false, code: "NOT_FOUND", error: "That image isn't on this request." };
  if (image.mediaAsset.sellerId !== req.sellerId) {
    return { ok: false, code: "VALIDATION", error: "That image is no longer owned by this seller — it can't be promoted." };
  }
  if (!image.mediaAsset.mimeType.startsWith("image/")) {
    return { ok: false, code: "VALIDATION", error: "Only image files can become catalog images." };
  }

  // optionValueId (colour) must belong to this product, or be null (product-level).
  let optionValueId: string | null = null;
  if (opts.optionValueId && opts.optionValueId !== "__product") {
    const ov = await db.productOptionValue.findFirst({
      where: { id: opts.optionValueId, option: { productId: req.resultProductId } },
      select: { id: true },
    });
    if (!ov) return { ok: false, code: "VALIDATION", error: "That colour isn't valid for this product." };
    optionValueId = ov.id;
  }

  const dupe = await db.productImage.findFirst({
    where: { productId: req.resultProductId, mediaAssetId: image.mediaAssetId },
    select: { id: true },
  });
  if (dupe) return { ok: false, code: "CONFLICT", error: "That image is already on the product." };

  const groupCount = await db.productImage.count({
    where: { productId: req.resultProductId, optionValueId },
  });

  const run = async (tx: Prisma.TransactionClient) => {
    await tx.mediaAsset.update({
      where: { id: image.mediaAssetId },
      data: { sellerId: null, folder: "products" },
    });
    const created = await tx.productImage.create({
      data: {
        productId: req.resultProductId!,
        optionValueId,
        url: image.mediaAsset.url,
        alt: (opts.alt ?? "").trim() || image.mediaAsset.alt || req.resultProduct!.name,
        sortOrder: groupCount,
        mediaAssetId: image.mediaAssetId,
      },
      select: { id: true },
    });
    return created.id;
  };
  const productImageId = externalTx ? await run(externalTx) : await prisma.$transaction(run);

  return { ok: true, productImageId, productName: req.resultProduct.name, sellerId: req.sellerId };
}

/** Colour option-value choices for the promotion picker on the admin detail page. */
export async function productColourChoices(
  productId: string,
): Promise<{ id: string; value: string }[]> {
  const values = await prisma.productOptionValue.findMany({
    where: { option: { productId, name: { in: ["Colour", "Color"] } } },
    orderBy: { sortOrder: "asc" },
    select: { id: true, value: true },
  });
  return values;
}
