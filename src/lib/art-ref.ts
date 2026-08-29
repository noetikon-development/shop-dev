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
