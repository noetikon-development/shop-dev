"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/admin/rbac";
import { writeAudit } from "@/lib/admin/audit";
import { footerSchema } from "@/lib/content-blocks";
import { getCategoryTree } from "@/lib/data";
import { FOOTER_BLOCK_KEY, type FooterActionState } from "@/lib/footer-defaults";
import { NAV_SPECIAL_SLUGS } from "@/lib/nav-defaults";
import type { CategoryNode } from "@/lib/types";

/**
 * Site-footer content administration (Phase 5A). Requires `manage_content`.
 *
 * The footer is a single `area:"global"` ContentBlock keyed `footer.default`.
 * This action upserts it (create on first save, update thereafter) so the
 * storefront fallback works before the block exists, and the block becomes the
 * source once populated. The JSON payload is validated against `footerSchema`
 * before it is written — a bad payload is rejected, never persisted.
 *
 * Business values (support email, social URLs, legal name) live in Store
 * Settings and are NOT written here.
 *
 * `FOOTER_BLOCK_KEY` and `FooterActionState` live in `@/lib/footer-defaults`
 * (a "use server" module may only export async functions).
 */

export async function saveFooterAction(
  _prev: FooterActionState,
  formData: FormData,
): Promise<FooterActionState> {
  const admin = await requirePermission("manage_content");

  let json: unknown;
  try {
    json = JSON.parse(String(formData.get("data") ?? "{}"));
  } catch {
    return { ok: false, error: "The footer content is malformed." };
  }

  const parsed = footerSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "The footer content is invalid." };
  }

  // A Shop-column link that references a category must reference a real one.
  const referenced = parsed.data.shopColumn.links
    .map((l) => l.categorySlug)
    .filter((s): s is string => Boolean(s));
  if (referenced.length > 0) {
    const tree = await getCategoryTree();
    const slugs = new Set<string>();
    const walk = (n: CategoryNode) => {
      slugs.add(n.slug);
      n.children.forEach(walk);
    };
    tree.forEach(walk);
    const known = (s: string) => slugs.has(s) || (NAV_SPECIAL_SLUGS as readonly string[]).includes(s);
    const bad = referenced.find((s) => !known(s));
    if (bad) return { ok: false, error: `Unknown category reference in the Shop column: ${bad}.` };
  }

  const dataStr = JSON.stringify(parsed.data);

  const existing = await prisma.contentBlock.findUnique({ where: { key: FOOTER_BLOCK_KEY } });
  if (existing) {
    await prisma.contentBlock.update({
      where: { key: FOOTER_BLOCK_KEY },
      data: { data: dataStr, type: "footer", area: "global", title: "Footer", status: "PUBLISHED" },
    });
  } else {
    await prisma.contentBlock.create({
      data: {
        key: FOOTER_BLOCK_KEY,
        area: "global",
        type: "footer",
        title: "Footer",
        data: dataStr,
        position: 0,
        status: "PUBLISHED",
      },
    });
  }

  await writeAudit({
    actorUserId: admin.user.id,
    action: "content.footer_updated",
    targetType: "content_block",
    targetId: FOOTER_BLOCK_KEY,
    summary: `${admin.user.email} ${existing ? "updated" : "created"} the site footer`,
  });

  revalidateTag("content", "max");
  revalidatePath("/", "layout");
  revalidatePath("/admin/content/footer");

  return { ok: true };
}
