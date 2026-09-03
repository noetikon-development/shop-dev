import Link from "next/link";
import { Star } from "lucide-react";
import { cn, formatPrice, discountPercent } from "@/lib/utils";
import { PRODUCT_BADGES } from "@/lib/constants";
import { Badge } from "@/components/ui/badge";

export function Stars({
  value,
  count,
  size = 14,
  showNumber = true,
  className,
}: {
  value: number;
  count?: number;
  size?: number;
  showNumber?: boolean;
  className?: string;
}) {
  const rounded = Math.round(value * 2) / 2;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-ink-soft", className)}>
      <span className="inline-flex" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((i) => {
          const fill = rounded >= i ? 1 : rounded >= i - 0.5 ? 0.5 : 0;
          return (
            <span key={i} className="relative" style={{ width: size, height: size }}>
              <Star size={size} className="absolute inset-0 text-line-strong" strokeWidth={1.5} />
              {fill > 0 && (
                <span
                  className="absolute inset-0 overflow-hidden"
                  style={{ width: `${fill * 100}%` }}
                >
                  <Star
                    size={size}
                    className="text-clay"
                    fill="currentColor"
                    strokeWidth={1.5}
                  />
                </span>
              )}
            </span>
          );
        })}
      </span>
      {showNumber && (
        <span className="text-meta font-medium tabular-nums">
          {value.toFixed(1)}
          {count != null && <span className="text-ink-faint"> ({count})</span>}
        </span>
      )}
    </span>
  );
}

export function PriceTag({
  price,
  compareAt,
  from = false,
  size = "md",
  className,
}: {
  price: number;
  compareAt?: number | null;
  /** Prefix the price with "From " (product spans more than one winning price). */
  from?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const pct = discountPercent(price, compareAt);
  const sizes = {
    sm: "text-body",
    md: "text-subtitle",
    lg: "text-title",
  };
  return (
    <span className={cn("inline-flex flex-wrap items-baseline gap-x-2 gap-y-0.5", className)}>
      <span className={cn("font-medium tabular-nums text-ink", sizes[size])}>
        {from && <span className="mr-1 font-normal text-ink-faint">From</span>}
        {formatPrice(price)}
      </span>
      {pct > 0 && (
        <>
          <span
            className={cn(
              "tabular-nums text-ink-faint line-through",
              size === "lg" ? "text-body" : "text-meta",
            )}
          >
            {formatPrice(compareAt!)}
          </span>
          <Badge tone="sale">−{pct}%</Badge>
        </>
      )}
    </span>
  );
}

export function ProductBadges({
  badges,
  className,
}: {
  badges: string[];
  className?: string;
}) {
  if (!badges.length) return null;
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {badges.map((b) => {
        const meta = PRODUCT_BADGES[b];
        if (!meta) return null;
        return (
          <span
            key={b}
            className={cn(
              // Font size as an arbitrary length (≈ --text-meta, 13px), not a
              // `text-*` scale token: `meta.className` carries a `text-<colour>`
              // class and tailwind-merge would otherwise drop a same-prefix
              // `text-micro`/`text-meta` as a conflict. Keeps the merch badge
              // refined and secondary to the image / name / price.
              "rounded-sm px-2 py-0.5 text-[0.8125rem] font-semibold uppercase tracking-wider",
              meta.className,
            )}
          >
            {meta.label}
          </span>
        );
      })}
    </div>
  );
}

export function Pill({
  children,
  active,
  as = "span",
  href,
  onClick,
  className,
}: {
  children: React.ReactNode;
  active?: boolean;
  as?: "span" | "button" | "link";
  href?: string;
  onClick?: () => void;
  className?: string;
}) {
  const cls = cn(
    "inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-body transition-colors",
    active
      ? "border-ink bg-ink text-paper"
      : "border-line-strong bg-surface text-ink-soft hover:border-ink hover:text-ink",
    className,
  );
  if (as === "link" && href) {
    return (
      <Link href={href} className={cls}>
        {children}
      </Link>
    );
  }
  if (as === "button") {
    return (
      <button type="button" onClick={onClick} className={cls}>
        {children}
      </button>
    );
  }
  return <span className={cls}>{children}</span>;
}

export function SectionHeading({
  eyebrow,
  title,
  action,
  className,
  size = "default",
}: {
  eyebrow?: string;
  title: string;
  action?: { label: string; href: string };
  className?: string;
  size?: "default" | "sm";
}) {
  return (
    <div className={cn("flex items-end justify-between gap-4", className)}>
      <div>
        {eyebrow && <p className="eyebrow mb-2">{eyebrow}</p>}
        <h2 className={size === "sm" ? "text-subtitle" : "text-subtitle sm:text-title"}>
          {title}
        </h2>
      </div>
      {action && (
        <Link
          href={action.href}
          className="link-underline shrink-0 pb-1 text-meta font-medium text-ink-soft hover:text-ink"
        >
          {action.label}
        </Link>
      )}
    </div>
  );
}
