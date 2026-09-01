import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { requirePermission } from "@/lib/admin/rbac";
import { prisma } from "@/lib/prisma";
import { getCategoryTree } from "@/lib/data";
import { navSchema } from "@/lib/content-blocks";
import { NAV_BLOCK_KEY, NAV_DEFAULTS } from "@/lib/nav-defaults";
import { PageHeader } from "@/components/admin/ui";
import { NavigationEditor, type CategoryOption } from "@/components/admin/content/navigation-editor";

export const metadata: Metadata = { title: "Navigation" };

export default async function AdminNavigationContentPage() {
  const admin = await requirePermission("view_content");
  const canManage = admin.isSuperAdmin || admin.permissions.has("manage_content");

  const [row, tree] = await Promise.all([
    prisma.contentBlock.findUnique({ where: { key: NAV_BLOCK_KEY }, select: { data: true } }),
    getCategoryTree(),
  ]);

  let initial = null;
  if (row) {
    try {
      const parsed = navSchema.safeParse(JSON.parse(row.data || "{}"));
      if (parsed.success) initial = parsed.data;
    } catch {
      /* fall back to defaults in the editor */
    }
  }

  // Options for the category / collection picker. The virtual collections come
  // first, then every category with its sub-categories indented. `Category`
  // stays the source of truth — this list only lets an admin *reference* it.
  const categoryOptions: CategoryOption[] = [
    { value: "new", label: "New In (collection)", depth: 0 },
    { value: "sale", label: "Sale (collection)", depth: 0 },
    { value: "all", label: "All products (collection)", depth: 0 },
    ...tree.flatMap((c) => [
      { value: c.slug, label: c.name, depth: 0 },
      ...c.children.map((ch) => ({ value: ch.slug, label: ch.name, depth: 1 })),
    ]),
  ];

  return (
    <div>
      <Link
        href="/admin/content"
        className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink"
      >
        <ChevronLeft size={15} /> Content
      </Link>
      <PageHeader
        title="Navigation"
        description="One configuration drives the desktop header, the mega-menu and the mobile menu. Items that reference a category always link to that category — you control the label, order and visibility. Changes go live within a minute, no redeploy."
      />
      <NavigationEditor
        initial={initial}
        fallback={NAV_DEFAULTS}
        categoryOptions={categoryOptions}
        canManage={canManage}
      />
    </div>
  );
}
