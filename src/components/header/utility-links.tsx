"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * The secondary links on the right of the desktop nav row (Track order /
 * Promotions / All categories). Labels + visibility come from the Phase 5C
 * `nav.primary` block via `getResolvedNav()`; the route is owned by the app.
 */
export function UtilityLinks({ links }: { links: { label: string; href: string }[] }) {
  const pathname = usePathname();
  return (
    <div className="flex shrink-0 items-center gap-4 text-meta text-ink-faint">
      {links.map((u) => {
        const current = u.href.startsWith("/") && pathname === u.href;
        return (
          <Link
            key={u.href}
            href={u.href}
            aria-current={current ? "page" : undefined}
            className={cn(
              "whitespace-nowrap transition-colors hover:text-ink",
              current && "text-ink",
            )}
          >
            {u.label}
          </Link>
        );
      })}
    </div>
  );
}
