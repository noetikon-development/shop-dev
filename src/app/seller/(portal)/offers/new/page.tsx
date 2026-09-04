import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Search, FolderTree, Store, Archive } from "lucide-react";
import { requireSellerSessionPermission } from "@/lib/seller/session";
import {
  findListableVariants,
  listListingCategories,
  getListableVariantState,
} from "@/lib/seller/offers";
import { PageHeader, Card, EmptyState } from "@/components/seller/ui";
import { OfferCreateForm } from "@/components/seller/offer-create-form";
import { pesos } from "@/lib/seller/format";

export const metadata: Metadata = { title: "Add listing" };

export default async function AddSellerListingPage({
  searchParams,
}: PageProps<"/seller/offers/new">) {
  const { ctx } = await requireSellerSessionPermission("manage_offers");
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim() : undefined;
  const categoryId = typeof sp.category === "string" ? sp.category : undefined;
  const variantId = typeof sp.variantId === "string" ? sp.variantId : undefined;

  // ── Step 2 — a specific catalog variant is chosen ──────────────────────────
  if (variantId) {
    const v = await getListableVariantState(ctx, variantId);
    if (v.state === "not_found") notFound();

    return (
      <div>
        <PageHeader title="Add listing" />
        <Link
          href="/seller/offers/new"
          className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink"
        >
          <ArrowLeft size={14} /> Choose a different product
        </Link>

        {v.state === "archived" ? (
          <Card className="max-w-xl">
            <div className="flex gap-3">
              <Archive size={18} className="mt-0.5 shrink-0 text-ink-faint" />
              <div>
                <p className="text-sm font-semibold text-ink">
                  You can&rsquo;t create a listing for {v.productName}
                </p>
                <p className="mt-1 text-sm text-ink-soft">
                  {v.reason} It&rsquo;s no longer part of the sellable catalog, so a new listing can&rsquo;t
                  be created against it. If Axiaro brings it back, it&rsquo;ll reappear here.
                </p>
                <Link href="/seller/offers/new" className="mt-3 inline-block text-xs text-clay hover:underline">
                  Pick another product ↗
                </Link>
              </div>
            </div>
          </Card>
        ) : (
          <Card className="max-w-xl">
            <div className="mb-4 border-b border-line pb-4">
              <p className="mb-1 inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
                <Store size={12} /> Axiaro catalog product
              </p>
              <p className="text-sm font-semibold text-ink">{v.productName}</p>
              <p className="text-xs text-ink-faint">
                {v.categoryName} · {v.optionLabel} · {v.sku} · catalog price {pesos(v.catalogPrice)}
              </p>
              <Link
                href={`/p/${v.productSlug}`}
                target="_blank"
                className="mt-1 inline-block text-[11px] text-clay hover:underline"
              >
                View storefront page ↗
              </Link>
              <p className="mt-2 text-xs text-ink-soft">
                Axiaro owns the product — its name, images, description and specs. You set your own
                price, condition and stock.
              </p>
            </div>

            {v.takenConditions.length >= 4 ? (
              <div className="rounded-sm bg-warning-50 px-3 py-2 text-sm text-warning">
                You already list this product option in every condition.{" "}
                <Link href="/seller/offers" className="underline">
                  See your listings
                </Link>
                .
              </div>
            ) : (
              <OfferCreateForm
                variantId={v.variantId}
                catalogPrice={v.catalogPrice}
                catalogCompareAt={v.catalogCompareAt}
                takenConditions={v.takenConditions}
              />
            )}
          </Card>
        )}
      </div>
    );
  }

  // ── Step 1 — pick a catalog product ───────────────────────────────────────
  const browsing = Boolean(categoryId);
  const [variants, categories] = await Promise.all([
    q || categoryId ? findListableVariants(ctx, { q, categoryId, limit: 30 }) : Promise.resolve([]),
    listListingCategories(),
  ]);
  const activeCategory = categoryId ? categories.find((c) => c.id === categoryId) : undefined;

  return (
    <div>
      <PageHeader
        title="Add listing"
        description="Pick the Axiaro catalog product you want to list. Axiaro owns the product; you set the price, condition and stock. Your listing starts as a draft."
      />
      <Link
        href="/seller/offers"
        className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink"
      >
        <ArrowLeft size={14} /> Back to Listings
      </Link>

      <div className="grid gap-6 lg:grid-cols-[1fr_240px]">
        <Card className="min-w-0">
          <form method="get" className="flex gap-2">
            <div className="relative flex-1">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint" />
              <input
                type="search"
                name="q"
                defaultValue={q ?? ""}
                placeholder="Search the catalog by product name or SKU…"
                className="field py-2 pl-9 text-sm"
              />
            </div>
            <button type="submit" className="btn btn-outline py-2 text-sm">
              Search
            </button>
          </form>

          <div className="mt-4">
            {activeCategory && (
              <p className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-soft">
                <FolderTree size={14} className="text-ink-faint" />
                Browsing <strong className="text-ink">{activeCategory.name}</strong>
                <Link href="/seller/offers/new" className="ml-2 text-xs text-clay hover:underline">
                  clear
                </Link>
              </p>
            )}

            {!q && !browsing ? (
              <p className="py-6 text-center text-sm text-ink-faint">
                Search the catalog, or browse a category, to find a product to list.
              </p>
            ) : variants.length === 0 ? (
              <EmptyState
                title="Nothing to list here"
                description="Nothing in the catalog matches — or you already list every match. If Axiaro doesn't carry your product yet, requesting a new one opens in a later phase."
                compact
              />
            ) : (
              <ul className="divide-y divide-line-soft">
                {variants.map((v) => (
                  <li key={v.variantId}>
                    <Link
                      href={`/seller/offers/new?variantId=${v.variantId}`}
                      className="flex items-center gap-3 px-1 py-3 text-sm hover:bg-surface-sunken"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-ink">{v.productName}</span>
                        <span className="block truncate text-xs text-ink-faint">
                          {v.categoryName} · {v.optionLabel} · {v.sku}
                        </span>
                      </span>
                      <span className="tabular-nums text-ink-faint">{pesos(v.catalogPrice)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <div>
          <p className="mb-2 inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">
            <FolderTree size={13} /> Browse categories
          </p>
          {categories.length === 0 ? (
            <p className="text-xs text-ink-faint">No categories available.</p>
          ) : (
            <ul className="space-y-0.5">
              {categories.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/seller/offers/new?category=${c.id}`}
                    className={`flex items-center justify-between rounded-sm px-2 py-1.5 text-sm hover:bg-surface-sunken ${
                      c.id === categoryId ? "bg-surface-sunken font-medium text-ink" : "text-ink-soft"
                    }`}
                  >
                    <span className="truncate">
                      {c.parentName && <span className="text-ink-faint">{c.parentName} / </span>}
                      {c.name}
                    </span>
                    <span className="ml-2 shrink-0 text-xs text-ink-faint">{c.productCount}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
