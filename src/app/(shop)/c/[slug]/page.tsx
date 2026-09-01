import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { getCategoryBySlug, listProducts } from "@/lib/data";
import { getSiteSettings } from "@/lib/site-settings";
import { parseListingParams, buildQuery, countActiveFilters } from "@/lib/listing-params";
import { ProductGrid } from "@/components/product-grid";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterControls } from "@/components/plp/filter-controls";
import { FilterDrawer } from "@/components/plp/filter-drawer";
import { SortSelect } from "@/components/plp/sort-select";
import { ActiveFilters } from "@/components/plp/active-filters";
import { Pagination } from "@/components/plp/pagination";
import { pluralize } from "@/lib/utils";

// Product SELECTION for these virtual collections is application logic
// (`forceNew` / `forceSale`) and stays here. The customer-facing title /
// description are CMS-editable (Store Settings → Storefront content); the
// strings below are only the fallback when a setting is blank.
type SpecialSlug = {
  key: "all" | "new" | "sale";
  title: string;
  description: string;
  forceSale?: boolean;
  forceNew?: boolean;
};
const SPECIAL: Record<string, SpecialSlug> = {
  all: { key: "all", title: "All products", description: "The complete catalogue." },
  new: {
    key: "new",
    title: "New In",
    description: "The latest additions across furniture, lighting, textiles and wardrobe.",
    forceNew: true,
  },
  sale: {
    key: "sale",
    title: "Sale",
    description: "Current markdowns while stock lasts.",
    forceSale: true,
  },
};

/** Resolve a special collection's copy: CMS setting first, built-in fallback. */
function specialCopy(
  special: SpecialSlug,
  settings: Awaited<ReturnType<typeof getSiteSettings>>,
): { title: string; description: string } {
  const cms = settings.collections[special.key];
  return {
    title: cms.title || special.title,
    description: cms.description || special.description,
  };
}

export async function generateMetadata({
  params,
}: PageProps<"/c/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  if (SPECIAL[slug]) {
    const copy = specialCopy(SPECIAL[slug], await getSiteSettings());
    return {
      title: copy.title,
      description: copy.description,
      alternates: { canonical: `/c/${slug}` },
    };
  }
  const cat = await getCategoryBySlug(slug);
  if (!cat) return { title: "Not found" };
  const settings = await getSiteSettings();
  return {
    title: cat.name,
    description: cat.description ?? `Shop ${cat.name} at ${settings.brand}.`,
    alternates: { canonical: `/c/${slug}` },
  };
}

export default async function CategoryPage({ params, searchParams }: PageProps<"/c/[slug]">) {
  const { slug } = await params;
  const sp = await searchParams;
  const special = SPECIAL[slug];

  const cat = special ? null : await getCategoryBySlug(slug);
  if (!special && !cat) notFound();

  const listingParams = parseListingParams(sp, {
    categorySlug: special ? undefined : slug,
    forceSale: special?.forceSale,
    forceNew: special?.forceNew,
  });

  const [result, settings] = await Promise.all([
    listProducts(listingParams),
    special ? getSiteSettings() : Promise.resolve(null),
  ]);

  const copy = special && settings ? specialCopy(special, settings) : null;
  const title = copy ? copy.title : cat!.name;
  const description = copy ? copy.description : cat!.description;
  const currentSp = new URLSearchParams(
    Object.entries(sp).flatMap(([k, v]) =>
      v == null ? [] : Array.isArray(v) ? v.map((x) => [k, x] as [string, string]) : [[k, v] as [string, string]],
    ),
  );
  const activeCount = countActiveFilters(currentSp);

  const makeHref = (page: number) =>
    `/c/${slug}${buildQuery(currentSp, { page: page > 1 ? page : null })}`;

  return (
    <div className="container-page py-6 sm:py-8">
      {/* Breadcrumb */}
      <nav className="flex flex-wrap items-center gap-1.5 text-xs text-ink-faint">
        <Link href="/" className="hover:text-ink">
          Home
        </Link>
        <ChevronRight size={12} />
        {!special && cat?.parent ? (
          <>
            <Link href={`/c/${cat.parent.slug}`} className="hover:text-ink">
              {cat.parent.name}
            </Link>
            <ChevronRight size={12} />
            <span className="text-ink">{title}</span>
          </>
        ) : (
          <span className="text-ink">{title}</span>
        )}
      </nav>

      <header className="mt-4 max-w-2xl">
        <h1 className="text-3xl sm:text-display">{title}</h1>
        {description && <p className="mt-2.5 text-ink-soft">{description}</p>}
      </header>

      {/* Subcategory chips */}
      {!special && cat && cat.children.length > 0 && (
        <div className="no-scrollbar mt-6 flex gap-2 overflow-x-auto pb-1">
          {cat.children.map((child) => (
            <Link
              key={child.id}
              href={`/c/${child.slug}`}
              className="shrink-0 rounded-full border border-line-strong bg-surface px-3.5 py-1.5 text-sm text-ink-soft transition-colors hover:border-ink hover:text-ink"
            >
              {child.name}{" "}
              <span className="text-ink-faint">{child._count.products}</span>
            </Link>
          ))}
        </div>
      )}

      <div className="mt-8 grid gap-10 lg:grid-cols-[240px_1fr]">
        <aside className="hidden lg:block">
          <div className="sticky top-28">
            <FilterControls
              colorFacets={result.colorFacets}
              priceBounds={result.priceBounds}
            />
          </div>
        </aside>

        <div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
            <p className="text-sm text-ink-soft">
              {result.total} {pluralize(result.total, "product")}
            </p>
            <div className="flex items-center gap-2.5">
              <FilterDrawer
                colorFacets={result.colorFacets}
                priceBounds={result.priceBounds}
                activeCount={activeCount}
              />
              <SortSelect />
            </div>
          </div>

          <div className="mt-4">
            <ActiveFilters />
          </div>

          <div className="mt-6">
            {result.products.length === 0 ? (
              <EmptyState
                title="No products match those filters"
                message="Try widening your price range or clearing a filter or two."
                action={
                  <Link href={`/c/${slug}`} className="btn btn-outline">
                    Clear filters
                  </Link>
                }
              />
            ) : (
              <>
                <ProductGrid products={result.products} showCategory={Boolean(special)} />
                <Pagination
                  page={result.page}
                  pageCount={result.pageCount}
                  makeHref={makeHref}
                />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
