import type { Metadata } from "next";
import { Hero } from "@/components/home/hero";
import { CategoryTiles } from "@/components/home/category-tiles";
import { FeatureBand } from "@/components/home/feature-band";
import { ValueProps } from "@/components/home/value-props";
import { ProductRail } from "@/components/product-rail";
import { HomepageBlocks } from "@/components/home/homepage-blocks";

export const metadata: Metadata = { alternates: { canonical: "/" } };
import {
  getBestSellers,
  getCategoryTree,
  getNewArrivals,
  getOnSale,
} from "@/lib/data";
import { getHomepageBlocks } from "@/lib/content";

export default async function HomePage() {
  const [tree, blocks] = await Promise.all([getCategoryTree(), getHomepageBlocks()]);

  // CMS-driven homepage when an admin has published blocks; otherwise the
  // original built-in layout (so the storefront always renders).
  if (blocks.length > 0) {
    return <HomepageBlocks blocks={blocks} tree={tree} />;
  }

  const [newArrivals, bestSellers, onSale] = await Promise.all([
    getNewArrivals(10),
    getBestSellers(10),
    getOnSale(10),
  ]);

  return (
    <div className="space-y-section pb-8 sm:space-y-section-lg">
      <Hero />
      <CategoryTiles categories={tree} />
      <ProductRail
        eyebrow="Just landed"
        title="New this season"
        action={{ label: "View all new", href: "/c/new" }}
        products={newArrivals}
        showCategory
      />
      <FeatureBand />
      {/* Bestsellers → value-props → sale: the value-props strip sits tighter to
          its neighbours than a full section (matches the CMS renderer). */}
      <div className="mb-6 sm:mb-10">
        <ProductRail
          eyebrow="Most loved"
          title="Bestsellers"
          action={{ label: "Shop bestsellers", href: "/c/all?sort=bestselling" }}
          products={bestSellers}
          showCategory
        />
      </div>
      <div className="mb-6 sm:mb-10">
        <ValueProps />
      </div>
      <ProductRail
        eyebrow="Reduced"
        title="On sale now"
        action={{ label: "All sale items", href: "/c/sale" }}
        products={onSale}
        showCategory
      />
    </div>
  );
}
