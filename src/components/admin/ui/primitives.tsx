import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ *
 * Server-compatible presentational primitives for the admin panel.
 * No hooks — safe to render in Server Components.
 * ------------------------------------------------------------------ */

// --- Card -----------------------------------------------------------
export function Card({
  children,
  className,
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-md border border-line bg-surface",
        padded && "p-5",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  action,
  className,
}: {
  title: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-4 flex items-center justify-between gap-3", className)}>
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      {action}
    </div>
  );
}

// --- StatCard ------------------------------------------------------
export function StatCard({
  label,
  value,
  hint,
  icon,
  placeholder,
}: {
  label: string;
  /** Render `null`/`undefined` as a placeholder dash — never fabricate. */
  value?: ReactNode;
  hint?: string;
  icon?: ReactNode;
  placeholder?: string;
}) {
  const hasValue = value !== null && value !== undefined && value !== "";
  return (
    <Card className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-ink-faint">
          {label}
        </span>
        {icon && <span className="text-ink-faint">{icon}</span>}
      </div>
      <span
        className={cn(
          "font-display text-2xl leading-tight",
          hasValue ? "text-ink" : "text-ink-faint",
        )}
      >
        {hasValue ? value : "—"}
      </span>
      <span className="text-xs text-ink-faint">
        {hasValue ? hint : (placeholder ?? "No data yet")}
      </span>
    </Card>
  );
}

// --- PageHeader ---------------------------------------------------
export function PageHeader({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="mb-6 border-b border-line pb-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl text-ink sm:text-[1.75rem]">{title}</h1>
          {description && (
            <p className="mt-1 max-w-2xl text-sm text-ink-soft">{description}</p>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="mt-4">{children}</div>}
    </header>
  );
}

// --- Breadcrumbs ------------------------------------------------
export function Breadcrumbs({
  items,
  className,
}: {
  items: { label: string; href?: string }[];
  className?: string;
}) {
  return (
    <nav aria-label="Breadcrumb" className={cn("min-w-0", className)}>
      <ol className="flex items-center gap-1.5 overflow-hidden text-xs text-ink-faint">
        {items.map((item, i) => {
          const last = i === items.length - 1;
          return (
            <li key={`${item.label}-${i}`} className="flex items-center gap-1.5 truncate">
              {item.href && !last ? (
                <Link href={item.href} className="truncate hover:text-ink">
                  {item.label}
                </Link>
              ) : (
                <span className={cn("truncate", last && "text-ink-soft")}>{item.label}</span>
              )}
              {!last && <span aria-hidden>/</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// --- StatusBadge ------------------------------------------------
type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: "bg-surface-sunken text-ink-soft ring-line-strong",
  success: "bg-sage-50 text-sage ring-sage/30",
  warning: "bg-[#fbf1e3] text-[#8a5a1f] ring-[#e6c9a0]",
  danger: "bg-clay-50 text-clay ring-clay/30",
  info: "bg-[#e9eef5] text-[#3a5680] ring-[#b9c8de]",
};

export function StatusBadge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: BadgeTone;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        TONE_CLASSES[tone],
      )}
    >
      {children}
    </span>
  );
}

// --- EmptyState -----------------------------------------------
export function EmptyState({
  icon,
  title,
  description,
  action,
  compact,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-md border border-dashed border-line-strong bg-surface text-center",
        compact ? "px-6 py-10" : "px-6 py-16",
      )}
    >
      {icon && (
        <div className="mb-3 grid h-11 w-11 place-items-center rounded-full bg-surface-sunken text-ink-faint">
          {icon}
        </div>
      )}
      <p className="text-sm font-medium text-ink">{title}</p>
      {description && (
        <p className="mt-1 max-w-sm text-sm text-ink-soft">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

// --- LoadingState --------------------------------------------
export function LoadingState({
  label = "Loading…",
  rows = 4,
}: {
  label?: string;
  rows?: number;
}) {
  return (
    <div className="rounded-md border border-line bg-surface p-5" aria-busy aria-live="polite">
      <span className="sr-only">{label}</span>
      <div className="space-y-3">
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="h-4 animate-pulse rounded bg-surface-sunken"
            style={{ width: `${90 - i * 12}%` }}
          />
        ))}
      </div>
    </div>
  );
}

// --- ErrorState (presentational; see error.tsx for the boundary) --
export function ErrorState({
  title = "Something went wrong",
  description,
  retry,
}: {
  title?: string;
  description?: string;
  retry?: ReactNode;
}) {
  return (
    <div className="rounded-md border border-clay/30 bg-clay-50 px-6 py-10 text-center">
      <p className="text-sm font-medium text-clay">{title}</p>
      {description && <p className="mt-1 text-sm text-clay/90">{description}</p>}
      {retry && <div className="mt-4">{retry}</div>}
    </div>
  );
}
