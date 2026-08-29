import Link from "next/link";
import Image from "next/image";
import { cn } from "@/lib/utils";

/**
 * AXIARO logo — the actual supplied mark (public/axiaro-logo.png), an open-triangle
 * "A" with the brand's geometric cut. Rendered as-is: no recreation, no font
 * fallback, no added wordmark. Size it via `className` (set a height, width auto).
 */
export function Logo({ className }: { className?: string }) {
  return (
    <Link href="/" aria-label="AXIARO — home" className="inline-flex items-center">
      <Image
        src="/axiaro-logo.png"
        alt="AXIARO"
        width={472}
        height={397}
        priority
        className={cn("h-9 w-auto", className)}
      />
    </Link>
  );
}
