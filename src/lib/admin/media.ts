import "server-only";
import { prisma } from "@/lib/prisma";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Media foundation. Files live in Supabase Storage (bucket `media`); Postgres
 * holds only the reference + descriptive metadata (never binary data).
 *
 * The storage bucket is created once by `npm run storage:setup`.
 */

export const MEDIA_BUCKET = "media";

export const ALLOWED_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
  "application/pdf",
];

export const MAX_MEDIA_BYTES = 8 * 1024 * 1024; // 8 MB

export type MediaRecord = {
  id: string;
  url: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  folder: string;
  createdAt: Date;
};

function slugifyName(name: string): string {
  const dot = name.lastIndexOf(".");
  const base = (dot > 0 ? name.slice(0, dot) : name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "file";
  const ext = dot > 0 ? name.slice(dot).toLowerCase().replace(/[^a-z0-9.]/g, "") : "";
  return `${base}${ext}`;
}

export async function listMedia(): Promise<MediaRecord[]> {
  return prisma.mediaAsset.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      url: true,
      filename: true,
      mimeType: true,
      sizeBytes: true,
      folder: true,
      createdAt: true,
    },
  });
}

export async function uploadMedia(params: {
  file: File;
  folder?: string;
}): Promise<{ ok: true; asset: MediaRecord } | { ok: false; error: string }> {
  const { file } = params;
  const folder = (params.folder ?? "").replace(/[^a-z0-9/_-]/gi, "").replace(/^\/+|\/+$/g, "");

  if (!file || file.size === 0) return { ok: false, error: "Choose a file to upload." };
  if (file.size > MAX_MEDIA_BYTES) {
    return { ok: false, error: `File is too large (max ${MAX_MEDIA_BYTES / 1024 / 1024} MB).` };
  }
  if (!ALLOWED_MEDIA_TYPES.includes(file.type)) {
    return { ok: false, error: `Unsupported file type: ${file.type || "unknown"}.` };
  }

  const safeName = slugifyName(file.name || "file");
  const path = `${folder ? `${folder}/` : ""}${Date.now().toString(36)}-${safeName}`;

  const supabase = createAdminClient();
  const buffer = Buffer.from(await file.arrayBuffer());

  const { error: uploadError } = await supabase.storage
    .from(MEDIA_BUCKET)
    .upload(path, buffer, { contentType: file.type, upsert: false });
  if (uploadError) {
    return { ok: false, error: `Upload failed: ${uploadError.message}` };
  }

  const { data: pub } = supabase.storage.from(MEDIA_BUCKET).getPublicUrl(path);

  const asset = await prisma.mediaAsset.create({
    data: {
      bucket: MEDIA_BUCKET,
      path,
      url: pub.publicUrl,
      filename: file.name || safeName,
      mimeType: file.type,
      sizeBytes: file.size,
      folder,
    },
    select: {
      id: true,
      url: true,
      filename: true,
      mimeType: true,
      sizeBytes: true,
      folder: true,
      createdAt: true,
    },
  });

  return { ok: true, asset };
}

export async function deleteMedia(id: string): Promise<{ ok: boolean; error?: string }> {
  const asset = await prisma.mediaAsset.findUnique({ where: { id } });
  if (!asset) return { ok: false, error: "That file no longer exists." };

  const supabase = createAdminClient();
  await supabase.storage.from(asset.bucket).remove([asset.path]);
  await prisma.mediaAsset.delete({ where: { id } });
  return { ok: true };
}
