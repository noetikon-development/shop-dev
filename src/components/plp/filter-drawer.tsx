"use client";

import { useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { SlideOver } from "@/components/ui/slide-over";
import { FilterControls } from "@/components/plp/filter-controls";

type ColorFacet = { name: string; hex: string | null; count: number };

export function FilterDrawer({
  colorFacets,
  priceBounds,
  activeCount,
}: {
  colorFacets: ColorFacet[];
  priceBounds: { min: number; max: number };
  activeCount: number;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-sm border border-line-strong bg-surface px-3.5 py-2 text-sm font-medium lg:hidden"
      >
        <SlidersHorizontal size={15} />
        Filters
        {activeCount > 0 && (
          <span className="grid h-5 min-w-5 place-items-center rounded-full bg-ink px-1 text-[11px] text-paper">
            {activeCount}
          </span>
        )}
      </button>

      <SlideOver open={open} onClose={() => setOpen(false)} title="Filters" side="left">
        <div className="px-5 py-5">
          <FilterControls
            colorFacets={colorFacets}
            priceBounds={priceBounds}
          />
        </div>
      </SlideOver>
    </>
  );
}
