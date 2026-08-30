"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/admin/rbac";
import { writeAudit } from "@/lib/admin/audit";
import {
  BLOCK_TYPES,
  isBlockType,
  parseBlockData,
  type BlockTypeKey,
} from "@/lib/content-blocks";

/**
 * Homepage / content-block administration (Step 16). Requires `manage_content`.
 * Blocks are stored in the existing `ContentBlock` model; the JSON `data`
 * payload is validated against the block type's schema before it is written, so
 * a bad payload is rejected rather than persisted. Ordering is stored as an
 * integer `position` (deterministic), never inferred from browser array order at
 * render time.
 */

export type BlockActionState = {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
  createdId?: string;
};

function revalidate() {
  revalidateTag("content", "max");
  revalidatePath("/admin/content/homepage");
  revalidatePath("/", "layout");
  revalidatePath("/");
}

/** Extract every media-id and product-id referenced by a block payload. */
function referencedIds(type: BlockTypeKey, data: Record<string, unknown>) {
  const media: string[] = [];
  const products: string[] = [];
  if (type === "hero" && typeof data.imageMediaId === "string" && data.imageMediaId) media.push(data.imageMediaId);
  if (type === "feature_grid" && Array.isArray(data.items)) {
    for (const it of data.items as Record<string, unknown>[]) {
      if (typeof it.imageMediaId === "string" && it.imageMediaId) media.push(it.imageMediaId);
    }
  }
  if (type === "product_rail" && data.source === "manual" && Array.isArray(data.productIds)) {
    for (const id of data.productIds as unknown[]) if (typeof id === "string" && id) products.push(id);
  }
  return { media, products };
}

async function validatePayload(
  type: BlockTypeKey,
  rawData: string,
): Promise<{ data: Record<string, unknown> } | { error: string }> {
  let json: unknown;
  try {
    json = JSON.parse(rawData || "{}");
  } catch {
    return { error: "The block content is malformed." };
  }
  const parsed = BLOCK_TYPES[type].schema.safeParse(json);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "The block content is invalid." };
  }
  const data = parsed.data as Record<string, unknown>;

  const { media, products } = referencedIds(type, data);
  if (media.length) {
    const found = await prisma.mediaAsset.findMany({
      where: { id: { in: [...new Set(media)] }, mimeType: { startsWith: "image/" } },
      select: { id: true },
    });
    if (found.length !== new Set(media).size) return { error: "One of the images is no longer in the media library." };
  }
  if (products.length) {
    const found = await prisma.product.findMany({
      where: { id: { in: [...new Set(products)] } },
      select: { id: true },
    });
    if (found.length !== new Set(products).size) return { error: "One of the selected products no longer exists." };
  }
  return { data };
}

const createSchema = z.object({
  type: z.string(),
  area: z.enum(["homepage", "global"]).default("homepage"),
  title: z.string().trim().max(160).optional(),
  status: z.enum(["DRAFT", "PUBLISHED"]).default("DRAFT"),
  data: z.string().max(20_000),
});

export async function createBlockAction(
  _prev: BlockActionState,
  formData: FormData,
): Promise<BlockActionState> {
  const admin = await requirePermission("manage_content");

  const parsed = createSchema.safeParse({
    type: String(formData.get("type") ?? ""),
    area: String(formData.get("area") ?? "homepage"),
    title: String(formData.get("title") ?? "") || undefined,
    status: String(formData.get("status") ?? "DRAFT"),
    data: String(formData.get("data") ?? "{}"),
  });
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  if (!isBlockType(parsed.data.type)) return { ok: false, error: "Unknown block type." };

  const payload = await validatePayload(parsed.data.type, parsed.data.data);
  if ("error" in payload) return { ok: false, error: payload.error };

  const last = await prisma.contentBlock.aggregate({
    where: { area: parsed.data.area },
    _max: { position: true },
  });
  const position = (last._max.position ?? -1) + 1;
  const key = `${parsed.data.area}.${parsed.data.type}.${Date.now().toString(36)}`;

  const created = await prisma.contentBlock.create({
    data: {
      key,
      area: parsed.data.area,
      type: parsed.data.type,
      title: parsed.data.title ?? null,
      data: JSON.stringify(payload.data),
      position,
      status: parsed.data.status,
    },
    select: { id: true, type: true, status: true },
  });

  await writeAudit({
    actorUserId: admin.user.id,
    action: "content.block_created",
    targetType: "content_block",
    targetId: created.id,
    summary: `${admin.user.email} added a ${BLOCK_TYPES[parsed.data.type].label} block (${created.status})`,
    meta: { type: created.type, area: parsed.data.area, position },
  });

  revalidate();
  return { ok: true, createdId: created.id };
}

const updateSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().trim().max(160).optional(),
  status: z.enum(["DRAFT", "PUBLISHED"]),
  data: z.string().max(20_000),
});

