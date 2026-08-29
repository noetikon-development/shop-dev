import type { Metadata } from "next";
import { requirePermission } from "@/lib/admin/rbac";
import { categorySelectOptions } from "@/lib/admin/catalog";
import { PageHeader } from "@/components/admin/ui";
import { CategoryForm } from "@/components/admin/catalog/category-form";

export const metadata: Metadata = { title: "New category" };

export default async function NewCategoryPage() {
  await requirePermission("create_categories");
  const parents = await categorySelectOptions();

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="New category" />
      <CategoryForm parents={parents} canEdit />
    </div>
  );
}
