import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { requirePermission } from "@/lib/admin/rbac";
import { listAdminCategories } from "@/lib/admin/catalog";
import { PageHeader, SearchInput, FilterBar, EmptyState } from "@/components/admin/ui";
import { CategoryList } from "@/components/admin/catalog/category-list";

export const metadata: Metadata = { title: "Categories" };

export default async function AdminCategoriesPage({
  searchParams,
}: PageProps<"/admin/categories">) {
  const admin = await requirePermission("view_categories");
  const canCreate = admin.isSuperAdmin || admin.permissions.has("create_categories");
  const canEdit = admin.isSuperAdmin || admin.permissions.has("edit_categories");
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : undefined;

  const categories = await listAdminCategories(q);

  return (
    <div>
      <PageHeader
        title="Categories"
        description="The browsable category tree. Inactive categories are hidden from the storefront (their products stay in the catalog)."
        actions={
          canCreate ? (
            <Link href="/admin/categories/new" className="btn btn-primary py-2 text-sm">
              <Plus size={15} /> New category
            </Link>
          ) : undefined
        }
      />

      <FilterBar>
        <SearchInput placeholder="Search name or slug…" />
      </FilterBar>

      <div className="mt-4">
        {categories.length === 0 ? (
          <EmptyState
            title={q ? "No categories match." : "No categories yet."}
            description={canCreate ? "Create one to organise your products." : undefined}
          />
        ) : (
          <CategoryList
            canEdit={canEdit}
            categories={categories.map((c) => ({
              id: c.id,
              name: c.name,
              slug: c.slug,
              active: c.active,
              featured: c.featured,
              sortOrder: c.sortOrder,
              parentName: c.parent?.name ?? null,
              productCount: c._count.products,
              childCount: c._count.children,
            }))}
          />
        )}
      </div>
    </div>
  );
}
