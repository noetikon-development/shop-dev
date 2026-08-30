import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { requirePermission } from "@/lib/admin/rbac";
import { listAdminBlocks, productPickerOptions } from "@/lib/admin/content";
import { getPickerAssets } from "@/lib/admin/media-picker-data";
import { getCategoryTree } from "@/lib/data";
import { PageHeader } from "@/components/admin/ui";
import { HomepageBlocksManager } from "@/components/admin/content/homepage-blocks-manager";

export const metadata: Metadata = { title: "Homepage" };

export default async function AdminHomepageContentPage() {
  const admin = await requirePermission("view_content");
  const canManage = admin.isSuperAdmin || admin.permissions.has("manage_content");

  const [rows, mediaAssets, products, tree] = await Promise.all([
    listAdminBlocks("homepage"),
    getPickerAssets(),
    productPickerOptions(),
    getCategoryTree(),
  ]);

  const categories: { slug: string; name: string }[] = [];
  const walk = (nodes: typeof tree) => {
    for (const n of nodes) {
      categories.push({ slug: n.slug, name: n.name });
      if (n.children?.length) walk(n.children);
    }
  };
  walk(tree);

  return (
    <div>
      <Link
        href="/admin/content"
        className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink"
      >
        <ChevronLeft size={15} /> Content
      </Link>
      <PageHeader
        title="Homepage"
        description="The homepage is built from these sections, top to bottom. Only published sections appear. If there are no published sections, the storefront falls back to the built-in homepage."
      />
      <HomepageBlocksManager
        rows={rows}
        canManage={canManage}
        mediaAssets={mediaAssets}
        products={products}
        categories={categories}
      />
    </div>
  );
}
