import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { requireAnyPermission } from "@/lib/admin/rbac";
import { listEmailTemplateSummaries } from "@/lib/admin/email-templates";
import { PageHeader, Card, StatusBadge } from "@/components/admin/ui";

export const metadata: Metadata = { title: "Email Templates" };

export default async function AdminEmailTemplatesPage() {
  await requireAnyPermission(["view_content"]);
  const groups = await listEmailTemplateSummaries();

  return (
    <div>
      <Link
        href="/admin/content"
        className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink"
      >
        <ChevronLeft size={15} /> Content
      </Link>
      <PageHeader
        title="Email Templates"
        description="Customize the subject, heading, body and action button for every 3P seller and PayMongo payment email. A template with no customization uses the application's built-in default — nothing here can ever leave an email un-sendable. Changes apply to the very next email sent, no redeploy."
      />
      <div className="space-y-8">
        {groups.map((g) => (
          <div key={g.category}>
            <h2 className="mb-3 text-sm font-semibold text-ink">{g.categoryLabel}</h2>
            <Card className="divide-y divide-line !p-0">
              {g.templates.map((t) => (
                <Link
                  key={t.key}
                  href={`/admin/content/email-templates/${t.key}`}
                  className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-paper"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{t.label}</p>
                    <p className="truncate text-xs text-ink-faint">{t.description}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    {!t.hasOverride ? (
                      <StatusBadge tone="neutral">Default</StatusBadge>
                    ) : t.published ? (
                      <StatusBadge tone="success">Customized</StatusBadge>
                    ) : (
                      <StatusBadge tone="warning">Disabled (draft)</StatusBadge>
                    )}
                    <ChevronRight size={16} className="text-ink-faint" />
                  </div>
                </Link>
              ))}
            </Card>
          </div>
        ))}
      </div>
    </div>
  );
}
