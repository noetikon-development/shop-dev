import "server-only";

/**
 * Resolve the image shown for a single cart / checkout / order line.
 *
 * A line is always for one specific Variant, so its Colour is known (when the
 * product has a Colour option). Resolution priority — all from authoritative
 * `ProductImage` / `Variant` data, never anything the browser sent:
 *
 *   1. the selected Colour's primary image  (lowest sortOrder in that group)
 *   2. the selected Colour's first image    (same as 1 once ordered)
 *   3. a product-level primary image        (optionValueId null, lowest sortOrder)
 *   4. a product-level first image           (same as 3 once ordered)
 *   5. the legacy Variant.imageUrl
 *   6. the in-house illustration fallback (`art:accessory:<slug>`)
 *
 * `images` MUST already be ordered by `[sortOrder asc, id asc]` so the first
 * row of any group is that group's primary — then `.find()` gives priorities
 * 1/2 and 3/4 in one step.
 */
export function resolveLineImageUrl(input: {
  images: { url: string; optionValueId: string | null }[];
  colourValueId: string | null;
  variantImageUrl: string | null;
  slug: string;
}): string {
  const { images, colourValueId, variantImageUrl, slug } = input;

  if (colourValueId) {
    const forColour = images.find((i) => i.optionValueId === colourValueId);
    if (forColour) return forColour.url;
  }

  const productLevel = images.find((i) => i.optionValueId == null);
  if (productLevel) return productLevel.url;

  return variantImageUrl || `art:accessory:${slug}`;
}

/**
 * The Colour `ProductOptionValue` id for a variant, or null when the product
 * has no Colour option. Used to pick that colour's images for the line.
 */
export function colourValueIdOf(
  optionValues: { optionValue: { id: string; option: { name: string } } }[],
): string | null {
  return (
    optionValues.find((ov) => ov.optionValue.option.name === "Colour")?.optionValue.id ?? null
  );
}
