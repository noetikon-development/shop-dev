import Link from "next/link";
import Image from "next/image";
import { cn } from "@/lib/utils";

/**
 * Store logo. Defaults to the supplied AXIARO mark (public/axiaro-logo.png) —
 * rendered as-is, no recreation, no wordmark. A store admin can override it from
 * Settings → Store identity (Step 16): pass the configured `src` + `alt` and it
 * renders that instead. Size via `className` (set a height; width stays auto).
 */
export function Logo({
  className,
  src,
  alt,
}: {
  className?: string;
  src?: string | null;
  alt?: string | null;
}) {
  return (
    <Link href="/" aria-label={`${alt || "AXIARO"} — home`} className="inline-flex items-center">
      {src ? (
        // Custom uploaded logo — dimensions unknown, so a plain <img> sized by CSS.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt || "Store logo"} className={cn("h-9 w-auto object-contain", className)} />
      ) : (
        <Image
          src="/axiaro-logo.png"
          alt="AXIARO"
          width={472}
          height={397}
          priority
          className={cn("h-9 w-auto", className)}
        />
      )}
    </Link>
  );
}
