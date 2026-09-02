import { Skeleton } from "@/components/ui/skeleton";
import { ProductCardSkeleton } from "@/components/product-card";

/**
 * Route-level loading UI for the search results page (Phase 5D Stage 9).
 * Approximates the header + results grid so a search does not flash empty.
 */
export default function SearchLoading() {
  return (
    <div className="container-page py-8" aria-busy="true">
      <span className="sr-only">Searching…</span>

      <div className="max-w-2xl">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="mt-2 h-9 w-72 sm:h-11" />
        <Skeleton className="mt-2 h-4 w-40" />
      </div>

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
          <div className="flex items-center justify-end border-b border-line pb-4">
            <Skeleton className="h-9 w-40" />
          </div>
          <div className="mt-6 grid grid-cols-2 gap-x-4 gap-y-9 md:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <ProductCardSkeleton key={i} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
