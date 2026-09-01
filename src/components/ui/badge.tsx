import { cn } from "@/lib/utils";

/**
 * Small status/label pill (Phase 5B). Semantic tones map to the design tokens.
 * Product merchandising badges ("New", "Bestseller", "Sale") stay in
 * `ProductBadges`; filter chips stay in `Pill`.
 */
export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info" | "sale";

const TONE: Record<BadgeTone, string> = {
  neutral: "bg-surface-sunken text-ink-soft",
  success: "bg-sage-50 text-sage",
  warning: "bg-warning-50 text-warning",
  danger: "bg-clay-50 text-clay",
  info: "bg-info-50 text-info",
  sale: "bg-clay-50 text-clay",
};

export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: BadgeTone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-xs px-1.5 py-0.5 text-[11px] font-semibold",
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
