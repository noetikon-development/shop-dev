"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { requirePermission } from "@/lib/admin/rbac";
import { uploadMedia, deleteMedia, updateMediaAlt } from "@/lib/admin/media";
import { writeAudit } from "@/lib/admin/audit";

/**
 * Media library server actions. Uploading/deleting/annotating media requires
 * `manage_content` (viewing requires `view_content`). All validation happens in
 * `src/lib/admin/media.ts` — magic-byte sniffing, size cap, safe paths,
 * reference-checked deletes.
 */

export type MediaUploadState = {
  error?: string;
  ok?: boolean;
  message?: string;
  asset?: {
    id: string;
    url: string;
    filename: string;
    folder: string;
    alt: string | null;
    mimeType: string;
    sizeBytes: number;
    width: number | null;
    height: number | null;
  };
};

export async function uploadMediaAction(
  _prev: MediaUploadState,
  formData: FormData,
): Promise<MediaUploadState> {
  const admin = await requirePermission("manage_content");

  const file = formData.get("file");
  const folder = String(formData.get("folder") ?? "");
  const alt = String(formData.get("alt") ?? "");
  if (!(file instanceof File)) return { error: "Choose a file to upload." };

  const result = await uploadMedia({ file, folder, alt });
  if (!result.ok) return { error: result.error };

  await writeAudit({
    actorUserId: admin.user.id,
    action: "media.upload",
    targetType: "media",
    targetId: result.asset.id,
    summary: `${admin.user.email} uploaded ${result.asset.filename}`,
    meta: {
      filename: result.asset.filename,
      mimeType: result.asset.mimeType,
      sizeBytes: result.asset.sizeBytes,
    },
  });

  revalidatePath("/admin/media");
  return {
    ok: true,
    message: `Uploaded ${result.asset.filename}.`,
    asset: {
      id: result.asset.id,
      url: result.asset.url,
      filename: result.asset.filename,
      folder: result.asset.folder,
      alt: result.asset.alt,
      mimeType: result.asset.mimeType,
      sizeBytes: result.asset.sizeBytes,
      width: result.asset.width,
      height: result.asset.height,
    },
  };
}

export type MediaDeleteState = { error?: string; ok?: boolean };

export async function deleteMediaAction(
  _prev: MediaDeleteState,
  formData: FormData,
): Promise<MediaDeleteState> {
  const admin = await requirePermission("manage_content");
  const id = String(formData.get("id") ?? "");
  if (!id) return { error: "Missing file." };

  const result = await deleteMedia(id);
  if (!result.ok) return { error: result.error ?? "Could not delete the file." };

  await writeAudit({
    actorUserId: admin.user.id,
    action: "media.delete",
    targetType: "media",
    targetId: id,
    summary: `${admin.user.email} deleted a media file`,
    meta: { id },
  });

  revalidatePath("/admin/media");
  revalidateTag("content", "max");
  return { ok: true };
}

export type MediaAltState = { error?: string; ok?: boolean };

export async function updateMediaAltAction(input: unknown): Promise<MediaAltState> {
  const admin = await requirePermission("manage_content");
  const { id, alt } =
    input && typeof input === "object"
      ? (input as { id?: unknown; alt?: unknown })
      : {};
  if (typeof id !== "string" || !id) return { error: "Missing file." };

  const result = await updateMediaAlt(id, typeof alt === "string" ? alt : "");
  if (!result.ok) return { error: result.error };

  await writeAudit({
    actorUserId: admin.user.id,
    action: "media.updated",
    targetType: "media",
    targetId: id,
    summary: `${admin.user.email} updated media description`,
  });
  revalidatePath("/admin/media");
  return { ok: true };
}
