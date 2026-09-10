import type { ArtKind } from "@/lib/product-art";

/**
 * Product imagery is referenced as `art:<kind>:<seed>` strings in the database.
 * These helpers parse that reference so the <ProductImage> component can render
 * the in-house SVG illustration.
 */
export function parseArtRef(url: string | null | undefined): { kind: ArtKind; seed: string } | null {
  if (!url || !url.startsWith("art:")) return null;
  const [, kind, ...rest] = url.split(":");
  return { kind: (kind as ArtKind) ?? "accessory", seed: rest.join(":") || kind };
}

export function artKindFromRef(url: string | null | undefined): ArtKind {
  return parseArtRef(url)?.kind ?? "accessory";
}

/**
 * True when a reference renders as real photography (a Storage / public URL),
 * false for an `art:` illustration ref or an empty value — those all render as
 * the identical "image coming soon" placeholder. Used to de-duplicate the
 * PDP gallery at the presentation layer without touching image data.
 */
export function isPhotoRef(url: string | null | undefined): boolean {
  return Boolean(url) && !url!.startsWith("art:");
}

/** The largest fixed thumbnail width (px) served straight from the source. */
export const THUMBNAIL_BYPASS_MAX_PX = 128;

/**
 * Should this <ProductImage> render be served straight from the source URL,
 * bypassing Vercel's Image Optimizer (`next/image` `unoptimized`)?
 *
 * Small fixed-size thumbnails (≈≤128px — cart / checkout / order lines, the PDP
 * thumbnail rail, admin list rows) request `/_next/image` widths in the 32–128
 * band. Those tiny widths are almost never in the optimizer cache, so once a
 * project's Image Optimization quota is spent `/_next/image` returns HTTP 402
 * for them — the thumbnail breaks — while the larger, already-cached widths
 * (256/384/640…) keep working. The source images are already `.webp`, so
 * skipping the optimizer for a 64px slot costs a few tens of KB and nothing
 * visible; larger images (PDP hero, product cards, wishlist) keep normal
 * optimization because their `sizes` is a responsive string, never a bare px.
 */
export function thumbnailBypassesOptimizer(opts: { compact?: boolean; sizes?: string }): boolean {
  if (opts.compact) return true;
  const m = /^\s*(\d+)px\s*$/.exec(opts.sizes ?? "");
  return m !== null && Number(m[1]) <= THUMBNAIL_BYPASS_MAX_PX;
}
