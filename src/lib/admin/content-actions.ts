"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/admin/rbac";
import { uploadMedia, deleteMedia } from "@/lib/admin/media";
import { writeAudit } from "@/lib/admin/audit";

/**
 * CMS / media foundation server actions. Every mutation is authorized
 * server-side with the Step 3 helpers before touching storage or the database.
 */

export type MediaUploadState = { error?: string; ok?: boolean; message?: string };

export async function uploadMediaAction(
  _prev: MediaUploadState,
  formData: FormData,
): Promise<MediaUploadState> {
  const admin = await requirePermission("manage_content");

  const file = formData.get("file");
  const folder = String(formData.get("folder") ?? "");
  if (!(file instanceof File)) return { error: "Choose a file to upload." };

  const result = await uploadMedia({ file, folder });
  if (!result.ok) return { error: result.error };

  await writeAudit({
    actorUserId: admin.user.id,
    action: "media.upload",
    targetType: "media",
    targetId: result.asset.id,
    summary: `${admin.user.email} uploaded ${result.asset.filename}`,
    meta: { filename: result.asset.filename, mimeType: result.asset.mimeType, sizeBytes: result.asset.sizeBytes },
  });

  revalidatePath("/admin/media");
  return { ok: true, message: `Uploaded ${result.asset.filename}.` };
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
  return { ok: true };
}
