"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useDisclosure } from "@/lib/use-disclosure";
import type { ResolvedNav } from "@/lib/types";

/** Exact-path match — a restrained "you are here" cue, never a fuzzy prefix. */
function isCurrent(pathname: string, href: string): boolean {
  return href.startsWith("/") && pathname === href;
}

const panelId = (href: string) => `megamenu-${href.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}`;

export function MegaMenu({ nav }: { nav: ResolvedNav }) {
  const pathname = usePathname();
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const { open, setOpen, triggerRef, contentRef } = useDisclosure<
    HTMLButtonElement,
    HTMLElement
  >({ onClose: () => setActiveKey(null) });

  const openPanel = (key: string, trigger: HTMLButtonElement) => {
    triggerRef.current = trigger;
    setActiveKey(key);
    setOpen(true);
  };
  const closePanel = () => {
    setOpen(false);
    setActiveKey(null);
  };
  const shownKey = open ? activeKey : null;

  return (
    <nav
      ref={contentRef}
      aria-label="Primary"
      className="-ml-2 hidden min-w-0 items-center xl:flex"
      onMouseLeave={closePanel}
    >
      {nav.items.map((item) => {
        const current = isCurrent(pathname, item.href);

        if (item.children.length === 0) {
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={closePanel}
              aria-current={current ? "page" : undefined}
              className={cn(
                "whitespace-nowrap border-b-2 border-transparent px-2 py-2 text-meta font-medium transition-colors",
                item.isSale
                  ? "text-sale hover:text-sale/80"
                  : current
                    ? "border-ink text-ink"
                    : "text-ink-soft hover:text-ink",
              )}
            >
              {item.label}
            </Link>
          );
        }

        const expanded = shownKey === item.href;
        return (
          <div key={item.href} className="static">
            <button
              type="button"
              onMouseEnter={(e) => openPanel(item.href, e.currentTarget)}
              onFocus={(e) => openPanel(item.href, e.currentTarget)}
              onClick={(e) =>
                expanded ? closePanel() : openPanel(item.href, e.currentTarget)
              }
              aria-haspopup="true"
              aria-expanded={expanded}
              aria-controls={panelId(item.href)}
              className={cn(
                "whitespace-nowrap border-b-2 border-transparent px-2 py-2 text-meta font-medium transition-colors",
                current && "border-ink",
                expanded || current ? "text-ink" : "text-ink-soft hover:text-ink",
              )}
            >
              {item.label}
            </button>

            {expanded && (
              <div
                id={panelId(item.href)}
                className="absolute inset-x-0 top-full z-50 border-t border-line bg-paper shadow-card"
              >
                <div className="container-page flex gap-14 py-9">
                  <div className="w-64 shrink-0">
                    <p className="eyebrow mb-3">{item.label}</p>
                    {item.description && (
                      <p className="text-body text-ink-soft">{item.description}</p>
                    )}
                    <Link
                      href={item.href}
                      onClick={closePanel}
                      className="link-underline mt-4 inline-flex w-fit items-center gap-1 text-meta font-medium"
                    >
                      Shop all {item.label.toLowerCase()} <span aria-hidden="true">→</span>
                    </Link>
                    {item.imageUrl && (
                      <div
                        className="relative mt-6 aspect-[16/9] w-full overflow-hidden rounded-md"
                        style={{ background: item.heroColor ?? "var(--color-surface-sunken)" }}
                      >
                        <Image
                          src={item.imageUrl}
                          alt=""
                          fill
                          sizes="256px"
                          className="object-cover"
                        />
                      </div>
                    )}
                  </div>

                  <ul
                    className={cn(
                      "grid content-start gap-x-10 gap-y-0.5",
                      item.children.length > 5 ? "grid-cols-2" : "grid-cols-1",
                    )}
                  >
                    {item.children.map((child) => {
                      const childCurrent = isCurrent(pathname, child.href);
                      return (
                        <li key={child.href}>
                          <Link
                            href={child.href}
                            onClick={closePanel}
                            aria-current={childCurrent ? "page" : undefined}
                            className={cn(
                              "inline-flex items-baseline gap-2 rounded-sm py-1.5 text-body transition-colors",
                              childCurrent
                                ? "font-medium text-ink"
                                : "text-ink-soft hover:text-ink",
                            )}
                          >
                            {child.label}
                            {child.productCount != null && (
                              <span className="text-meta text-ink-faint">{child.productCount}</span>
                            )}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
