"use client";

import Link from "next/link";
import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { Button, buttonClasses } from "@/components/ui/button";

/**
 * Storefront error boundary (Step 19; brought onto the Phase 5B/5D system in
 * Stage 9). Shown if a shop page throws while rendering — the header and footer
 * from the layout stay in place. Customer-friendly copy only: no stack traces,
 * no internal detail, no error digest on screen.
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
      <div className="mb-5 grid h-16 w-16 place-items-center rounded-full bg-surface-sunken text-ink-faint">
        <AlertTriangle size={24} aria-hidden="true" />
      </div>
      <p className="eyebrow">Something went wrong</p>
      <h1 className="mt-3 text-title sm:text-display">This page didn&apos;t load</h1>
      <p className="mt-3 max-w-md text-pretty text-ink-soft">
        Sorry — a problem on our side stopped this page from loading. Please try again, or head back
        to the homepage.
      </p>
      <div className="mt-7 flex flex-wrap justify-center gap-3">
        <Button onClick={reset}>Try again</Button>
        <Link href="/" className={buttonClasses({ variant: "outline" })}>
          Back to home
        </Link>
      </div>
    </div>
  );
}
