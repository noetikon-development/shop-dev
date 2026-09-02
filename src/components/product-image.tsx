import Image from "next/image";
import { parseArtRef } from "@/lib/art-ref";
import { ProductArt } from "@/lib/product-art";
import { PhotoComingSoon } from "@/components/photo-coming-soon";
import { cn } from "@/lib/utils";

/**
 * Renders product imagery inside a fixed-aspect container.
 *
 * - A real image URL (http/https, /public) renders through `next/image` with
 *   `fill` — the catalogue's most frequent image gets responsive srcset,
 *   lazy-loading and zero layout shift (Phase 5D Stage 3).
 * - Otherwise the reference is an in-house `art:` illustration ref, which means
 *   the product has no real photo yet. In the storefront that renders the
 *   branded "image coming soon" placeholder. Admin previews pass
 *   `allowArt` to keep rendering the illustration instead.
 *
 * The colour → image mapping is unchanged: callers still resolve which URL to
 * pass (per `ProductImage.optionValueId`); this component only decides how a
 * given reference is drawn.
 *
 * The parent element must establish the size + aspect ratio (`aspect-[4/5]` on
 * a card, `aspect-square` on the PDP, a fixed `h-/w-` on a line-item thumb) so
 * photographed and placeholder products occupy exactly the same area.
 */
export function ProductImage({
  src,
  alt,
  className,
  priority,
  compact = false,
  allowArt = false,
  sizes = "(max-width: 640px) 55vw, (max-width: 768px) 42vw, (max-width: 1024px) 30vw, 25vw",
}: {
  src: string;
  alt: string;
  className?: string;
  priority?: boolean;
  /** Icon-only placeholder — for small line-item thumbnails. */
  compact?: boolean;
  /** Admin previews: render the `art:` illustration rather than the placeholder. */
  allowArt?: boolean;
  sizes?: string;
}) {
  const art = parseArtRef(src);

  if (art || !src) {
    return (
      <div className={cn("relative h-full w-full overflow-hidden", className)}>
        {art && allowArt ? (
          <ProductArt kind={art.kind} seed={art.seed} />
        ) : (
          <PhotoComingSoon compact={compact} />
        )}
      </div>
    );
  }

  return (
    <div className={cn("relative h-full w-full overflow-hidden", className)}>
      <Image src={src} alt={alt} fill sizes={sizes} className="object-cover" priority={priority} />
    </div>
  );
}
