"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search as SearchIcon, X, ArrowRight } from "lucide-react";
import { ProductArt, type ArtKind } from "@/lib/product-art";
import { formatPrice, cn } from "@/lib/utils";

type Suggestion = {
  slug: string;
  name: string;
  price: number;
  category: string;
  art: ArtKind;
};

const POPULAR = ["Sofa", "Oak table", "Linen", "Sneakers", "Floor lamp", "Wool rug"];

export function HeaderSearch({ variant = "bar" }: { variant?: "bar" | "panel" }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Suggestion[]>([]);
  const [focused, setFocused] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/search/suggest?q=${encodeURIComponent(q)}`, { signal: ctrl.signal })
        .then((r) => r.json())
        .then((d) => setResults(d.results ?? []))
        .catch(() => {});
    }, 180);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setFocused(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  function submit(term: string) {
    const value = term.trim();
    if (!value) return;
    setFocused(false);
    router.push(`/search?q=${encodeURIComponent(value)}`);
  }

  const showDropdown = focused && (variant === "panel" || q.length > 0);

  return (
    <div ref={boxRef} className={cn("relative w-full", variant === "bar" && "max-w-xl")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(q);
        }}
        className="relative"
      >
        <SearchIcon
          size={17}
          className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-faint"
        />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => setFocused(true)}
          placeholder="Search furniture, lighting, wardrobe…"
          className="h-11 w-full rounded-sm border border-line-strong bg-surface pl-10 pr-10 text-sm outline-none transition-colors focus:border-ink"
          aria-label="Search products"
        />
        {q && (
          <button
            type="button"
            onClick={() => setQ("")}
            aria-label="Clear search"
            className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink"
          >
            <X size={16} />
          </button>
        )}
      </form>

      {showDropdown && (
        <div className="absolute inset-x-0 top-full z-50 mt-2 overflow-hidden rounded-md border border-line bg-paper shadow-pop">
          {results.length > 0 ? (
            <ul className="py-1.5">
              {results.map((r) => (
                <li key={r.slug}>
                  <button
                    onClick={() => {
                      setFocused(false);
                      router.push(`/p/${r.slug}`);
                    }}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-surface"
                  >
                    <span className="h-10 w-10 shrink-0 overflow-hidden rounded-sm bg-surface-sunken">
                      <ProductArt kind={r.art} seed={r.slug} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{r.name}</span>
                      <span className="block text-xs text-ink-faint">{r.category}</span>
                    </span>
                    <span className="text-sm tabular-nums text-ink-soft">
                      {formatPrice(r.price)}
                    </span>
                  </button>
                </li>
              ))}
              <li className="border-t border-line">
                <button
                  onClick={() => submit(q)}
                  className="flex w-full items-center justify-between px-3 py-2.5 text-sm font-medium hover:bg-surface"
                >
                  Search &ldquo;{q}&rdquo;
                  <ArrowRight size={15} />
                </button>
              </li>
            </ul>
          ) : q.length > 1 ? (
            <p className="px-4 py-6 text-center text-sm text-ink-faint">
              No matches yet — press enter to search everything.
            </p>
          ) : (
            <div className="p-4">
              <p className="eyebrow mb-3">Popular searches</p>
              <div className="flex flex-wrap gap-2">
                {POPULAR.map((term) => (
                  <button
                    key={term}
                    onClick={() => submit(term)}
                    className="rounded-full border border-line-strong px-3 py-1.5 text-sm text-ink-soft hover:border-ink hover:text-ink"
                  >
                    {term}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
