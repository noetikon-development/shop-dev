import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { requirePermission } from "@/lib/admin/rbac";
import { PageHeader } from "@/components/admin/ui";
import { ContentPageForm } from "@/components/admin/content/content-page-form";

export const metadata: Metadata = { title: "New page" };

export default async function NewContentPage() {
  await requirePermission("manage_content");
  return (
    <div>
      <Link
        href="/admin/content/pages"
        className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink"
      >
        <ChevronLeft size={15} /> All pages
      </Link>
      <PageHeader title="New page" description="Create a standalone content page." />
      <ContentPageForm />
    </div>
  );
}
