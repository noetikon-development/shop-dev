import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export type Crumb = { label: string; href?: string };

/**
 * Canonical breadcrumb trail (Phase 5D Stage 2). Replaces the inline markup
 * on the product and category pages. The last item is rendered as the current
 * page (`aria-current="page"`, no link). Overflow-safe — wraps rather than
 * scrolling the page.
 */
export function Breadcrumbs({ items, className }: { items: Crumb[]; className?: string }) {
  return (
    <nav
      aria-label="Breadcrumb"
      className={cn("flex flex-wrap items-center gap-1.5 text-meta text-ink-faint", className)}
    >
      {items.map((c, i) => {
        const last = i === items.length - 1;
        return (
          <span key={`${c.label}-${i}`} className="flex items-center gap-1.5">
            {c.href && !last ? (
              <Link href={c.href} className="hover:text-ink">
                {c.label}
              </Link>
            ) : (
              <span
                className={cn(last && "text-ink")}
                aria-current={last ? "page" : undefined}
              >
                {c.label}
              </span>
            )}
            {!last && <ChevronRight size={12} aria-hidden="true" />}
          </span>
        );
      })}
    </nav>
  );
}
