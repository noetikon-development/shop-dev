import { Camera } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Phase 5D Stage 3 — the branded "image coming soon" state.
 *
 * <ProductImage> renders this in the storefront when a product has no real
 * photo yet (its image reference is still an in-house `art:` illustration ref).
 * It is designed to read as intentional and to sit quietly next to real
 * product photography in the same grid — a warm sunken panel, one small mark,
 * one quiet line. Real photography (Option 1) is the long-term direction; this
 * is the interim treatment.
 */
export function PhotoComingSoon({
  compact = false,
  className,
}: {
  /** Icon only — for small line-item thumbnails (cart, checkout, orders). */
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-full w-full flex-col items-center justify-center gap-2 bg-surface-sunken px-3 text-center text-ink-faint",
        className,
      )}
    >
      <Camera size={compact ? 15 : 22} strokeWidth={1.5} aria-hidden="true" />
      {!compact && (
        <span className="max-w-[14ch] text-balance text-micro font-medium uppercase leading-tight tracking-wide">
          Image coming soon
        </span>
      )}
    </div>
  );
}
