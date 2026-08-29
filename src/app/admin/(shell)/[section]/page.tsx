import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireAnyPermission } from "@/lib/admin/rbac";
import { findAdminSection, ADMIN_RESERVED_SLUGS } from "@/lib/admin/sections";

export async function generateMetadata({
  params,
}: PageProps<"/admin/[section]">): Promise<Metadata> {
  const { section } = await params;
  return { title: findAdminSection(section)?.label ?? "Admin" };
}

/**
 * Placeholder for every admin section that doesn't have a real screen yet. Each
 * still enforces its own `view_*` permission, so role-based access can be
 * verified end-to-end before the CRUD tools exist.
 */
export default async function AdminSectionPlaceholder({
  params,
}: PageProps<"/admin/[section]">) {
  const { section } = await params;
  const meta = findAdminSection(section);
  if (!meta || ADMIN_RESERVED_SLUGS.has(section)) notFound();

  await requireAnyPermission(meta.accepts);

  return (
    <div className="mx-auto max-w-3xl">
      <p className="eyebrow">Admin</p>
      <h1 className="mt-1 text-3xl">{meta.label}</h1>
      <div className="card-surface mt-6 p-6">
        <p className="text-sm text-ink-soft">
          You have access to this section (
          <code className="text-ink">{meta.accepts.join(" / ")}</code>). The{" "}
          {meta.label.toLowerCase()} management tools are part of the next step — this
          build covers authentication, roles and permissions only.
        </p>
      </div>
    </div>
  );
}
