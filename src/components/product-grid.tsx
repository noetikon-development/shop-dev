import { ProductCard } from "@/components/product-card";
import type { ProductCardView } from "@/lib/types";

export function ProductGrid({
  products,
  showCategory,
}: {
  products: ProductCardView[];
  showCategory?: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-9 md:grid-cols-3 xl:grid-cols-4">
      {products.map((p, i) => (
        <ProductCard key={p.id} product={p} showCategory={showCategory} priority={i < 6} />
      ))}
    </div>
  );
}
