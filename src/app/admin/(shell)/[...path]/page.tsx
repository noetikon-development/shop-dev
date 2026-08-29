import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LayoutGrid } from "lucide-react";
import { requireAnyPermission } from "@/lib/admin/rbac";
import { getAdminRoute } from "@/lib/admin/navigation";
import { PageHeader, EmptyState, Card } from "@/components/admin/ui";

/**
 * Foundation page for every admin section that doesn't have a real screen yet.
 * Registry-driven: title, description, breadcrumbs (via the shell) and the
 * required permission all come from src/lib/admin/navigation.ts. Each still
 * enforces its own `accepts` permission set, so RBAC is verifiable end-to-end
 * before the CRUD tools exist.
 */

const RESERVED = new Set([
  "/admin",
  "/admin/users",
  "/admin/audit",
  "/admin/media",
  "/admin/settings",
  "/admin/products",
  "/admin/categories",
  "/admin/variants",
]);

async function resolve(pathParam: Promise<{ path: string[] }>) {
  const { path } = await pathParam;
  const full = `/admin/${path.join("/")}`;
  const route = getAdminRoute(full);
  return { full, route };
}

export async function generateMetadata({
  params,
}: PageProps<"/admin/[...path]">): Promise<Metadata> {
  const { route } = await resolve(params);
  return { title: route?.label ?? "Admin" };
}

export default async function AdminSectionFoundation({
  params,
}: PageProps<"/admin/[...path]">) {
  const { full, route } = await resolve(params);
  if (!route || RESERVED.has(full)) notFound();

  await requireAnyPermission(route.accepts);

  return (
    <div>
      <PageHeader title={route.label} description={route.description} />
      <EmptyState
        icon={<LayoutGrid size={18} />}
        title={route.emptyLabel ?? `No ${route.label.toLowerCase()} yet.`}
        description={`This is the ${route.label} foundation. Management tools are added in a later step — the layout, permissions (${route.accepts.join(" / ")}) and routing are already in place.`}
      />
      <Card className="mt-4 text-xs text-ink-faint">
        Ready for CRUD: this route enforces <code className="text-ink-soft">requireAnyPermission([{route.accepts.map((p) => `"${p}"`).join(", ")}])</code> server-side.
      </Card>
    </div>
  );
}
