"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ResolvedNav } from "@/lib/types";

export function MegaMenu({ nav }: { nav: ResolvedNav }) {
  const [open, setOpen] = useState<string | null>(null);

  return (
    <nav
      className="hidden items-center gap-0.5 xl:flex"
      onMouseLeave={() => setOpen(null)}
    >
      {nav.items.map((item) =>
        item.children.length === 0 ? (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "px-2.5 py-2 text-[13px] font-medium transition-colors",
              item.isSale
                ? "text-sale hover:text-sale/80"
                : "text-ink-soft hover:text-ink",
            )}
          >
            {item.label}
          </Link>
        ) : (
          <div key={item.href} className="static">
            <button
              type="button"
              onMouseEnter={() => setOpen(item.href)}
              onFocus={() => setOpen(item.href)}
              onClick={() => setOpen(open === item.href ? null : item.href)}
              className={cn(
                "inline-flex items-center gap-1 px-2.5 py-2 text-[13px] font-medium transition-colors",
                open === item.href ? "text-ink" : "text-ink-soft hover:text-ink",
              )}
              aria-expanded={open === item.href}
            >
              {item.label}
              <ChevronDown
                size={14}
                className={cn("transition-transform", open === item.href && "rotate-180")}
              />
            </button>

            {open === item.href && (
              <div className="absolute inset-x-0 top-full z-50 border-t border-line bg-paper shadow-card">
                <div className="container-page grid grid-cols-[1fr_1.4fr] gap-10 py-8">
                  <div>
                    <p className="eyebrow mb-3">{item.label}</p>
                    {item.description && (
                      <p className="max-w-xs text-sm text-ink-soft">{item.description}</p>
                    )}
                    <Link
                      href={item.href}
                      className="link-underline mt-4 inline-block text-sm font-medium"
                    >
                      Shop all {item.label.toLowerCase()} →
                    </Link>
                    <div
                      className="mt-6 aspect-[16/7] w-full rounded-md"
                      style={{ background: item.heroColor ?? "var(--color-surface-sunken)" }}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-2.5 self-start">
                    {item.children.map((child) => (
                      <Link
                        key={child.href}
                        href={child.href}
                        className="flex items-baseline justify-between rounded-sm py-1.5 text-sm text-ink-soft transition-colors hover:text-ink"
                      >
                        <span>{child.label}</span>
                        {child.productCount != null && (
                          <span className="text-xs text-ink-faint">{child.productCount}</span>
                        )}
                      </Link>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        ),
      )}
    </nav>
  );
}
