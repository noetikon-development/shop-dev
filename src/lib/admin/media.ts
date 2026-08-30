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
}): Promise<{ ok: true; asset: MediaRecord } | { ok: false; error: string }> {
  const { file } = params;
  const folder = safeFolder(params.folder);
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
    },
    select: MEDIA_SELECT,
  });

  return { ok: true, asset };
}

/** Where a media asset is currently referenced. Empty = safe to delete. */
export async function mediaReferences(id: string): Promise<string[]> {
  const [productImages, categories, blocks, settings] = await Promise.all([
    prisma.productImage.findMany({
      where: { mediaAssetId: id },
      select: { product: { select: { name: true } } },
      take: 5,
    }),
    prisma.category.findMany({ where: { imageMediaId: id }, select: { name: true }, take: 5 }),
    prisma.contentBlock.findMany({
      where: { data: { contains: id } },
      select: { key: true, title: true },
      take: 5,
    }),
    prisma.storeSetting.findMany({
      where: { value: id, key: { endsWith: "MediaId" } },
      select: { label: true, key: true },
      take: 5,
    }),
  ]);

  const refs: string[] = [];
  for (const pi of productImages) refs.push(`Product image — ${pi.product.name}`);
  for (const c of categories) refs.push(`Category image — ${c.name}`);
  for (const b of blocks) refs.push(`Content block — ${b.title ?? b.key}`);
  for (const s of settings) refs.push(`Setting — ${s.label ?? s.key}`);
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
