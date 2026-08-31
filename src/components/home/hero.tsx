import Link from "next/link";
import { ProductArt } from "@/lib/product-art";

export function Hero() {
  return (
    <section className="container-page pt-6 sm:pt-10">
      <div className="grid overflow-hidden rounded-lg border border-line bg-surface lg:grid-cols-2">
        <div className="flex flex-col justify-center gap-6 p-8 sm:p-12 lg:p-16">
          <p className="eyebrow">Autumn / Winter — new in</p>
          <h1 className="text-balance text-4xl leading-[1.05] sm:text-5xl lg:text-[3.4rem]">
            Considered things for everyday living
          </h1>
          <p className="max-w-md text-pretty text-ink-soft">
            Furniture, lighting, textiles and a small wardrobe — designed in-house, made to last,
            and priced without the markup. Free shipping over ₱2,500.
          </p>
          <div className="flex flex-wrap gap-3 pt-1">
            <Link href="/c/all" className="btn btn-primary">
              Shop everything
            </Link>
            <Link href="/c/new" className="btn btn-outline">
              See what&apos;s new
            </Link>
          </div>
          <div className="flex flex-wrap gap-x-8 gap-y-2 pt-4 text-xs text-ink-faint">
            <span>Designed in-house</span>
            <span>30-day returns</span>
            <span>Assembly help included</span>
          </div>
        </div>

        <div className="relative grid grid-cols-2 grid-rows-2 gap-px bg-line">
          {(
            [
              { kind: "sofa", seed: "hero-sofa" },
              { kind: "lighting", seed: "hero-lamp" },
              { kind: "tableware", seed: "hero-plate" },
              { kind: "apparel-top", seed: "hero-shirt" },
            ] as const
          ).map((a) => (
            <div key={a.seed} className="aspect-square">
              <ProductArt kind={a.kind} seed={a.seed} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
