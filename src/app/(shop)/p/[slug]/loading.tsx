import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading UI for a product detail page (Phase 5D Stage 9).
 * Mirrors the two-column gallery / purchase-panel layout so the page does not
 * shift when the product data arrives.
 */
export default function ProductLoading() {
  return (
    <div className="pb-10" aria-busy="true">
      <span className="sr-only">Loading product…</span>

      <div className="container-page py-5">
        <Skeleton className="h-4 w-64" />
      </div>

      <div className="container-page">
        <div className="grid gap-8 lg:grid-cols-[1.05fr_1fr] lg:gap-14">
          {/* Gallery */}
          <Skeleton className="aspect-square w-full rounded-lg" />

          {/* Purchase panel */}
          <div className="space-y-5">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-9 w-3/4 sm:h-11" />
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-7 w-32" />
            <Skeleton className="h-4 w-full max-w-sm" />

            <div className="space-y-2.5 pt-2">
              <Skeleton className="h-4 w-16" />
              <div className="flex gap-2">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-10 w-10 rounded-full" />
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-3 pt-2 sm:flex-row">
              <Skeleton className="h-12 w-28" />
              <Skeleton className="h-12 flex-1" />
            </div>
            <Skeleton className="h-11 w-full" />
          </div>
        </div>
      </div>
    </div>
  );
}
