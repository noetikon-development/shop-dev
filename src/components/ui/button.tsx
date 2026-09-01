import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Canonical storefront button (Phase 5B).
 *
 * Wraps the existing `.btn` / `.btn-primary` … CSS classes — it does not
 * introduce a new visual language. Use `<Button>` for `<button>` elements;
 * for links, apply `buttonClasses()` to a `<Link>` / `<a>`.
 */

export type ButtonVariant = "primary" | "outline" | "ghost" | "clay";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "btn-primary",
  outline: "btn-outline",
  ghost: "btn-ghost",
  clay: "btn-clay",
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: "btn-sm",
  md: "",
  lg: "btn-lg",
};

export function buttonClasses(opts?: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}): string {
  return cn(
    "btn",
    VARIANT_CLASS[opts?.variant ?? "primary"],
    SIZE_CLASS[opts?.size ?? "md"],
    opts?.className,
  );
}

type ButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
  className?: string;
};

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  disabled,
  children,
  type = "button",
  className,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(buttonClasses({ variant, size, className }), (disabled || loading) && "opacity-50")}
      {...rest}
    >
      {loading && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}
      {children}
    </button>
  );
}
