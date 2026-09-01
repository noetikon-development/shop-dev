import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { requirePermission } from "@/lib/admin/rbac";
import { prisma } from "@/lib/prisma";
import { getCategoryTree } from "@/lib/data";
import { footerSchema } from "@/lib/content-blocks";
import { FOOTER_DEFAULTS, FOOTER_BLOCK_KEY } from "@/lib/footer-defaults";
import { PageHeader } from "@/components/admin/ui";
import {
  FooterEditor,
  type FooterCategoryOption,
} from "@/components/admin/content/footer-editor";

export const metadata: Metadata = { title: "Footer" };

export default async function AdminFooterContentPage() {
  const admin = await requirePermission("view_content");
  const canManage = admin.isSuperAdmin || admin.permissions.has("manage_content");

  const [row, tree] = await Promise.all([
    prisma.contentBlock.findUnique({
      where: { key: FOOTER_BLOCK_KEY },
      select: { data: true },
    }),
    getCategoryTree(),
  ]);

  const categoryOptions: FooterCategoryOption[] = [
    { value: "sale", label: "Sale (collection)", depth: 0 },
    { value: "all", label: "All products (collection)", depth: 0 },
    ...tree.flatMap((c) => [
      { value: c.slug, label: c.name, depth: 0 },
      ...c.children.map((ch) => ({ value: ch.slug, label: ch.name, depth: 1 })),
    ]),
  ];

  let initial = null;
  if (row) {
    try {
      const parsed = footerSchema.safeParse(JSON.parse(row.data || "{}"));
      if (parsed.success) initial = parsed.data;
    } catch {
      /* fall back to defaults in the editor */
    }
  }

  return (
    <div>
      <Link
        href="/admin/content"
        className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink"
      >
        <ChevronLeft size={15} /> Content
      </Link>
      <PageHeader
        title="Footer"
        description="The site-wide footer. Business values (support email, social links, legal name) are set in Settings and shown automatically — edit the wording and links here. Changes go live within a minute, no redeploy."
      />
      <FooterEditor
        initial={initial}
        fallback={FOOTER_DEFAULTS}
        canManage={canManage}
        categoryOptions={categoryOptions}
      />
    </div>
  );
}
