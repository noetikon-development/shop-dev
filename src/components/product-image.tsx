import { parseArtRef } from "@/lib/art-ref";
import { ProductArt } from "@/lib/product-art";
import { cn } from "@/lib/utils";

/**
 * Renders product imagery. All catalogue imagery is the in-house SVG
 * illustration system (`art:<kind>:<seed>` refs). Real URLs (http/https, /public)
 * fall through to a plain <img> so the component keeps working if photography
 * is added later.
 */
export function ProductImage({
  src,
  alt,
  className,
  seedOverride,
  priority,
}: {
  src: string;
  alt: string;
  className?: string;
  seedOverride?: string;
  priority?: boolean;
}) {
  const art = parseArtRef(src);
  if (art) {
    return (
      <ProductArt
        kind={art.kind}
        seed={seedOverride ?? art.seed}
        className={className}
        priority={priority}
      />
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} className={cn("h-full w-full object-cover", className)} />;
}
