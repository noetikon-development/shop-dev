"use client";

import { useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { ProductCard } from "@/components/product-card";
import { SectionHeading } from "@/components/ui/primitives";
import type { ProductCardView } from "@/lib/types";

export function ProductRail({
  eyebrow,
  title,
  action,
  products,
  showCategory,
}: {
  eyebrow?: string;
  title: string;
  action?: { label: string; href: string };
  products: ProductCardView[];
  showCategory?: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);

  const scroll = (dir: 1 | -1) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollBy({ left: dir * (el.clientWidth * 0.8), behavior: "smooth" });
  };

  if (!products.length) return null;

  return (
    <section className="container-page">
      <div className="flex items-end justify-between gap-4">
        <SectionHeading eyebrow={eyebrow} title={title} action={action} className="flex-1" />
        <div className="hidden gap-2 sm:flex">
          <button
            onClick={() => scroll(-1)}
            className="grid h-9 w-9 place-items-center rounded-full border border-line-strong text-ink-soft transition-colors hover:border-ink hover:text-ink"
            aria-label="Scroll left"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            onClick={() => scroll(1)}
            className="grid h-9 w-9 place-items-center rounded-full border border-line-strong text-ink-soft transition-colors hover:border-ink hover:text-ink"
            aria-label="Scroll right"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      <div
        ref={scroller}
        className="no-scrollbar -mx-4 mt-6 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0"
      >
        {products.map((p, i) => (
          <ProductCard
            key={p.id}
            product={p}
            showCategory={showCategory}
            priority={i < 4}
            className="w-[58vw] shrink-0 snap-start sm:w-[42vw] md:w-[30vw] lg:w-[calc((100%-3rem)/4)]"
          />
        ))}
      </div>
    </section>
  );
}
