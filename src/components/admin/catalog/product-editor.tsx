"use client";

import { useState } from "react";
import { Tabs } from "@/components/admin/ui";
import { ProductForm } from "@/components/admin/catalog/product-form";
import { ProductImages } from "@/components/admin/catalog/product-images";
import { ProductVariants } from "@/components/admin/catalog/product-variants";

type CategoryOption = { id: string; label: string };

type Props = {
  categories: CategoryOption[];
  product: React.ComponentProps<typeof ProductForm>["product"] & { id: string };
  images: React.ComponentProps<typeof ProductImages>["images"];
  options: React.ComponentProps<typeof ProductVariants>["options"];
  variants: React.ComponentProps<typeof ProductVariants>["variants"];
  perms: {
    edit: boolean;
    manageImages: boolean;
    create: boolean;
    delete: boolean;
  };
};

export function ProductEditor({ categories, product, images, options, variants, perms }: Props) {
  const [tab, setTab] = useState("details");

  return (
    <Tabs
      value={tab}
      onValueChange={setTab}
      items={[
        { value: "details", label: "Details" },
        { value: "images", label: `Images (${images.length})` },
        { value: "variants", label: `Variants (${variants.length})` },
      ]}
    >
      {(active) => (
        <div className="rounded-md border border-line bg-surface p-5">
          {active === "details" && (
            <ProductForm categories={categories} product={product} canEdit={perms.edit} />
          )}
          {active === "images" && (
            <ProductImages
              productId={product.id}
              images={images}
              canManage={perms.manageImages}
            />
          )}
          {active === "variants" && (
            <ProductVariants
              productId={product.id}
              options={options}
              variants={variants}
              canEdit={perms.edit}
              canCreate={perms.create}
              canDelete={perms.delete}
            />
          )}
        </div>
      )}
    </Tabs>
  );
}
