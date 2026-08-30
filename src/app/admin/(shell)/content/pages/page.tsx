import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, Plus } from "lucide-react";
import { requirePermission } from "@/lib/admin/rbac";
import { listAdminPages } from "@/lib/admin/content";
import { PageHeader } from "@/components/admin/ui";
import { PagesTable } from "@/components/admin/content/pages-table";

export const metadata: Metadata = { title: "Content pages" };

export default async function AdminContentPagesPage() {
  const admin = await requirePermission("view_content");
  const canManage = admin.isSuperAdmin || admin.permissions.has("manage_content");
  const rows = await listAdminPages();

  return (
    <div>
      <Link href="/admin/content" className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink">
        <ChevronLeft size={15} /> Content
      </Link>
      <PageHeader
        title="Pages"
        description="Standalone pages served at /pages/<slug>. Body is Markdown, rendered as text — no HTML is executed."
        actions={
          canManage ? (
            <Link href="/admin/content/pages/new" className="btn btn-primary py-2 text-sm">
              <Plus size={14} /> New page
            </Link>
          ) : undefined
        }
      />
      <PagesTable rows={rows} canManage={canManage} />
    </div>
  );
}
