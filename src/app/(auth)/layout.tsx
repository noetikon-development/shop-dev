import Link from "next/link";
import { Logo } from "@/components/logo";
import { ProductArt } from "@/lib/product-art";
import { getSiteSettings } from "@/lib/site-settings";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const { tagline } = await getSiteSettings();
  return (
    <div className="lg:grid lg:h-screen lg:grid-cols-2 lg:overflow-hidden">
      {/* Form column. On desktop it owns the full viewport height and scrolls
          inside itself if a form is ever taller than the screen — the page
          itself never grows past one viewport. On mobile it's a natural short
          page under the logo (no forced full height, clear of the keyboard). */}
      <div className="flex flex-col px-6 py-10 sm:px-12 lg:h-screen lg:overflow-y-auto">
        <Logo className="h-12 shrink-0" />
        {/* Brand line — quiet utility type directly under the wordmark, present
            at every breakpoint. Wording is settings-driven (`store.tagline`). */}
        <p className="shrink-0 pt-3 text-meta text-ink-faint">{tagline}</p>
        <div className="flex flex-1 flex-col justify-start pt-12 lg:justify-center lg:pt-10">
          <div className="mx-auto w-full max-w-sm">{children}</div>
        </div>
        <p className="shrink-0 pt-14 text-center text-meta text-ink-faint lg:pt-10">
          <Link href="/" className="hover:text-ink">
            ← Back to store
          </Link>
        </p>
      </div>
      {/* Art column — a single large in-house illustration, editorial scale, no
          grid and no per-panel borders. Desktop only (unchanged `lg` behaviour);
          `overflow-hidden` keeps the illustration from adding page height. */}
      <div className="relative hidden overflow-hidden border-l border-line bg-surface-sunken lg:block">
        <ProductArt kind="sofa" seed="auth-sofa" className="h-full w-full" />
      </div>
    </div>
  );
}
