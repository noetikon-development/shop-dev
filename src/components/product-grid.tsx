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
    <div className="grid grid-cols-2 gap-x-4 gap-y-9 sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4">
      {products.map((p, i) => (
        <ProductCard key={p.id} product={p} showCategory={showCategory} priority={i < 6} />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  message,
  action,
}: {
  title: string;
  message: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-line-strong px-6 py-20 text-center">
      <h3 className="text-lg">{title}</h3>
      <p className="mt-2 max-w-sm text-sm text-ink-soft">{message}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
