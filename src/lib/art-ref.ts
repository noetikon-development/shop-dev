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
