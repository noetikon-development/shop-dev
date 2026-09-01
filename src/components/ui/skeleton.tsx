import { cn } from "@/lib/utils";

/** A single shimmering placeholder block (Phase 5B). Compose for card/list skeletons. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn("animate-pulse rounded bg-surface-sunken", className)} aria-hidden="true" />
  );
}
