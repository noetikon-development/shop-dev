import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requirePermission } from "@/lib/admin/rbac";
import { getEmailTemplateEditState } from "@/lib/admin/email-templates";
import { PageHeader } from "@/components/admin/ui";
import { EmailTemplateEditor } from "@/components/admin/content/email-template-editor";

export async function generateMetadata({
  params,
}: PageProps<"/admin/content/email-templates/[key]">): Promise<Metadata> {
  const { key } = await params;
  return { title: key };
}

export default async function AdminEmailTemplateEditPage({
  params,
}: PageProps<"/admin/content/email-templates/[key]">) {
  const admin = await requirePermission("view_content");
  const canManage = admin.isSuperAdmin || admin.permissions.has("manage_content");
  const { key } = await params;

  const state = await getEmailTemplateEditState(key);
  if (!state) notFound();

  return (
    <div>
      <Link
        href="/admin/content/email-templates"
        className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink"
      >
        <ChevronLeft size={15} /> Email Templates
      </Link>
      <PageHeader title={state.def.label} description={state.def.description} />
      <EmailTemplateEditor state={state} canManage={canManage} />
    </div>
  );
}
