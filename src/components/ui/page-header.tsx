import { cn } from "@/lib/utils";

/**
 * Storefront page header (Phase 5D Stage 2). One treatment for the top-of-page
 * title block used by the cart, content pages, the account shell and the
 * category / collection pages — previously each hand-rolled
 * `h1 text-3xl sm:text-display` plus a subtitle.
 *
 * The heading is on the type scale (`text-title sm:text-display`). `children`
 * renders as trailing actions on the same baseline as the title.
 */
export function PageHeader({
  title,
  eyebrow,
  description,
  meta,
  className,
  children,
}: {
  title: string;
  eyebrow?: string;
  description?: React.ReactNode;
  meta?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <header className={cn("mb-8", className)}>
      {eyebrow && <p className="eyebrow mb-2">{eyebrow}</p>}
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <h1 className="text-title sm:text-display">{title}</h1>
        {children}
      </div>
      {description && (
        <p className="mt-2.5 max-w-2xl text-pretty text-ink-soft">{description}</p>
      )}
      {meta && <p className="mt-2 text-meta text-ink-faint">{meta}</p>}
    </header>
  );
}
