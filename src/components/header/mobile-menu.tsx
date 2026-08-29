"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronRight, ChevronDown, User, Heart, Package } from "lucide-react";
import { SlideOver } from "@/components/ui/slide-over";
import { useUI } from "@/lib/ui-store";
import { cn } from "@/lib/utils";
import type { CategoryNode } from "@/lib/types";

export function MobileMenu({
  tree,
  signedIn,
}: {
  tree: CategoryNode[];
  signedIn: boolean;
}) {
  const { menuOpen, toggleMenu } = useUI();
  const [expanded, setExpanded] = useState<string | null>(null);
  const close = () => toggleMenu(false);

  return (
    <SlideOver open={menuOpen} onClose={close} title="Menu" side="left" width="max-w-sm">
      <div className="px-4 py-3">
        <Link
          href="/c/new"
          onClick={close}
          className="block border-b border-line py-3 text-[15px] font-medium"
        >
          New In
        </Link>

        {tree.map((cat) => (
          <div key={cat.id} className="border-b border-line">
            <div className="flex items-center">
              <Link
                href={`/c/${cat.slug}`}
                onClick={close}
                className="flex-1 py-3 text-[15px] font-medium"
              >
                {cat.name}
              </Link>
              <button
                onClick={() => setExpanded(expanded === cat.id ? null : cat.id)}
                aria-label={`Toggle ${cat.name}`}
                className="grid h-9 w-9 place-items-center text-ink-soft"
              >
                <ChevronDown
                  size={17}
                  className={cn("transition-transform", expanded === cat.id && "rotate-180")}
                />
              </button>
            </div>
            {expanded === cat.id && (
              <ul className="pb-2">
                {cat.children.map((child) => (
                  <li key={child.id}>
                    <Link
                      href={`/c/${child.slug}`}
                      onClick={close}
                      className="flex items-center justify-between py-2 pl-3 pr-2 text-sm text-ink-soft"
                    >
                      {child.name}
                      <ChevronRight size={14} className="text-ink-faint" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}

        <Link
          href="/c/sale"
          onClick={close}
          className="block border-b border-line py-3 text-[15px] font-medium text-sale"
        >
          Sale
        </Link>

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
            href="/wishlist"
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
