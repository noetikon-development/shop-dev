import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  ALLOWED_MEDIA_TYPES,
  ALLOWED_MEDIA_ACCEPT,
  MAX_MEDIA_BYTES,
} from "@/lib/media-constants";

export { ALLOWED_MEDIA_TYPES, ALLOWED_MEDIA_ACCEPT, MAX_MEDIA_BYTES };

/**
 * Media library. Files live in Supabase Storage (bucket `media`); Postgres holds
 * only the reference + descriptive metadata — never binary data.
 *
 * Security (Step 16 §8):
 *  - the accepted type is decided by SNIFFING the file's magic bytes, not by the
 *    browser-supplied `file.type`;
 *  - SVG is not accepted (it can carry scripts);
 *  - size is capped server-side;
 *  - the object path is derived from a slugified name + a time prefix and
 *    uploaded with `upsert:false`, so an upload can never overwrite another
 *    object or escape the bucket;
 *  - all storage writes use the service-role client, which is server-only.
 */

export const MEDIA_BUCKET = "media";

export type MediaRecord = {
  id: string;
  url: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  folder: string;
  alt: string | null;
  width: number | null;
  height: number | null;
  createdAt: Date;
};

const MEDIA_SELECT = {
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
} as const;

function slugifyName(name: string): string {
  const dot = name.lastIndexOf(".");
  const base =
    (dot > 0 ? name.slice(0, dot) : name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "file";
  const ext = dot > 0 ? name.slice(dot).toLowerCase().replace(/[^a-z0-9.]/g, "") : "";
  return `${base}${ext}`;
}

/** A storage folder segment: lowercase letters/digits/dash/underscore, no traversal. */
function safeFolder(input: string | undefined): string {
  return (input ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9/_-]/g, "")
    .replace(/\.\.+/g, "")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean)
    .slice(0, 3)
    .join("/");
}

/** Detect the real content type from the first bytes. Returns null if unknown. */
function sniffMimeType(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && (buf.subarray(0, 6).toString("ascii") === "GIF87a" || buf.subarray(0, 6).toString("ascii") === "GIF89a")) {
    return "image/gif";
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (buf.length >= 5 && buf.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  return null;
}

/**
 * Read the pixel dimensions straight from an image file's header bytes — no
 * decoding, no dependencies. Supports the raster types we accept (PNG, JPEG,
 * GIF, WebP: VP8 / VP8L / VP8X). Returns null when the format can't be read
 * (e.g. PDF, or a truncated/odd file); the caller stores null and the admin
 * readout shows "dimensions not recorded".
 */
export function imageDimensions(
  buf: Buffer,
  mime: string,
): { width: number; height: number } | null {
  try {
    if (mime === "image/png") {
      // IHDR is the first chunk: 8B sig + 4B len + "IHDR" + width(4) + height(4)
      if (buf.length < 24 || buf.toString("ascii", 12, 16) !== "IHDR") return null;
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mime === "image/gif") {
      if (buf.length < 10) return null;
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (mime === "image/webp") {
      if (buf.length < 30 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") {
        return null;
      }
      const fourCC = buf.toString("ascii", 12, 16);
      if (fourCC === "VP8 ") {
        // lossy: 16-bit LE width/height (14 low bits) at offset 26/28
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
      if (fourCC === "VP8L") {
        // lossless: 1 signature byte (0x2f) then 14+14 bits, little-endian bitstream
        if (buf[20] !== 0x2f) return null;
        const b1 = buf[21], b2 = buf[22], b3 = buf[23], b4 = buf[24];
        return {
          width: 1 + (((b2 & 0x3f) << 8) | b1),
          height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
        };
      }
      if (fourCC === "VP8X") {
        // extended: 24-bit LE canvas width-1 / height-1 at offset 24 / 27
        return {
          width: 1 + buf.readUIntLE(24, 3),
          height: 1 + buf.readUIntLE(27, 3),
        };
      }
      return null;
    }
    if (mime === "image/jpeg") {
      // Walk the marker segments to the first Start-Of-Frame.
      let off = 2;
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) return null;
        const marker = buf[off + 1];
        const len = buf.readUInt16BE(off + 2);
        // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
        }
        off += 2 + len;
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export const MEDIA_PAGE_SIZE = 24;

export type MediaListFilters = {
  q?: string;
  folder?: string;
  kind?: "image" | "pdf";
  page?: number;
};

export async function listMedia(filters: MediaListFilters = {}) {
  const page = Math.max(1, filters.page ?? 1);
  const where: Prisma.MediaAssetWhereInput = {};
  if (filters.q?.trim()) {
    where.OR = [
      { filename: { contains: filters.q.trim(), mode: "insensitive" } },
      { alt: { contains: filters.q.trim(), mode: "insensitive" } },
      { folder: { contains: filters.q.trim(), mode: "insensitive" } },
    ];
  }
  if (filters.folder?.trim()) where.folder = filters.folder.trim();
  if (filters.kind === "image") where.mimeType = { startsWith: "image/" };
  if (filters.kind === "pdf") where.mimeType = "application/pdf";

  const [rows, total, folders] = await Promise.all([
    prisma.mediaAsset.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * MEDIA_PAGE_SIZE,
      take: MEDIA_PAGE_SIZE,
      select: MEDIA_SELECT,
    }),
    prisma.mediaAsset.count({ where }),
    prisma.mediaAsset.findMany({
      where: { folder: { not: "" } },
      distinct: ["folder"],
      select: { folder: true },
      orderBy: { folder: "asc" },
    }),
  ]);

  return {
    rows,
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / MEDIA_PAGE_SIZE)),
    folders: folders.map((f) => f.folder),
  };
}

