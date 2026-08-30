"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * Storefront error boundary (Step 19). Shown if a shop page throws while
 * rendering. Customer-friendly copy only — no stack traces, no internal detail.
 */
export default function ShopError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surfaced in server logs / monitoring; never shown to the customer.
    console.error(error);
  }, [error]);

  return (
    <div className="container-page flex flex-col items-center justify-center py-24 text-center">
      <p className="eyebrow">Something went wrong</p>
      <h1 className="mt-3 text-3xl sm:text-4xl">This page didn&apos;t load</h1>
      <p className="mt-3 max-w-md text-ink-soft">
        Sorry — a problem on our side stopped this page from loading. Please try again, or head back
        to the homepage.
      </p>
      <div className="mt-7 flex flex-wrap justify-center gap-3">
        <button onClick={reset} className="btn btn-primary">
          Try again
        </button>
        <Link href="/" className="btn btn-outline">
          Back to home
        </Link>
      </div>
    </div>
  );
}
