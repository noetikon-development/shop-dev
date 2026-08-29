import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { requirePermission } from "@/lib/admin/rbac";
import { getAdminCategory, categorySelectOptions } from "@/lib/admin/catalog";
import { PageHeader } from "@/components/admin/ui";
import { CategoryForm } from "@/components/admin/catalog/category-form";
import { CategoryDelete } from "@/components/admin/catalog/category-delete";

export async function generateMetadata({
  params,
}: PageProps<"/admin/categories/[id]">): Promise<Metadata> {
  const { id } = await params;
  const c = await getAdminCategory(id);
  return { title: c ? c.name : "Category" };
}

export default async function EditCategoryPage({
  params,
}: PageProps<"/admin/categories/[id]">) {
  const admin = await requirePermission("view_categories");
  const { id } = await params;
  const [category, parents] = await Promise.all([
    getAdminCategory(id),
    categorySelectOptions(id),
  ]);
  if (!category) notFound();

  const canEdit = admin.isSuperAdmin || admin.permissions.has("edit_categories");
  const canDelete = admin.isSuperAdmin || admin.permissions.has("delete_categories");

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title={category.name}
        description={`/c/${category.slug}`}
        actions={
          category.active ? (
            <Link href={`/c/${category.slug}`} target="_blank" className="btn btn-outline py-2 text-sm">
              <ExternalLink size={14} /> View
            </Link>
          ) : undefined
        }
      />

      <CategoryForm
        parents={parents}
        canEdit={canEdit}
        category={{
          id: category.id,
          name: category.name,
          slug: category.slug,
          description: category.description,
          parentId: category.parentId,
          heroColor: category.heroColor,
          sortOrder: category.sortOrder,
          featured: category.featured,
          active: category.active,
          imageUrl: category.imageMedia?.url ?? category.imageUrl,
        }}
      />

      {canDelete && (
        <CategoryDelete
          categoryId={category.id}
          name={category.name}
          productCount={category._count.products}
          childCount={category._count.children}
        />
      )}
    </div>
  );
}
