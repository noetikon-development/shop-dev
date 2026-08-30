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
    <div className="space-y-16 pb-8 sm:space-y-20">
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
      <ProductRail
        eyebrow="Most loved"
        title="Bestsellers"
        action={{ label: "Shop bestsellers", href: "/c/all?sort=bestselling" }}
        products={bestSellers}
        showCategory
      />
      <ValueProps />
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