export async function updateBlockAction(
  _prev: BlockActionState,
  formData: FormData,
): Promise<BlockActionState> {
  const admin = await requirePermission("manage_content");

  const parsed = updateSchema.safeParse({
    id: String(formData.get("id") ?? ""),
    title: String(formData.get("title") ?? "") || undefined,
    status: String(formData.get("status") ?? "DRAFT"),
    data: String(formData.get("data") ?? "{}"),
  });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const current = await prisma.contentBlock.findUnique({ where: { id: parsed.data.id } });
  if (!current || !isBlockType(current.type)) return { ok: false, error: "That block wasn't found." };

  const payload = await validatePayload(current.type, parsed.data.data);
  if ("error" in payload) return { ok: false, error: payload.error };

  const becamePublished = parsed.data.status === "PUBLISHED" && current.status !== "PUBLISHED";
  await prisma.contentBlock.update({
    where: { id: current.id },
    data: {
      title: parsed.data.title ?? null,
      data: JSON.stringify(payload.data),
      status: parsed.data.status,
    },
  });

  await writeAudit({
    actorUserId: admin.user.id,
    action: becamePublished ? "content.block_published" : "content.block_updated",
    targetType: "content_block",
    targetId: current.id,
    summary: `${admin.user.email} ${becamePublished ? "published" : "updated"} a ${BLOCK_TYPES[current.type].label} block`,
    meta: { type: current.type, status: parsed.data.status },
  });

  revalidate();
  return { ok: true };
}

export async function setBlockStatusAction(input: unknown): Promise<BlockActionState> {
  const admin = await requirePermission("manage_content");
  const parsed = z.object({ id: z.string().min(1).max(64), status: z.enum(["DRAFT", "PUBLISHED"]) }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const current = await prisma.contentBlock.findUnique({ where: { id: parsed.data.id } });
  if (!current) return { ok: false, error: "That block wasn't found." };
  if (current.status === parsed.data.status) return { ok: true };

  await prisma.contentBlock.update({ where: { id: current.id }, data: { status: parsed.data.status } });
  await writeAudit({
    actorUserId: admin.user.id,
    action: parsed.data.status === "PUBLISHED" ? "content.block_published" : "content.block_unpublished",
    targetType: "content_block",
    targetId: current.id,
    summary: `${admin.user.email} ${parsed.data.status === "PUBLISHED" ? "published" : "hid"} a ${current.type} block`,
    meta: { type: current.type },
  });
  revalidate();
  return { ok: true };
}

export async function reorderBlocksAction(input: unknown): Promise<BlockActionState> {
  const admin = await requirePermission("manage_content");
  const parsed = z
    .object({ area: z.enum(["homepage", "global"]).default("homepage"), ids: z.array(z.string().min(1).max(64)).max(50) })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const blocks = await prisma.contentBlock.findMany({
    where: { area: parsed.data.area },
    select: { id: true },
  });
  const known = new Set(blocks.map((b) => b.id));
  const ordered = parsed.data.ids.filter((id) => known.has(id));
  if (ordered.length !== blocks.length) return { ok: false, error: "The block list changed — refresh and try again." };

  await prisma.$transaction(
    ordered.map((id, index) =>
      prisma.contentBlock.update({ where: { id }, data: { position: index } }),
    ),
  );

  await writeAudit({
    actorUserId: admin.user.id,
    action: "content.blocks_reordered",
    targetType: "content_block",
    targetId: parsed.data.area,
    summary: `${admin.user.email} reordered ${parsed.data.area} blocks`,
    meta: { order: ordered },
  });

  revalidate();
  return { ok: true };
}

/** Loads a block's full payload for the inline editor (manage_content only). */
export async function getBlockForEditAction(id: unknown) {
  await requirePermission("manage_content");
  if (typeof id !== "string" || !id) return null;
  const b = await prisma.contentBlock.findUnique({ where: { id } });
  if (!b || !isBlockType(b.type)) return null;
  return {
    id: b.id,
    key: b.key,
    area: b.area,
    type: b.type as BlockTypeKey,
    title: b.title,
    position: b.position,
    status: b.status as "DRAFT" | "PUBLISHED",
    data: parseBlockData(b.type, b.data),
    rawData: b.data,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  };
}

export async function deleteBlockAction(input: unknown): Promise<BlockActionState> {
  const admin = await requirePermission("manage_content");
  const parsed = z.object({ id: z.string().min(1).max(64) }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const current = await prisma.contentBlock.findUnique({ where: { id: parsed.data.id } });
  if (!current) return { ok: true };

  await prisma.contentBlock.delete({ where: { id: current.id } });
  await writeAudit({
    actorUserId: admin.user.id,
    action: "content.block_deleted",
    targetType: "content_block",
    targetId: parsed.data.id,
    summary: `${admin.user.email} deleted a ${current.type} block`,
    meta: { type: current.type },
  });

  revalidate();
  return { ok: true };
}
