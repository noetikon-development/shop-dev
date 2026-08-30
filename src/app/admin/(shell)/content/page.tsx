import type { Metadata } from "next";
import Link from "next/link";
import { FileText, LayoutTemplate, ImageIcon } from "lucide-react";
import { requireAnyPermission } from "@/lib/admin/rbac";
import { prisma } from "@/lib/prisma";
import { PageHeader, Card } from "@/components/admin/ui";

export const metadata: Metadata = { title: "Content" };

export default async function AdminContentHubPage() {
  await requireAnyPermission(["view_content"]);

  const [pageCount, publishedPages, blockCount, publishedBlocks, mediaCount] = await Promise.all([
    prisma.contentPage.count(),
    prisma.contentPage.count({ where: { status: "PUBLISHED" } }),
    prisma.contentBlock.count({ where: { area: "homepage" } }),
    prisma.contentBlock.count({ where: { area: "homepage", status: "PUBLISHED" } }),
    prisma.mediaAsset.count(),
  ]);

  const cards = [
    {
      href: "/admin/content/homepage",
      icon: <LayoutTemplate size={18} />,
      title: "Homepage",
      body: `${publishedBlocks} of ${blockCount} section${blockCount === 1 ? "" : "s"} published`,
      hint: "Hero, product rails, feature cards and value props.",
    },
    {
      href: "/admin/content/pages",
      icon: <FileText size={18} />,
      title: "Pages",
      body: `${publishedPages} of ${pageCount} page${pageCount === 1 ? "" : "s"} published`,
      hint: "About, FAQ, policies and other standalone pages.",
    },
    {
      href: "/admin/media",
      icon: <ImageIcon size={18} />,
      title: "Media",
      body: `${mediaCount} file${mediaCount === 1 ? "" : "s"}`,
      hint: "Images and files referenced by content, products and settings.",
    },
  ];

  return (
    <div>
      <PageHeader
        title="Content"
        description="Manage the storefront's editable content — the homepage layout, standalone pages, and the media library. Changes go live within a minute, no redeploy."
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((c) => (
          <Link key={c.href} href={c.href}>
            <Card className="h-full transition-colors hover:border-line-strong">
              <div className="flex items-center gap-2 text-ink">
                <span className="text-ink-faint">{c.icon}</span>
                <h2 className="text-sm font-semibold">{c.title}</h2>
              </div>
              <p className="mt-2 text-sm text-ink-soft">{c.body}</p>
              <p className="mt-1 text-xs text-ink-faint">{c.hint}</p>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
