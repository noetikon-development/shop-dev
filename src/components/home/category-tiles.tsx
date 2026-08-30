import Link from "next/link";
import Image from "next/image";
import { ProductArt, type ArtKind } from "@/lib/product-art";
import { SectionHeading } from "@/components/ui/primitives";
import type { CategoryNode } from "@/lib/types";

// Illustration fallback ONLY — used when a category has no CMS image. Unknown
// slugs fall through to a generic mark, so a rebrand with different slugs still
// renders cleanly.
const ART_BY_SLUG: Record<string, ArtKind> = {
  living: "sofa",
  bedroom: "bed",
  "kitchen-dining": "kitchen",
  textiles: "textile",
  lighting: "lighting",
  decor: "decor",
  wardrobe: "apparel-top",
  "bags-accessories": "bag",
  footwear: "footwear",
};

export function CategoryTiles({
  categories,
  eyebrow = "Departments",
  heading = "Shop by room & category",
}: {
  categories: CategoryNode[];
  eyebrow?: string;
  heading?: string;
}) {
  return (
    <section className="container-page">
      <SectionHeading
        eyebrow={eyebrow || undefined}
        title={heading || "Shop by category"}
        action={{ label: "All categories", href: "/c/all" }}
      />
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {categories.map((c) => (
          <Link
            key={c.id}
            href={`/c/${c.slug}`}
            className="group relative flex flex-col overflow-hidden rounded-md border border-line bg-surface transition-colors hover:border-ink"
          >
            <div
              className="relative aspect-[4/3] w-full"
              style={{ background: c.heroColor ?? "var(--color-surface-sunken)" }}
            >
              {c.imageUrl ? (
                <Image
                  src={c.imageUrl}
                  alt={c.name}
                  fill
                  className="object-cover"
                  sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 20vw"
                />
              ) : (
                <ProductArt kind={ART_BY_SLUG[c.slug] ?? "accessory"} seed={c.slug} />
              )}
            </div>
            <div className="flex items-center justify-between px-3.5 py-3">
              <span className="text-sm font-medium">{c.name}</span>
              <span className="text-xs text-ink-faint">{c.productCount}</span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