export async function getMediaAsset(id: string): Promise<MediaRecord | null> {
  return prisma.mediaAsset.findUnique({ where: { id }, select: MEDIA_SELECT });
}

export async function resolveMediaUrls(ids: string[]): Promise<Map<string, MediaRecord>> {
  const clean = [...new Set(ids.filter(Boolean))];
  if (!clean.length) return new Map();
  const rows = await prisma.mediaAsset.findMany({ where: { id: { in: clean } }, select: MEDIA_SELECT });
  return new Map(rows.map((r) => [r.id, r]));
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export async function uploadMedia(params: {
  file: File;
  folder?: string;
  alt?: string;
  /**
   * Phase 9F-4a. When present the asset is attributed to this seller and its
   * storage path is FORCED under `sellers/<sellerId>/…` regardless of `folder`
   * — the seller plane never controls where its files land.
   */
  owner?: { sellerId: string };
}): Promise<{ ok: true; asset: MediaRecord } | { ok: false; error: string }> {
  const { file } = params;
  const folder = params.owner
    ? `sellers/${params.owner.sellerId}`
    : safeFolder(params.folder);
  const alt = (params.alt ?? "").trim().slice(0, 300) || null;

  if (!file || file.size === 0) return { ok: false, error: "Choose a file to upload." };
  if (file.size > MAX_MEDIA_BYTES) {
    return { ok: false, error: `File is too large (max ${MAX_MEDIA_BYTES / 1024 / 1024} MB).` };
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const sniffed = sniffMimeType(buffer);
  if (!sniffed || !ALLOWED_MEDIA_TYPES.includes(sniffed as (typeof ALLOWED_MEDIA_TYPES)[number])) {
    return {
      ok: false,
      error: "Unsupported file. Upload a PNG, JPG, WEBP, GIF or PDF.",
    };
  }
  // If the browser declared a type, it must at least agree with the real one.
  if (file.type && file.type !== sniffed && !(file.type === "image/jpg" && sniffed === "image/jpeg")) {
    return { ok: false, error: "The file's contents don't match its type." };
  }

  const safeName = slugifyName(file.name || "file");
  const path = `${folder ? `${folder}/` : ""}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;

  const supabase = createAdminClient();
  const { error: uploadError } = await supabase.storage
    .from(MEDIA_BUCKET)
    .upload(path, buffer, { contentType: sniffed, upsert: false });
  if (uploadError) return { ok: false, error: `Upload failed: ${uploadError.message}` };

  const { data: pub } = supabase.storage.from(MEDIA_BUCKET).getPublicUrl(path);

  const dims = sniffed.startsWith("image/") ? imageDimensions(buffer, sniffed) : null;

  const asset = await prisma.mediaAsset.create({
    data: {
      bucket: MEDIA_BUCKET,
      path,
      url: pub.publicUrl,
      filename: file.name || safeName,
      mimeType: sniffed,
      sizeBytes: file.size,
      folder,
      alt,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
      sellerId: params.owner?.sellerId ?? null,
    },
    select: MEDIA_SELECT,
  });

  return { ok: true, asset };
}

/**
 * Low-level object + row removal — NO reference check. Callers own the
 * authorization and reference-safety checks (admin `deleteMedia` does the
 * generic scan; the seller plane does its own seller-scoped scan). Best-effort
 * on the storage side; the Postgres row is the source of truth.
 */
export async function purgeMediaAsset(
  id: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<{ ok: boolean; error?: string }> {
  const asset = await client.mediaAsset.findUnique({ where: { id } });
  if (!asset) return { ok: true };
  const supabase = createAdminClient();
  await supabase.storage.from(asset.bucket).remove([asset.path]);
  await client.mediaAsset.delete({ where: { id } });
  return { ok: true };
}

/** Where a media asset is currently referenced. Empty = safe to delete. */
export async function mediaReferences(
  id: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<string[]> {
  const [productImages, categories, blocks, settings, sellers] = await Promise.all([
    client.productImage.findMany({
      where: { mediaAssetId: id },
      select: { product: { select: { name: true } } },
      take: 5,
    }),
    client.category.findMany({ where: { imageMediaId: id }, select: { name: true }, take: 5 }),
    client.contentBlock.findMany({
      where: { data: { contains: id } },
      select: { key: true, title: true },
      take: 5,
    }),
    client.storeSetting.findMany({
      where: { value: id, key: { endsWith: "MediaId" } },
      select: { label: true, key: true },
      take: 5,
    }),
    // Phase 9F-4a — a seller's logo / banner.
    client.seller.findMany({
      where: { OR: [{ logoMediaId: id }, { bannerMediaId: id }] },
      select: { displayName: true, logoMediaId: true, bannerMediaId: true },
      take: 5,
    }),
  ]);

  const refs: string[] = [];
  for (const pi of productImages) refs.push(`Product image — ${pi.product.name}`);
  for (const c of categories) refs.push(`Category image — ${c.name}`);
  for (const b of blocks) refs.push(`Content block — ${b.title ?? b.key}`);
  for (const s of settings) refs.push(`Setting — ${s.label ?? s.key}`);
  for (const s of sellers) {
    const which = s.logoMediaId === id ? "logo" : "banner";
    refs.push(`Seller ${which} — ${s.displayName}`);
  }
  return refs;
}

export async function deleteMedia(id: string): Promise<{ ok: boolean; error?: string }> {
  const asset = await prisma.mediaAsset.findUnique({ where: { id } });
  if (!asset) return { ok: false, error: "That file no longer exists." };

  const refs = await mediaReferences(id);
  if (refs.length) {
    return {
      ok: false,
      error: `This file is still used by: ${refs.slice(0, 3).join("; ")}${refs.length > 3 ? "…" : ""}. Remove those references first.`,
    };
  }

  const supabase = createAdminClient();
  await supabase.storage.from(asset.bucket).remove([asset.path]);
  await prisma.mediaAsset.delete({ where: { id } });
  return { ok: true };
}

export async function updateMediaAlt(id: string, alt: string): Promise<{ ok: boolean; error?: string }> {
  const asset = await prisma.mediaAsset.findUnique({ where: { id }, select: { id: true } });
  if (!asset) return { ok: false, error: "That file no longer exists." };
  await prisma.mediaAsset.update({ where: { id }, data: { alt: alt.trim().slice(0, 300) || null } });
  return { ok: true };
}
