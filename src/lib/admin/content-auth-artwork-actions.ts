"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/admin/rbac";
import { writeAudit } from "@/lib/admin/audit";
import { authArtworkSchema } from "@/lib/content-blocks";
import {
  AUTH_ARTWORK_BLOCK_KEY,
  type AuthArtworkActionState,
} from "@/lib/auth-artwork-defaults";

/**
 * Authentication-artwork administration. Requires `manage_content`.
 *
 * One `area:"global"` ContentBlock keyed `auth.artwork`, upserted on save
 * (create on first save, update thereafter). The JSON payload is validated
 * against `authArtworkSchema` before it is written — a bad payload is rejected,
 * never persisted.
 *
 * The image itself is a `MediaAsset` (uploaded through the shared media picker);
 * this block only stores the id, an alt-text override and the on/off switch. If
 * the block is absent / disabled / imageless, the auth layout keeps its built-in
 * `ProductArt` sofa illustration.
 *
 * `AUTH_ARTWORK_BLOCK_KEY` and `AuthArtworkActionState` live in
 * `@/lib/auth-artwork-defaults` (a "use server" module may only export async
 * functions).
 */

export async function saveAuthArtworkAction(
  _prev: AuthArtworkActionState,
  formData: FormData,
): Promise<AuthArtworkActionState> {
  const admin = await requirePermission("manage_content");

  let json: unknown;
  try {
    json = JSON.parse(String(formData.get("data") ?? "{}"));
  } catch {
    return { ok: false, error: "The artwork settings are malformed." };
  }

  const parsed = authArtworkSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "The artwork settings are invalid." };
  }

  // Enabling the artwork requires a real image behind it.
  if (parsed.data.enabled && !parsed.data.imageMediaId) {
    return { ok: false, error: "Choose an image before enabling the artwork." };
  }

  // A referenced image must exist and be an image asset.
  if (parsed.data.imageMediaId) {
    const asset = await prisma.mediaAsset.findUnique({
      where: { id: parsed.data.imageMediaId },
      select: { mimeType: true },
    });
    if (!asset || !asset.mimeType.startsWith("image/")) {
      return { ok: false, error: "That image could not be found in the media library." };
    }
  }

  const dataStr = JSON.stringify(parsed.data);

  const existing = await prisma.contentBlock.findUnique({ where: { key: AUTH_ARTWORK_BLOCK_KEY } });
  if (existing) {
    await prisma.contentBlock.update({
      where: { key: AUTH_ARTWORK_BLOCK_KEY },
      data: { data: dataStr, type: "auth_artwork", area: "global", title: "Authentication artwork", status: "PUBLISHED" },
    });
  } else {
    await prisma.contentBlock.create({
      data: {
        key: AUTH_ARTWORK_BLOCK_KEY,
        area: "global",
        type: "auth_artwork",
        title: "Authentication artwork",
        data: dataStr,
        position: 0,
        status: "PUBLISHED",
      },
    });
  }

  await writeAudit({
    actorUserId: admin.user.id,
    action: "content.auth_artwork_updated",
    targetType: "content_block",
    targetId: AUTH_ARTWORK_BLOCK_KEY,
    summary: `${admin.user.email} ${existing ? "updated" : "created"} the authentication artwork (${
      parsed.data.enabled && parsed.data.imageMediaId ? "custom image" : "built-in illustration"
    })`,
  });

  revalidateTag("content", "max");
  revalidatePath("/", "layout");
  revalidatePath("/admin/content/authentication");

  return { ok: true };
}
