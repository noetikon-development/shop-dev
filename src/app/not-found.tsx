import Link from "next/link";
import { Logo } from "@/components/logo";
import { buttonClasses } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <Logo className="h-12" />
      <p className="eyebrow mt-10">Error 404</p>
      <h1 className="mt-3 text-4xl">This page has moved on</h1>
      <p className="mt-3 max-w-md text-ink-soft">
        The link may be old or the product may no longer be available. Let&apos;s get you back on
        track.
      </p>
      <div className="mt-7 flex gap-3">
        <Link href="/" className={buttonClasses()}>
          Back to home
        </Link>
        <Link href="/c/all" className={buttonClasses({ variant: "outline" })}>
          Browse products
        </Link>
      </div>
    </div>
  );
}
