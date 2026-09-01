"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/admin/rbac";
import { writeAudit } from "@/lib/admin/audit";
import { navSchema, type NavData } from "@/lib/content-blocks";
import { getCategoryTree } from "@/lib/data";
import { getPublishedPageSlugs } from "@/lib/content";
import { NAV_BLOCK_KEY, NAV_SPECIAL_SLUGS, type NavActionState } from "@/lib/nav-defaults";
import type { CategoryNode } from "@/lib/types";

/**
 * Primary-navigation administration (Phase 5C). Requires `manage_content`.
 *
 * The navigation is a single `area:"global"` ContentBlock keyed `nav.primary`.
 * This action upserts it (create on first save, update thereafter). The JSON
 * payload is validated against `navSchema`, then every category reference and
 * every manual link is checked:
 *   - a category reference must be a real `Category` slug or a known virtual
 *     collection (`new` / `sale` / `all`);
 *   - a manual href must be a safe internal path, a link to a PUBLISHED content
 *     page, or an approved `https://` URL.
 * A payload that fails any check is rejected, never persisted — so the CMS can
 * never point the header at a broken or unsafe destination.
 *
 * `NAV_BLOCK_KEY` and `NavActionState` live in `@/lib/nav-defaults`
 * (a "use server" module may only export async functions).
 */

function validHref(href: string, publishedPageSlugs: Set<string>): boolean {
  const v = (href ?? "").trim();
  if (!v) return true; // blank is allowed (item may reference a category instead)
  if (v.startsWith("/pages/")) return publishedPageSlugs.has(v.slice("/pages/".length));
  if (v.startsWith("/") && !v.startsWith("//")) return true;
  return /^https:\/\/[^\s]+$/i.test(v);
}

export async function saveNavAction(
  _prev: NavActionState,
  formData: FormData,
): Promise<NavActionState> {
  const admin = await requirePermission("manage_content");

  let json: unknown;
  try {
    json = JSON.parse(String(formData.get("data") ?? "{}"));
  } catch {
    return { ok: false, error: "The navigation content is malformed." };
  }

  const parsed = navSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "The navigation content is invalid." };
  }
  const data: NavData = parsed.data;

  // --- reference + link validation -----------------------------------------
  const [tree, pageSlugs] = await Promise.all([getCategoryTree(), getPublishedPageSlugs()]);
  const slugs = new Set<string>();
  const walk = (n: CategoryNode) => {
    slugs.add(n.slug);
    n.children.forEach(walk);
  };
  tree.forEach(walk);
  const published = new Set(pageSlugs);
  const knownSlug = (s: string) =>
    !s || slugs.has(s) || (NAV_SPECIAL_SLUGS as readonly string[]).includes(s);

  for (const item of data.items) {
    if (!knownSlug(item.categorySlug)) {
      return { ok: false, error: `"${item.label || item.categorySlug}" references an unknown category (${item.categorySlug}).` };
    }
    if (!validHref(item.href, published)) {
      return { ok: false, error: `"${item.label}" has an unsafe or unavailable link (${item.href}).` };
    }
    if (!item.categorySlug && !item.href.trim()) {
      return { ok: false, error: `"${item.label || "A menu item"}" needs a category or a link.` };
    }
    for (const child of item.children) {
      if (!knownSlug(child.categorySlug)) {
        return { ok: false, error: `A "${item.label}" sub-item references an unknown category (${child.categorySlug}).` };
      }
      if (!validHref(child.href, published)) {
        return { ok: false, error: `A "${item.label}" sub-item has an unsafe or unavailable link (${child.href}).` };
      }
      if (!child.categorySlug && !child.href.trim()) {
        return { ok: false, error: `A "${item.label}" sub-item needs a category or a link.` };
      }
    }
  }

  const dataStr = JSON.stringify(data);
  const existing = await prisma.contentBlock.findUnique({ where: { key: NAV_BLOCK_KEY } });
  if (existing) {
    await prisma.contentBlock.update({
      where: { key: NAV_BLOCK_KEY },
      data: { data: dataStr, type: "navigation", area: "global", title: "Navigation", status: "PUBLISHED" },
    });
  } else {
    await prisma.contentBlock.create({
      data: {
        key: NAV_BLOCK_KEY,
        area: "global",
        type: "navigation",
        title: "Navigation",
        data: dataStr,
        position: 0,
        status: "PUBLISHED",
      },
    });
  }

  await writeAudit({
    actorUserId: admin.user.id,
    action: "content.navigation_updated",
    targetType: "content_block",
    targetId: NAV_BLOCK_KEY,
    summary: `${admin.user.email} ${existing ? "updated" : "created"} the primary navigation`,
  });

  revalidateTag("content", "max");
  revalidatePath("/", "layout");
  revalidatePath("/admin/content/navigation");

  return { ok: true };
}
