"use client";

import { useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { ProductCard } from "@/components/product-card";
import { SectionHeading } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import type { ProductCardView } from "@/lib/types";

/**
 * A homepage product section (Phase 5D Stage 5).
 *
 * The three homepage rails share this component but read differently:
 *   - `scroller` (default) — a swipeable strip; the discovery rhythm.
 *   - `grid` — a static grid on desktop (still a strip on mobile); "here's the
 *     set, laid out to browse".
 *   - `compact` gives it a smaller heading and a tighter footprint — used for
 *     the sale rail at the foot of the page.
 */
export function ProductRail({
  eyebrow,
  title,
  action,
  products,
  showCategory,
  variant = "scroller",
  compact = false,
  fluidHeight = false,
}: {
  eyebrow?: string;
  title: string;
  action?: { label: string; href: string };
  products: ProductCardView[];
  showCategory?: boolean;
  variant?: "scroller" | "grid";
  compact?: boolean;
  /**
   * Layout-only. Cards size to their own content instead of every card
   * stretching to the height of the tallest one, so a shorter card doesn't
   * carry a tall block of empty space beneath it. Paired with `railCard` on the
   * cards, which keeps their heights close together without hiding anything.
   */
  fluidHeight?: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);

  const scroll = (dir: 1 | -1) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollBy({ left: dir * (el.clientWidth * 0.8), behavior: "smooth" });
  };

  if (!products.length) return null;

  const isGrid = variant === "grid";

  const body = (
    <>
      <div className="flex items-end justify-between gap-4">
        <SectionHeading
          eyebrow={eyebrow}
          title={title}
          action={action}
          size={compact ? "sm" : "default"}
          className="flex-1"
        />
        {!isGrid && (
          <div className="hidden gap-2 sm:flex">
            <button
              type="button"
              onClick={() => scroll(-1)}
              className="tap grid h-9 w-9 place-items-center rounded-full border border-line-strong text-ink-soft transition-colors hover:border-ink hover:text-ink"
              aria-label={`Scroll ${title} left`}
            >
              <ChevronLeft size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => scroll(1)}
              className="tap grid h-9 w-9 place-items-center rounded-full border border-line-strong text-ink-soft transition-colors hover:border-ink hover:text-ink"
              aria-label={`Scroll ${title} right`}
            >
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      <div
        ref={scroller}
        className={cn(
          "no-scrollbar -mx-4 mt-6 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0",
          fluidHeight && "items-start",
          isGrid &&
            "lg:grid lg:grid-cols-5 lg:gap-x-4 lg:gap-y-9 lg:overflow-visible lg:px-0",
        )}
      >
        {products.map((p, i) => (
          <ProductCard
            key={p.id}
            product={p}
            showCategory={showCategory}
            priority={i < 4}
            railCard={fluidHeight}
            className={cn(
              "shrink-0 snap-start",
              compact
                ? "w-[52vw] sm:w-[38vw] md:w-[27vw] lg:w-[calc((100%-4.5rem)/4.5)]"
                : "w-[58vw] sm:w-[42vw] md:w-[30vw] lg:w-[calc((100%-3rem)/4)]",
              isGrid && "lg:w-auto",
            )}
          />
        ))}
      </div>
    </>
  );

  return <section className="container-page">{body}</section>;
}
