import { Hero } from "@/components/home/hero";
import { CategoryTiles } from "@/components/home/category-tiles";
import { FeatureBand } from "@/components/home/feature-band";
import { ValueProps } from "@/components/home/value-props";
import { ProductRail } from "@/components/product-rail";
import {
  getBestSellers,
  getCategoryTree,
  getNewArrivals,
  getOnSale,
} from "@/lib/data";

export default async function HomePage() {
  const [tree, newArrivals, bestSellers, onSale] = await Promise.all([
    getCategoryTree(),
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
