import { cn } from "@/lib/utils";

/**
 * Canonical storefront empty state (Phase 5B). One look for "nothing here yet"
 * across the cart, wishlist, category filters and search. The admin panel keeps
 * its own `EmptyState` (denser, card-shaped) — this is the storefront one.
 */
export function EmptyState({
  icon,
  title,
  message,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  message?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border border-dashed border-line-strong px-6 py-16 text-center",
        className,
      )}
    >
      {icon && (
        <div className="mb-5 grid h-16 w-16 place-items-center rounded-full bg-surface-sunken text-ink-faint">
          {icon}
        </div>
      )}
      <h2 className="text-xl">{title}</h2>
      {message && <p className="mt-2 max-w-sm text-sm text-ink-soft">{message}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
