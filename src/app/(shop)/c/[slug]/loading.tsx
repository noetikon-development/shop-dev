import { Skeleton } from "@/components/ui/skeleton";
import { ProductCardSkeleton } from "@/components/product-card";

/**
 * Route-level loading UI for a category / collection page (Phase 5D Stage 9).
 * Approximates the real layout — breadcrumb, page header, the desktop filter
 * rail and the product grid — so navigating to a PLP does not flash an empty
 * screen or shift layout when the data arrives.
 */
export default function CategoryLoading() {
  return (
    <div className="container-page py-6 sm:py-8" aria-busy="true">
      <span className="sr-only">Loading products…</span>

      <Skeleton className="mb-4 h-4 w-56" />
      <Skeleton className="h-9 w-64 sm:h-11 sm:w-80" />
      <Skeleton className="mt-3 h-4 w-full max-w-md" />

      <div className="mt-8 grid gap-10 lg:grid-cols-[240px_1fr]">
        <aside className="hidden lg:block">
          <div className="space-y-7">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="space-y-3">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-2/3" />
              </div>
            ))}
          </div>
        </aside>

        <div>
          <div className="flex items-center justify-between border-b border-line pb-4">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-9 w-40" />
          </div>
          <div className="mt-6 grid grid-cols-2 gap-x-4 gap-y-9 md:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 12 }).map((_, i) => (
              <ProductCardSkeleton key={i} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
