"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { buildQuery } from "@/lib/listing-params";
import { formatPrice, cn } from "@/lib/utils";

type ColorFacet = { name: string; hex: string | null; count: number };

export function FilterControls({
  colorFacets,
  priceBounds,
  onNavigate,
}: {
  colorFacets: ColorFacet[];
  priceBounds: { min: number; max: number };
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, startTransition] = useTransition();

  const apply = useCallback(
    (patch: Record<string, string | number | null | undefined>) => {
      const qs = buildQuery(new URLSearchParams(sp.toString()), patch);
      startTransition(() => {
        router.push(`${pathname}${qs}`, { scroll: false });
        onNavigate?.();
      });
    },
    [router, pathname, sp, onNavigate],
  );

  const selectedColors = useMemo(
    () => (sp.get("color") ? sp.get("color")!.split(",").filter(Boolean) : []),
    [sp],
  );

  const toggleColor = (name: string) => {
    const next = selectedColors.includes(name)
      ? selectedColors.filter((c) => c !== name)
      : [...selectedColors, name];
    apply({ color: next.join(",") || null });
  };

  // The colour facet is unbounded (a category can carry dozens of distinct
  // colour names; /c/all currently ~58). Show a capped set by default and let
  // the shopper expand to the full list — every colour stays reachable, and a
  // colour that is already selected is never hidden behind the cap.
  const COLOUR_CAP = 12;
  const [showAllColours, setShowAllColours] = useState(false);
  const visibleColours = useMemo(() => {
    if (showAllColours || colorFacets.length <= COLOUR_CAP) return colorFacets;
    const head = colorFacets.slice(0, COLOUR_CAP);
    const spilledSelected = colorFacets
      .slice(COLOUR_CAP)
      .filter((c) => selectedColors.includes(c.name));
    return [...head, ...spilledSelected];
  }, [showAllColours, colorFacets, selectedColors]);

  const minFloor = Math.floor(priceBounds.min / 100);
  const maxCeil = Math.ceil(priceBounds.max / 100);
  const [minVal, setMinVal] = useState(sp.get("min") ?? "");
  const [maxVal, setMaxVal] = useState(sp.get("max") ?? "");

  return (
    <div className={cn("space-y-7", pending && "opacity-60")}>
      <FilterGroup title="Price">
        <div className="flex items-center gap-2">
          <label className="flex-1">
            <span className="sr-only">Minimum price</span>
            <input
              inputMode="numeric"
              value={minVal}
              onChange={(e) => setMinVal(e.target.value.replace(/[^0-9]/g, ""))}
              onBlur={() => apply({ min: minVal || null })}
              onKeyDown={(e) => e.key === "Enter" && apply({ min: minVal || null })}
              placeholder={String(minFloor)}
              className="field !py-2 text-sm"
            />
          </label>
          <span className="text-ink-faint">–</span>
          <label className="flex-1">
            <span className="sr-only">Maximum price</span>
            <input
              inputMode="numeric"
              value={maxVal}
              onChange={(e) => setMaxVal(e.target.value.replace(/[^0-9]/g, ""))}
              onBlur={() => apply({ max: maxVal || null })}
              onKeyDown={(e) => e.key === "Enter" && apply({ max: maxVal || null })}
              placeholder={String(maxCeil)}
              className="field !py-2 text-sm"
            />
          </label>
        </div>
        <p className="mt-2 text-xs text-ink-faint">
          Range in this view: {formatPrice(priceBounds.min)} – {formatPrice(priceBounds.max)}
        </p>
      </FilterGroup>

      {colorFacets.length > 0 && (
        <FilterGroup title="Colour">
          <div
            className={cn(
              "flex flex-wrap gap-2",
              showAllColours && colorFacets.length > COLOUR_CAP && "max-h-64 overflow-y-auto pr-1",
            )}
          >
            {visibleColours.map((c) => {
              const active = selectedColors.includes(c.name);
              return (
                <button
                  key={c.name}
                  onClick={() => toggleColor(c.name)}
                  aria-pressed={active}
                  className={cn(
                    "inline-flex items-center gap-2 rounded-full border py-1.5 pl-1.5 pr-3 text-xs transition-colors",
                    active
                      ? "border-ink bg-ink text-paper"
                      : "border-line-strong text-ink-soft hover:border-ink",
                  )}
                >
                  <span
                    className="h-4 w-4 rounded-full border border-black/10"
                    style={{ backgroundColor: c.hex ?? "#ccc" }}
                  />
                  {c.name}
                </button>
              );
            })}
          </div>
          {colorFacets.length > COLOUR_CAP && (
            <button
              onClick={() => setShowAllColours((v) => !v)}
              aria-expanded={showAllColours}
              className="mt-2.5 text-xs font-medium text-ink-soft underline underline-offset-2 hover:text-ink"
            >
              {showAllColours ? "Show fewer colours" : `Show all ${colorFacets.length} colours`}
            </button>
          )}
        </FilterGroup>
      )}

      <FilterGroup title="Rating">
        <div className="space-y-1.5">
          {[4, 4.5].map((r) => (
            <label key={r} className="flex cursor-pointer items-center gap-2.5 text-sm">
              <input
                type="radio"
                name="rating"
                checked={sp.get("rating") === String(r)}
                onChange={() => apply({ rating: r })}
                className="accent-ink"
              />
              {r.toFixed(1)} &amp; up
            </label>
          ))}
          {sp.get("rating") && (
            <button
              onClick={() => apply({ rating: null })}
              className="text-xs text-ink-faint underline underline-offset-2"
            >
              Clear rating
            </button>
          )}
        </div>
      </FilterGroup>

      <FilterGroup title="Availability">
        <div className="space-y-2">
          <Toggle
            label="On sale"
            checked={sp.get("sale") === "1"}
            onChange={(v) => apply({ sale: v ? 1 : null })}
          />
          <Toggle
            label="In stock only"
            checked={sp.get("stock") === "1"}
            onChange={(v) => apply({ stock: v ? 1 : null })}
          />
          <Toggle
            label="Free shipping"
            checked={sp.get("ship") === "1"}
            onChange={(v) => apply({ ship: v ? 1 : null })}
          />
        </div>
      </FilterGroup>

      {pending && (
        <p className="flex items-center gap-2 text-xs text-ink-faint">
          <Loader2 size={13} className="animate-spin" /> Updating…
        </p>
      )}
    </div>
  );
}

function FilterGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-faint">{title}</p>
      {children}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-ink" />
      {label}
    </label>
  );
}
