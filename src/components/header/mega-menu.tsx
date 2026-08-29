"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CategoryNode } from "@/lib/types";

export function MegaMenu({ tree }: { tree: CategoryNode[] }) {
  const [open, setOpen] = useState<string | null>(null);

  return (
    <nav
      className="hidden items-center gap-0.5 xl:flex"
      onMouseLeave={() => setOpen(null)}
    >
      <Link
        href="/c/new"
        className="px-2.5 py-2 text-[13px] font-medium text-ink-soft transition-colors hover:text-ink"
      >
        New In
      </Link>

      {tree.map((cat) => (
        <div key={cat.id} className="static">
          <button
            type="button"
            onMouseEnter={() => setOpen(cat.id)}
            onFocus={() => setOpen(cat.id)}
            onClick={() => setOpen(open === cat.id ? null : cat.id)}
            className={cn(
              "inline-flex items-center gap-1 px-2.5 py-2 text-[13px] font-medium transition-colors",
              open === cat.id ? "text-ink" : "text-ink-soft hover:text-ink",
            )}
            aria-expanded={open === cat.id}
          >
            {cat.name}
            <ChevronDown
              size={14}
              className={cn("transition-transform", open === cat.id && "rotate-180")}
            />
          </button>

          {open === cat.id && (
            <div className="absolute inset-x-0 top-full z-50 border-t border-line bg-paper shadow-card">
              <div className="container-page grid grid-cols-[1fr_1.4fr] gap-10 py-8">
                <div>
                  <p className="eyebrow mb-3">{cat.name}</p>
                  <p className="max-w-xs text-sm text-ink-soft">{cat.description}</p>
                  <Link
                    href={`/c/${cat.slug}`}
                    className="link-underline mt-4 inline-block text-sm font-medium"
                  >
                    Shop all {cat.name.toLowerCase()} →
                  </Link>
                  <div
                    className="mt-6 aspect-[16/7] w-full rounded-md"
                    style={{ background: cat.heroColor ?? "var(--color-surface-sunken)" }}
                  />
                </div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-2.5 self-start">
                  {cat.children.map((child) => (
                    <Link
                      key={child.id}
                      href={`/c/${child.slug}`}
                      className="flex items-baseline justify-between rounded-sm py-1.5 text-sm text-ink-soft transition-colors hover:text-ink"
                    >
                      <span>{child.name}</span>
                      <span className="text-xs text-ink-faint">{child.productCount}</span>
                    </Link>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      ))}

      <Link
        href="/c/sale"
        className="px-2.5 py-2 text-[13px] font-medium text-sale transition-colors hover:text-sale/80"
      >
        Sale
      </Link>
    </nav>
  );
}
