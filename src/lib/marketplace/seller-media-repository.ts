import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { uploadMedia, purgeMediaAsset, mediaReferences, type MediaRecord } from "@/lib/admin/media";
import type { SellerContext } from "@/lib/marketplace/types";

/**
 * Seller-scoped media library (Phase 9F-4a).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The ONLY sanctioned way for seller-plane code to touch `MediaAsset`.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Isolation:
 *   - `listSellerMedia` / `deleteSellerMedia` filter `where: { sellerId: ctx.sellerId }`;
 *   - `uploadSellerMedia` stamps `sellerId` and FORCES the storage path under
 *     `sellers/<sellerId>/…` (via `uploadMedia({ owner })`);
 *   - a seller can never read, reference or delete another seller's asset, and
 *     the operator/global assets (`sellerId = null`) are invisible here.
 *
 * Safety is inherited from `src/lib/admin/media.ts` unchanged: magic-byte
 * sniffing, SVG rejection, 8 MB cap, server-generated object path, dimension
 * read. This module adds only the seller scoping + a per-seller asset cap +
 * reference-checked deletes.
 */

type Client = Prisma.TransactionClient | typeof prisma;

/** Max media assets one seller may hold. Keeps the shared bucket bounded. */
export const SELLER_MEDIA_CAP = 20;

export type SellerMediaError =
  | { ok: false; code: "NOT_FOUND"; error: string }
  | { ok: false; code: "VALIDATION"; error: string }
  | { ok: false; code: "CAP"; error: string }
  | { ok: false; code: "IN_USE"; error: string };

const SELLER_MEDIA_SELECT = {
  id: true,
  url: true,
  filename: true,
  mimeType: true,
  sizeBytes: true,
  folder: true,
  alt: true,
  width: true,
  height: true,
  createdAt: true,
  sellerId: true,
} as const;

export type SellerMediaRecord = MediaRecord & { sellerId: string | null };

export async function countSellerMedia(ctx: SellerContext, client: Client = prisma): Promise<number> {
  return client.mediaAsset.count({ where: { sellerId: ctx.sellerId } });
}

/** Every media asset owned by this seller, newest first. Never another seller's. */
export async function listSellerMedia(
  ctx: SellerContext,
  client: Client = prisma,
): Promise<SellerMediaRecord[]> {
  return client.mediaAsset.findMany({
    where: { sellerId: ctx.sellerId },
    orderBy: { createdAt: "desc" },
    select: SELLER_MEDIA_SELECT,
  });
}

/** One asset, but only if this seller owns it. `null` for missing AND for another seller's. */
export async function getSellerMedia(
  ctx: SellerContext,
  id: string,
  client: Client = prisma,
): Promise<SellerMediaRecord | null> {
  return client.mediaAsset.findFirst({
    where: { id, sellerId: ctx.sellerId },
    select: SELLER_MEDIA_SELECT,
  });
}

export type UploadSellerMediaResult = { ok: true; asset: SellerMediaRecord } | SellerMediaError;

/**
 * Upload one image for this seller. Reuses `uploadMedia` for every safety check;
 * the path is forced under `sellers/<sellerId>/` and the row is stamped with
 * `sellerId`. Enforces `SELLER_MEDIA_CAP` first.
 */
export async function uploadSellerMedia(
  ctx: SellerContext,
  params: { file: File; alt?: string },
): Promise<UploadSellerMediaResult> {
  const count = await countSellerMedia(ctx);
  if (count >= SELLER_MEDIA_CAP) {
    return {
      ok: false,
      code: "CAP",
      error: `You've reached the ${SELLER_MEDIA_CAP}-file limit. Delete an unused file first.`,
    };
  }

  const res = await uploadMedia({
    file: params.file,
    alt: params.alt,
    owner: { sellerId: ctx.sellerId },
  });
  if (!res.ok) return { ok: false, code: "VALIDATION", error: res.error };

  // Belt-and-braces: the path must be under this seller's prefix.
  if (!res.asset || !("id" in res.asset)) {
    return { ok: false, code: "VALIDATION", error: "Upload failed." };
  }
  const stamped = await prisma.mediaAsset.findUnique({
    where: { id: res.asset.id },
    select: SELLER_MEDIA_SELECT,
  });
  if (!stamped || stamped.sellerId !== ctx.sellerId || !stamped.folder.startsWith(`sellers/${ctx.sellerId}`)) {
    // Should be impossible — undo rather than leave a mis-scoped asset.
    await purgeMediaAsset(res.asset.id).catch(() => {});
    return { ok: false, code: "VALIDATION", error: "Upload failed a safety check." };
  }

  return { ok: true, asset: stamped };
}

/**
 * Delete one of this seller's assets. Refuses when the asset is still the
 * seller's logo/banner, or referenced anywhere else in the app.
 */
export async function deleteSellerMedia(
  ctx: SellerContext,
  id: string,
  client: Client = prisma,
): Promise<{ ok: true } | SellerMediaError> {
  const asset = await client.mediaAsset.findFirst({
    where: { id, sellerId: ctx.sellerId },
    select: { id: true },
  });
  if (!asset) return { ok: false, code: "NOT_FOUND", error: "That file isn't in your media library." };

  const stillLogoOrBanner = await client.seller.count({
    where: { id: ctx.sellerId, OR: [{ logoMediaId: id }, { bannerMediaId: id }] },
  });
  if (stillLogoOrBanner > 0) {
    return {
      ok: false,
      code: "IN_USE",
      error: "This file is still set as your logo or banner. Clear it there first.",
    };
  }

  const refs = await mediaReferences(id, client);
  if (refs.length > 0) {
    return { ok: false, code: "IN_USE", error: `This file is still in use: ${refs.slice(0, 2).join("; ")}.` };
  }

  await purgeMediaAsset(id, client);
  return { ok: true };
}
