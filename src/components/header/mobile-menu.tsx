"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronRight, ChevronDown, User, Heart, Package } from "lucide-react";
import { SlideOver } from "@/components/ui/slide-over";
import { useUI } from "@/lib/ui-store";
import { cn } from "@/lib/utils";
import type { ResolvedNav } from "@/lib/types";

export function MobileMenu({
  nav,
  signedIn,
}: {
  nav: ResolvedNav;
  signedIn: boolean;
}) {
  const { menuOpen, toggleMenu } = useUI();
  const [expanded, setExpanded] = useState<string | null>(null);
  const close = () => toggleMenu(false);

  return (
    <SlideOver open={menuOpen} onClose={close} title="Menu" side="left" width="max-w-sm">
      <div className="px-4 py-3">
        {nav.items.map((item) =>
          item.children.length === 0 ? (
            <Link
              key={item.href}
              href={item.href}
              onClick={close}
              className={cn(
                "block border-b border-line py-3 text-[15px] font-medium",
                item.isSale && "text-sale",
              )}
            >
              {item.label}
            </Link>
          ) : (
            <div key={item.href} className="border-b border-line">
              <div className="flex items-center">
                <Link
                  href={item.href}
                  onClick={close}
                  className="flex-1 py-3 text-[15px] font-medium"
                >
                  {item.label}
                </Link>
                <button
                  onClick={() => setExpanded(expanded === item.href ? null : item.href)}
                  aria-label={`Toggle ${item.label}`}
                  aria-expanded={expanded === item.href}
                  className="grid h-9 w-9 tap place-items-center text-ink-soft"
                >
                  <ChevronDown
                    size={17}
                    className={cn("transition-transform", expanded === item.href && "rotate-180")}
                  />
                </button>
              </div>
              {expanded === item.href && (
                <ul className="pb-2">
                  {item.children.map((child) => (
                    <li key={child.href}>
                      <Link
                        href={child.href}
                        onClick={close}
                        className="flex items-center justify-between py-2 pl-3 pr-2 text-sm text-ink-soft"
                      >
                        {child.label}
                        <ChevronRight size={14} className="text-ink-faint" />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ),
        )}

        <div className="mt-4 space-y-1">
          <Link
            href={signedIn ? "/account" : "/login"}
            onClick={close}
            className="flex items-center gap-3 rounded-sm px-2 py-2.5 text-sm hover:bg-surface"
          >
            <User size={17} className="text-ink-soft" />
            {signedIn ? "My account" : "Sign in / Register"}
          </Link>
          <Link
            href="/account/wishlist"
            onClick={close}
            className="flex items-center gap-3 rounded-sm px-2 py-2.5 text-sm hover:bg-surface"
          >
            <Heart size={17} className="text-ink-soft" />
            Wishlist
          </Link>
          <Link
            href="/track"
            onClick={close}
            className="flex items-center gap-3 rounded-sm px-2 py-2.5 text-sm hover:bg-surface"
          >
            <Package size={17} className="text-ink-soft" />
            Track an order
          </Link>
        </div>
      </div>
    </SlideOver>
  );
}
