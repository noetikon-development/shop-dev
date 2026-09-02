import Link from "next/link";
import { Logo } from "@/components/logo";
import { ProductArt } from "@/lib/product-art";
import { getSiteSettings } from "@/lib/site-settings";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const { tagline } = await getSiteSettings();
  return (
    <div className="lg:grid lg:min-h-screen lg:grid-cols-2">
      <div className="flex flex-col px-6 py-10 sm:px-12 lg:min-h-screen">
        <Logo className="h-12 shrink-0" />
        {/* Mobile: the form sits just below the logo (a natural, short page —
            no forced full height, so no dead space and it stays clear of the
            on-screen keyboard). Desktop: centre it in the tall column beside
            the art. */}
        <div className="flex flex-1 flex-col justify-start pt-12 lg:justify-center lg:pt-10">
          <div className="mx-auto w-full max-w-sm">{children}</div>
        </div>
        <p className="shrink-0 pt-14 text-center text-meta text-ink-faint lg:pt-10">
          <Link href="/" className="hover:text-ink">
            ← Back to store
          </Link>
        </p>
      </div>
      <div className="relative hidden bg-surface-sunken lg:block">
        <div className="grid h-full grid-cols-2 grid-rows-3">
          {(
            [
              "sofa",
              "lighting",
              "apparel-top",
              "tableware",
              "bag",
              "rug",
            ] as const
          ).map((k, i) => (
            <div key={k} className="border border-line/60">
              <ProductArt kind={k} seed={`auth-${k}-${i}`} />
            </div>
          ))}
        </div>
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-paper to-transparent p-12">
          <p className="font-display text-title leading-tight text-ink">{tagline}</p>
        </div>
      </div>
    </div>
  );
}
