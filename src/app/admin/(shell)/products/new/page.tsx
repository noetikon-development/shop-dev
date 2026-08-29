import type { Metadata } from "next";
import { requirePermission } from "@/lib/admin/rbac";
import { categorySelectOptions } from "@/lib/admin/catalog";
import { PageHeader, Card, EmptyState } from "@/components/admin/ui";
import { ProductForm } from "@/components/admin/catalog/product-form";

export const metadata: Metadata = { title: "New product" };

export default async function NewProductPage() {
  await requirePermission("create_products");
  const categories = await categorySelectOptions();

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="New product"
        description="Create the product, then add images and variants."
      />
      {categories.length === 0 ? (
        <EmptyState
          title="Create a category first"
          description="Every product needs a category. Add one under Categories, then come back."
        />
      ) : (
        <Card>
          <ProductForm categories={categories} canEdit />
        </Card>
      )}
    </div>
  );
}
