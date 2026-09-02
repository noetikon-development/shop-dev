import Link from "next/link";
import type { Metadata } from "next";
import { listProducts } from "@/lib/data";
import { parseListingParams, buildQuery, countActiveFilters } from "@/lib/listing-params";
import { ProductGrid } from "@/components/product-grid";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClasses } from "@/components/ui/button";
import { FilterControls } from "@/components/plp/filter-controls";
import { FilterDrawer } from "@/components/plp/filter-drawer";
import { SortSelect } from "@/components/plp/sort-select";
import { ActiveFilters } from "@/components/plp/active-filters";
import { Pagination } from "@/components/plp/pagination";
import { pluralize } from "@/lib/utils";

export async function generateMetadata({
  searchParams,
}: PageProps<"/search">): Promise<Metadata> {
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : "";
  return { title: q ? `Search: ${q}` : "Search" };
}

export default async function SearchPage({ searchParams }: PageProps<"/search">) {
  const sp = await searchParams;
  const query = typeof sp.q === "string" ? sp.q : "";

  const listingParams = parseListingParams(sp, {});
  const result = query
    ? await listProducts(listingParams)
    : { products: [], total: 0, page: 1, pageCount: 0, priceBounds: { min: 0, max: 0 }, colorFacets: [], perPage: 24 };

  const currentSp = new URLSearchParams(
    Object.entries(sp).flatMap(([k, v]) =>
      v == null ? [] : Array.isArray(v) ? v.map((x) => [k, x] as [string, string]) : [[k, v] as [string, string]],
    ),
  );
  const activeCount = countActiveFilters(currentSp);
  const makeHref = (page: number) => `/search${buildQuery(currentSp, { page: page > 1 ? page : null })}`;

  return (
    <div className="container-page py-8">
      <header className="max-w-2xl">
        <p className="eyebrow">Search</p>
        <h1 className="mt-2 text-title sm:text-display">
          {query ? (
            <>
              Results for <span className="italic">“{query}”</span>
            </>
          ) : (
            "Search the catalogue"
          )}
        </h1>
        {query && (
          <p className="mt-2 text-ink-soft">
            {result.total} {pluralize(result.total, "product")} found
          </p>
        )}
      </header>

      {!query ? (
        <div className="mt-10">
          <EmptyState
            title="Type a search above"
            message="Try a material, a room, or a product name — “oak table”, “linen”, “sneakers”."
          />
        </div>
      ) : result.total === 0 ? (
        <div className="mt-10">
          <EmptyState
            title="Nothing matched that search"
            message="Check the spelling, or browse by category instead."
            action={
              <Link href="/c/all" className={buttonClasses({ variant: "outline" })}>
                Browse all products
              </Link>
            }
          />
        </div>
      ) : (
        <div className="mt-8 grid gap-10 lg:grid-cols-[240px_1fr]">
          <aside className="hidden lg:block">
            <div className="sticky top-28">
              <FilterControls colorFacets={result.colorFacets} priceBounds={result.priceBounds} />
            </div>
          </aside>
          <div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
              <div className="lg:hidden">
                <FilterDrawer
                  colorFacets={result.colorFacets}
                  priceBounds={result.priceBounds}
                  activeCount={activeCount}
                />
              </div>
              <SortSelect />
            </div>
            <div className="mt-4">
              <ActiveFilters />
            </div>
            <div className="mt-6">
              <ProductGrid products={result.products} showCategory />
              <Pagination page={result.page} pageCount={result.pageCount} makeHref={makeHref} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
