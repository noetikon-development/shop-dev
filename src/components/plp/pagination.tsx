import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export function Pagination({
  page,
  pageCount,
  makeHref,
}: {
  page: number;
  pageCount: number;
  makeHref: (page: number) => string;
}) {
  if (pageCount <= 1) return null;

  const pages: (number | "…")[] = [];
  for (let i = 1; i <= pageCount; i++) {
    if (i === 1 || i === pageCount || Math.abs(i - page) <= 1) pages.push(i);
    else if (pages[pages.length - 1] !== "…") pages.push("…");
  }

  return (
    <nav className="mt-12 flex items-center justify-center gap-1.5" aria-label="Pagination">
      <PageLink href={makeHref(page - 1)} disabled={page <= 1} aria-label="Previous page">
        <ChevronLeft size={16} />
      </PageLink>
      {pages.map((p, i) =>
        p === "…" ? (
          <span key={`e${i}`} className="px-2 text-sm text-ink-faint">
            …
          </span>
        ) : (
          <PageLink key={p} href={makeHref(p)} active={p === page}>
            {p}
          </PageLink>
        ),
      )}
      <PageLink href={makeHref(page + 1)} disabled={page >= pageCount} aria-label="Next page">
        <ChevronRight size={16} />
      </PageLink>
    </nav>
  );
}

function PageLink({
  href,
  children,
  active,
  disabled,
  ...rest
}: {
  href: string;
  children: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
} & React.HTMLAttributes<HTMLAnchorElement>) {
  const cls = cn(
    "grid h-9 min-w-9 place-items-center rounded-sm border px-2 text-sm transition-colors",
    active
      ? "border-ink bg-ink text-paper"
      : "border-line-strong text-ink-soft hover:border-ink hover:text-ink",
    disabled && "pointer-events-none opacity-40",
  );
  if (disabled) return <span className={cls}>{children}</span>;
  return (
    <Link href={href} className={cls} {...rest}>
      {children}
    </Link>
  );
}
