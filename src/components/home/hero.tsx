import Link from "next/link";
import { ProductArt } from "@/lib/product-art";

/**
 * Built-in homepage hero — the structural fallback rendered by `page.tsx` only
 * when NO homepage ContentBlocks are published. Kept deliberately free of
 * business facts (prices, thresholds, return windows, seasons): those live in
 * Store Settings / the CMS hero block, which is what the storefront normally
 * shows. This is a safety net, not a content source.
 */
export function Hero() {
  return (
    <section className="container-page pt-6 sm:pt-10">
      <div className="grid overflow-hidden rounded-lg border border-line bg-surface lg:grid-cols-2">
        <div className="flex flex-col justify-center gap-5 p-8 sm:p-10 lg:px-14 lg:py-12">
          <p className="eyebrow">New in</p>
          <h1 className="text-balance text-4xl sm:text-5xl lg:text-hero">
            Considered things for everyday living
          </h1>
          <p className="max-w-md text-pretty text-ink-soft">
            Everything for everyday living.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link href="/c/all" className="btn btn-primary">
              Shop everything
            </Link>
            <Link href="/c/new" className="btn btn-outline">
              See what&apos;s new
            </Link>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-8 gap-y-2 text-meta text-ink-faint">
            <span>Free standard shipping</span>
            <span>Easy returns</span>
            <span>Helpful support</span>
          </div>
        </div>

        <div className="relative grid h-[300px] grid-cols-2 grid-rows-2 gap-px bg-line max-lg:border-t max-lg:border-line lg:h-full">
          {(
            [
              { kind: "sofa", seed: "hero-sofa" },
              { kind: "lighting", seed: "hero-lamp" },
              { kind: "tableware", seed: "hero-plate" },
              { kind: "apparel-top", seed: "hero-shirt" },
            ] as const
          ).map((a) => (
            <div key={a.seed} className="relative overflow-hidden">
              <ProductArt kind={a.kind} seed={a.seed} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
