"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, ChevronDown, User, Heart, Package } from "lucide-react";
import { SlideOver } from "@/components/ui/slide-over";
import { useUI } from "@/lib/ui-store";
import { cn } from "@/lib/utils";
import type { ResolvedNav } from "@/lib/types";

function isCurrent(pathname: string, href: string): boolean {
  return href.startsWith("/") && pathname === href;
}

export function MobileMenu({
  nav,
  signedIn,
}: {
  nav: ResolvedNav;
  signedIn: boolean;
}) {
  const { menuOpen, toggleMenu } = useUI();
  const pathname = usePathname();
  const [expanded, setExpanded] = useState<string | null>(null);
  const close = () => toggleMenu(false);

  return (
    <SlideOver open={menuOpen} onClose={close} title="Menu" side="left" width="max-w-sm">
      <nav aria-label="Primary" className="px-4 py-2">
        {nav.items.map((item) => {
          const current = isCurrent(pathname, item.href);

          if (item.children.length === 0) {
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={close}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "block border-b border-line py-3.5 text-body font-medium",
                  item.isSale && "text-sale",
                  current && "underline decoration-1 underline-offset-4",
                )}
              >
                {item.label}
              </Link>
            );
          }

          const isOpen = expanded === item.href;
          return (
            <div key={item.href} className="border-b border-line">
              <div className="flex items-center">
                <Link
                  href={item.href}
                  onClick={close}
                  aria-current={current ? "page" : undefined}
                  className={cn(
                    "flex-1 py-3.5 text-body font-medium",
                    current && "underline decoration-1 underline-offset-4",
                  )}
                >
                  {item.label}
                </Link>
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : item.href)}
                  aria-label={`${isOpen ? "Collapse" : "Expand"} ${item.label}`}
                  aria-expanded={isOpen}
                  className="tap grid h-11 w-11 place-items-center text-ink-soft"
                >
                  <ChevronDown
                    size={17}
                    aria-hidden="true"
                    className={cn("transition-transform", isOpen && "rotate-180")}
                  />
                </button>
              </div>
              {isOpen && (
                <ul className="pb-2">
                  {item.children.map((child) => {
                    const childCurrent = isCurrent(pathname, child.href);
                    return (
                      <li key={child.href}>
                        <Link
                          href={child.href}
                          onClick={close}
                          aria-current={childCurrent ? "page" : undefined}
                          className={cn(
                            "flex items-center justify-between py-2.5 pl-3 pr-2 text-body text-ink-soft",
                            childCurrent && "font-medium text-ink underline decoration-1 underline-offset-4",
                          )}
                        >
                          {child.label}
                          <ChevronRight size={14} aria-hidden="true" className="text-ink-faint" />
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </nav>

      <div className="mt-3 space-y-1 border-t border-line px-4 pt-4">
        <Link
          href={signedIn ? "/account" : "/login"}
          onClick={close}
          className="tap flex items-center gap-3 rounded-sm px-2 py-2.5 text-body hover:bg-surface"
        >
          <User size={17} aria-hidden="true" className="text-ink-soft" />
          {signedIn ? "My account" : "Sign in / Register"}
        </Link>
        <Link
          href="/account/wishlist"
          onClick={close}
          className="tap flex items-center gap-3 rounded-sm px-2 py-2.5 text-body hover:bg-surface"
        >
          <Heart size={17} aria-hidden="true" className="text-ink-soft" />
          Wishlist
        </Link>
        <Link
          href="/track"
          onClick={close}
          className="tap flex items-center gap-3 rounded-sm px-2 py-2.5 text-body hover:bg-surface"
        >
          <Package size={17} aria-hidden="true" className="text-ink-soft" />
          Track an order
        </Link>
      </div>
    </SlideOver>
  );
}
