import Link from "next/link";
import { Logo } from "@/components/logo";
import { ProductArt } from "@/lib/product-art";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="flex flex-col px-6 py-8 sm:px-12">
        <Logo className="h-12" />
        <div className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-sm">{children}</div>
        </div>
        <p className="text-center text-xs text-ink-faint">
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
          <p className="font-display text-2xl leading-tight text-ink">
            Considered things for everyday living.
          </p>
        </div>
      </div>
    </div>
  );
}
