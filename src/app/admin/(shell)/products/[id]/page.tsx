import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/admin/rbac";
import { getAdminProduct, categorySelectOptions } from "@/lib/admin/catalog";
import { PageHeader } from "@/components/admin/ui";
import { ProductEditor } from "@/components/admin/catalog/product-editor";
import { ProductActions } from "@/components/admin/catalog/product-actions";

export async function generateMetadata({
  params,
}: PageProps<"/admin/products/[id]">): Promise<Metadata> {
  const { id } = await params;
  const p = await getAdminProduct(id);
  return { title: p ? p.name : "Product" };
}

export default async function EditProductPage({
  params,
}: PageProps<"/admin/products/[id]">) {
  const admin = await requirePermission("view_products");
  const { id } = await params;
  const [product, categories] = await Promise.all([
    getAdminProduct(id),
    categorySelectOptions(),
  ]);
  if (!product) notFound();

  const perms = {
    edit: admin.isSuperAdmin || admin.permissions.has("edit_products"),
    manageImages: admin.isSuperAdmin || admin.permissions.has("manage_product_images"),
    create: admin.isSuperAdmin || admin.permissions.has("create_products"),
    delete: admin.isSuperAdmin || admin.permissions.has("delete_products"),
  };

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={product.name}
        description={`/p/${product.slug} · ${product.category.name}`}
        actions={
          <ProductActions
            productId={product.id}
            slug={product.slug}
            status={product.status}
            isActive={product.status === "ACTIVE"}
            canEdit={perms.edit}
            canDelete={perms.delete}
          />
        }
      />

      <ProductEditor
        categories={categories}
        product={{
          id: product.id,
          name: product.name,
          slug: product.slug,
          shortDescription: product.shortDescription,
          description: product.description,
          categoryId: product.category.id,
          status: product.status,
          featured: product.featured,
          freeShipping: product.freeShipping,
          price: product.price,
          compareAtPrice: product.compareAtPrice,
          weightGrams: product.weightGrams,
          variantCount: product.variants.length,
          specs: product.specs,
          highlights: product.highlights,
          care: product.care,
        }}
        images={product.images.map((img) => ({
          id: img.id,
          url: img.url,
          alt: img.alt,
          optionValueId: img.optionValueId ?? null,
          isUpload: Boolean(img.mediaAssetId),
          sizeLabel: img.mediaAsset
            ? `${Math.max(1, Math.round(img.mediaAsset.sizeBytes / 1024))} KB`
            : undefined,
        }))}
        colours={
          product.options
            .find((o) => o.name === "Colour")
            ?.values.map((v) => ({ id: v.id, value: v.value, swatchHex: v.swatchHex })) ?? []
        }
        options={product.options.map((o) => ({
          id: o.id,
          name: o.name,
          values: o.values.map((v) => ({ id: v.id, value: v.value })),
        }))}
        variants={product.variants.map((v) => ({
          id: v.id,
          sku: v.sku,
          price: v.price,
          compareAtPrice: v.compareAtPrice,
          status: v.status,
          optionValueIds: v.optionValues.map((ov) => ov.optionValueId),
          orderItemCount: v._count.orderItems,
        }))}
        perms={perms}
      />
    </div>
  );
}
