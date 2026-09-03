import Link from "next/link";
import { ProductArt, type ArtKind } from "@/lib/product-art";

type Feature = {
  eyebrow: string;
  title: string;
  copy: string;
  href: string;
  cta: string;
  art: ArtKind;
  seed: string;
  bg: string;
};

/**
 * Built-in feature band — the structural fallback rendered by `page.tsx` only
 * when NO homepage ContentBlocks are published. Copy is evergreen and links
 * point at categories, not specific products; the real editorial cards live in
 * the CMS `feature_grid` block. Safety net, not a content source.
 */
const FEATURES: Feature[] = [
  {
    eyebrow: "Living",
    title: "Sofas and seating built to be lived on",
    copy: "Covers that unzip and machine-wash, frames made to last.",
    href: "/c/living",
    cta: "Shop living",
    art: "sofa",
    seed: "band-sofa",
    bg: "#e7ece6",
  },
  {
    eyebrow: "Wardrobe, edited",
    title: "The pieces you actually reach for",
    copy: "A tight rotation of shirts, knitwear and hard-wearing shoes.",
    href: "/c/wardrobe",
    cta: "Shop the wardrobe",
    art: "outerwear",
    seed: "band-knit",
    bg: "#efe6e2",
  },
];

export function FeatureBand() {
  return (
    <section className="container-page grid gap-4 md:grid-cols-2">
      {FEATURES.map((f) => (
        <Link
          key={f.seed}
          href={f.href}
          className="group grid overflow-hidden rounded-lg border border-line sm:grid-cols-[1.1fr_1fr]"
        >
          <div className="flex flex-col justify-center gap-3 p-6 sm:p-8">
            <p className="eyebrow">{f.eyebrow}</p>
            <h3 className="text-subtitle sm:text-title">{f.title}</h3>
            <p className="text-body text-ink-soft">{f.copy}</p>
            <span className="link-underline mt-1 w-fit text-meta font-medium">{f.cta} →</span>
          </div>
          <div className="min-h-44" style={{ background: f.bg }}>
            <ProductArt kind={f.art} seed={f.seed} className="transition-transform duration-500 group-hover:scale-105" />
          </div>
        </Link>
      ))}
    </section>
  );
}
