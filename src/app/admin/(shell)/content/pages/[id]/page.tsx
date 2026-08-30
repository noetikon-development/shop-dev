import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, ExternalLink } from "lucide-react";
import { getCurrentAdmin, requirePermission } from "@/lib/admin/rbac";
import { getAdminPage } from "@/lib/admin/content";
import { PageHeader, StatusBadge } from "@/components/admin/ui";
import { ContentPageForm } from "@/components/admin/content/content-page-form";

export async function generateMetadata({
  params,
}: PageProps<"/admin/content/pages/[id]">): Promise<Metadata> {
  const admin = await getCurrentAdmin();
  if (!admin || !(admin.isSuperAdmin || admin.permissions.has("view_content"))) {
    return { title: "Page" };
  }
  const { id } = await params;
  const page = await getAdminPage(id);
  return { title: page ? page.title : "Page" };
}

export default async function EditContentPage({ params }: PageProps<"/admin/content/pages/[id]">) {
  await requirePermission("manage_content");
  const { id } = await params;
  const page = await getAdminPage(id);
  if (!page) notFound();

  return (
    <div>
      <Link
        href="/admin/content/pages"
        className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink"
      >
        <ChevronLeft size={15} /> All pages
      </Link>
      <PageHeader title={page.title} description={`/pages/${page.slug}`}>
        <div className="flex items-center gap-3">
          <StatusBadge tone={page.status === "PUBLISHED" ? "success" : "neutral"}>
            {page.status === "PUBLISHED" ? "Published" : "Draft"}
          </StatusBadge>
          {page.status === "PUBLISHED" && (
            <a
              href={`/pages/${page.slug}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-ink-soft hover:text-ink"
            >
              View <ExternalLink size={12} />
            </a>
          )}
        </div>
      </PageHeader>
      <ContentPageForm page={page} />
    </div>
  );
}
