"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Heart, Check, Truck, RotateCcw, ShoppingBag } from "lucide-react";
import { toast } from "sonner";
import { ProductImage } from "@/components/product-image";
import { Stars, PriceTag, ProductBadges } from "@/components/ui/primitives";
import { useCart } from "@/lib/cart-store";
import { useWishlist } from "@/lib/wishlist-store";
import { useWishlistToggle } from "@/components/wishlist/use-wishlist-toggle";
import { useUI } from "@/lib/ui-store";
import { cn, compactNumber, estimatedDelivery, formatPrice } from "@/lib/utils";
import { useStorefrontConfig } from "@/components/storefront-config-provider";
import { Button } from "@/components/ui/button";
import { QuantityStepper } from "@/components/ui/quantity-stepper";
import { matchVariant, hasPurchasableVariant } from "@/lib/variant-match";
import { isPhotoRef } from "@/lib/art-ref";
import type { GalleryImage, ProductDetailView } from "@/lib/types";

export function ProductViewer({ product }: { product: ProductDetailView }) {
  const openCart = useUI((s) => s.openCart);
  const add = useCart((s) => s.add);
  const { freeShippingThreshold, standardShippingRate, returnWindowDays } = useStorefrontConfig();
  const [adding, setAdding] = useState(false);
  const wished = useWishlist((s) => s.ids.includes(product.id));
  const toggleWish = useWishlistToggle();

  const colourOption = product.options.find((o) => o.name === "Colour");
  const sizeOption = product.options.find((o) => o.name === "Size");

  const [selected, setSelected] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    if (colourOption?.values[0]) init[colourOption.id] = colourOption.values[0].id;
    return init;
  });
  const [qty, setQty] = useState(1);
  const [activeImage, setActiveImage] = useState(0);

  // The exact purchasable Variant for the current selection — matched on
  // option-value ids, never on display text. `null` until every option has a
  // value AND a Variant row exists for that precise combination.
  const matchedVariant = useMemo(
    () => matchVariant(product.options, product.variants, selected),
    [selected, product.variants, product.options],
  );

  // Every option must be chosen before we can resolve or add a variant.
  const missingSelection = product.options.some((o) => !selected[o.id]);
  const missingOptionNames = product.options
    .filter((o) => !selected[o.id])
    .map((o) => o.name.toLowerCase());

  // All options chosen, but no Variant sells that combination.
  const comboUnavailable = !missingSelection && !matchedVariant;

  const activePrice = matchedVariant?.price ?? product.price;
  const activeCompareAt = matchedVariant?.compareAtPrice ?? product.compareAtPrice;
  const stock = matchedVariant?.stock ?? product.totalStock;
  const outOfStock = Boolean(matchedVariant) && matchedVariant!.stock <= 0;
  const reorderPoint = matchedVariant?.reorderPoint ?? 0;
  const lowStock =
    Boolean(matchedVariant) && !outOfStock && stock > 0 && stock <= Math.max(0, reorderPoint);

  // Is a given size purchasable for the currently selected colour?
  const isSizeAvailable = (sizeValueId: string) => {
    const colourId = colourOption ? selected[colourOption.id] : undefined;
    return hasPurchasableVariant(
      product.variants,
      [sizeValueId, ...(colourId ? [colourId] : [])],
    );
  };

  // Is a given colour purchasable (in any size, or the selected size)?
  const isColourAvailable = (colourValueId: string) => {
    const sizeId = sizeOption ? selected[sizeOption.id] : undefined;
    return hasPurchasableVariant(
      product.variants,
      [colourValueId, ...(sizeId ? [sizeId] : [])],
    );
  };

  const colourValueId = colourOption ? selected[colourOption.id] : undefined;
  const colourName = colourOption?.values.find((v) => v.id === colourValueId)?.value;

  // Gallery = the images EXPLICITLY assigned to the selected colour
  // (ProductImage.optionValueId — the source of truth). If that colour has no
  // images, fall back to the product-level images (optionValueId === null); if
  // there are none of those either, fall back to the in-house illustration.
  // Images are never matched by filename, slug, upload order or content, and a
  // photo assigned to another colour is NEVER shown for the selected colour.
  const galleryImages = useMemo<GalleryImage[]>(() => {
    const resolve = (): GalleryImage[] => {
      if (colourValueId) {
        const forColour = product.images.filter((i) => i.optionValueId === colourValueId);
        if (forColour.length > 0) return forColour;
      }
      const productLevel = product.images.filter((i) => i.optionValueId == null);
      if (productLevel.length > 0) return productLevel;
      // Nothing for this colour and nothing product-level. Do not borrow another
      // colour's photos — show the illustration instead.
      return [{ url: `art:${product.art}:${product.slug}`, alt: product.name, optionValueId: null }];
    };

    // Presentation-layer de-duplication (Phase 5D Stage 6). Entries that render
    // as real photography stay individually navigable. Entries that render as
    // the "photography coming soon" placeholder are visually identical to one
    // another, so collapse them to a single gallery slot. No image data is
    // touched — only what the gallery shows. If this selection has any real
    // photo, the placeholder slots drop out entirely.
    const resolved = resolve();
    const photos = resolved.filter((i) => isPhotoRef(i.url));
    return photos.length > 0 ? photos : resolved.slice(0, 1);
  }, [colourValueId, product.images, product.art, product.slug, product.name]);

  // Clamp the active index to the current gallery (it is reset to 0 on a colour
  // change, but the gallery can otherwise be shorter than a stale index).
  const mainImage = galleryImages[activeImage] ?? galleryImages[0];

  async function addToBag() {
    if (missingSelection) {
      toast.error(`Please choose a ${missingOptionNames.join(" and ")}`);
      return;
    }
    if (comboUnavailable) {
      toast.error("That combination isn’t available");
      return;
    }
    if (!matchedVariant || outOfStock) {
      toast.error("That combination is out of stock");
      return;
    }
    setAdding(true);
    const res = await add({
      productId: product.id,
      variantId: matchedVariant.id,
      quantity: qty,
    });
    setAdding(false);
    if (res.ok) {
      toast.success("Added to your bag");
      openCart();
    } else {
      toast.error(res.error ?? "Couldn’t add that to your bag");
    }
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[1.05fr_1fr] lg:gap-14">
      {/* Gallery */}
      <div className="lg:sticky lg:top-24 lg:self-start">
        <div className="flex gap-3">
          {galleryImages.length > 1 && (
            <div
              className="hidden w-16 shrink-0 flex-col gap-2.5 sm:flex"
              role="group"
              aria-label={`${product.name} — image thumbnails`}
            >
              {galleryImages.map((img, i) => (
                <button
                  key={img.url + i}
                  onClick={() => setActiveImage(i)}
                  className={cn(
                    "aspect-square overflow-hidden rounded-sm border transition-colors",
                    activeImage === i ? "border-ink" : "border-line hover:border-line-strong",
                  )}
                  aria-label={`Show ${product.name} image ${i + 1} of ${galleryImages.length}`}
                  aria-pressed={activeImage === i}
                >
                  <ProductImage src={img.url} alt="" sizes="64px" />
                </button>
              ))}
            </div>
          )}

          <div className="relative flex-1 overflow-hidden rounded-lg bg-surface-sunken">
            <div
              className="aspect-square"
              role="img"
              aria-label={mainImage.alt || product.name}
            >
              <ProductImage
                src={mainImage.url}
                alt={mainImage.alt || product.name}
                sizes="(max-width: 1024px) 100vw, 45vw"
                priority
              />
            </div>
            <div className="absolute left-4 top-4">
              <ProductBadges badges={product.badges} />
            </div>
            <button
              onClick={() => toggleWish(product.id)}
              aria-label={wished ? "Remove from wishlist" : "Save to wishlist"}
              aria-pressed={wished}
              className={cn(
                "absolute right-4 top-4 grid h-10 w-10 tap place-items-center rounded-full bg-surface/90 backdrop-blur transition-colors",
                wished ? "text-clay" : "text-ink-soft hover:text-ink",
              )}
            >
              <Heart size={18} fill={wished ? "currentColor" : "none"} />
            </button>
          </div>
        </div>

        {galleryImages.length > 1 && (
          <div
            className="mt-3 flex justify-center gap-1 sm:hidden"
            role="group"
            aria-label={`${product.name} — image navigation`}
          >
            {galleryImages.map((img, i) => (
              <button
                key={img.url + i}
                onClick={() => setActiveImage(i)}
                className="tap flex items-center justify-center"
                aria-label={`Show ${product.name} image ${i + 1} of ${galleryImages.length}`}
                aria-pressed={activeImage === i}
              >
                <span
                  className={cn(
                    "block h-1.5 rounded-full transition-all",
                    activeImage === i ? "w-5 bg-ink" : "w-1.5 bg-line-strong",
                  )}
                />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Purchase panel */}
      <div>
        <p className="eyebrow-brand">{product.brand}</p>
        <h1 className="mt-2 text-title sm:text-display">{product.name}</h1>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <Link href="#reviews" className="inline-flex items-center gap-2">
            <Stars value={product.ratingAvg} count={product.ratingCount} size={15} />
          </Link>
          <span className="text-sm text-ink-faint">
            {compactNumber(product.soldCount)} sold
          </span>
        </div>

        <div className="mt-5">
          <PriceTag price={activePrice} compareAt={activeCompareAt} size="lg" />
        </div>

        <p className="mt-4 text-pretty text-ink-soft">{product.shortDescription}</p>

        {/* Colour */}
        {colourOption && (
          <div className="mt-7">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">
                Colour: <span className="text-ink-soft">{colourName}</span>
              </p>
            </div>
            <div className="mt-2.5 flex flex-wrap gap-2">
              {colourOption.values.map((v) => {
                const active = selected[colourOption.id] === v.id;
                const available = isColourAvailable(v.id);
                return (
                  <button
                    key={v.id}
                    onClick={() => {
                      setSelected((s) => ({ ...s, [colourOption.id]: v.id }));
                      setActiveImage(0);
                    }}
                    aria-label={available ? v.value : `${v.value} — out of stock`}
                    aria-pressed={active}
                    title={available ? v.value : `${v.value} — out of stock`}
                    className={cn(
                      "relative h-10 w-10 rounded-full border-2 transition-transform",
                      active ? "border-ink" : "border-line hover:border-line-strong",
                      !available && !active && "opacity-45",
                    )}
                  >
                    <span
                      className="absolute inset-1 rounded-full border border-black/10"
                      style={{ backgroundColor: v.swatchHex ?? "#ccc" }}
                    />
                    {active && (
                      <Check
                        size={14}
                        className="absolute inset-0 m-auto text-white mix-blend-difference"
                      />
                    )}
                    {!available && !active && (
                      <span className="absolute inset-0 m-auto h-px w-8 -rotate-45 bg-ink-soft" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Size */}
        {sizeOption && (
          <div className="mt-6">
            <p className="text-sm font-medium">Size</p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              {sizeOption.values.map((v) => {
                const active = selected[sizeOption.id] === v.id;
                const available = isSizeAvailable(v.id);
                return (
                  <button
                    key={v.id}
                    onClick={() => setSelected((s) => ({ ...s, [sizeOption.id]: v.id }))}
                    disabled={!available}
                    aria-pressed={active}
                    className={cn(
                      "min-w-12 rounded-sm border px-3 py-2.5 text-sm transition-colors",
                      active
                        ? "border-ink bg-ink text-paper"
                        : "border-line-strong text-ink hover:border-ink",
                      !available &&
                        "cursor-not-allowed border-line text-ink-faint line-through hover:border-line",
                    )}
                  >
                    {v.value}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Stock hint */}
        {lowStock && (
          <p className="mt-4 text-sm font-medium text-clay">
            Low stock — only {stock} left{colourName ? ` in ${colourName}` : ""}
          </p>
        )}

        {/* Quantity + add */}
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-stretch">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium sm:sr-only">Quantity</span>
            <QuantityStepper
              value={qty}
              onChange={setQty}
              max={stock || 99}
              size="md"
              ariaLabel={`Quantity — ${product.name}`}
            />
          </div>

          <Button
            size="lg"
            onClick={addToBag}
            disabled={outOfStock || comboUnavailable || adding}
            className="w-full sm:flex-1"
          >
            <ShoppingBag size={16} />
            {comboUnavailable
              ? "Unavailable"
              : outOfStock
                ? "Out of stock"
                : adding
                  ? "Adding…"
                  : `Add to bag · ${formatPrice(activePrice * qty)}`}
          </Button>
        </div>

        <Button
          variant="outline"
          onClick={() => toggleWish(product.id)}
          aria-pressed={wished}
          className="mt-3 w-full"
        >
          <Heart size={16} fill={wished ? "currentColor" : "none"} className={wished ? "text-clay" : ""} />
          {wished ? "Saved to wishlist" : "Save to wishlist"}
        </Button>

        {/* Reassurance */}
        <div className="mt-7 space-y-3 border-t border-line pt-6 text-sm">
          <div className="flex items-start gap-3">
            <Truck size={17} className="mt-0.5 shrink-0 text-ink-soft" />
            <p className="text-ink-soft">
              {product.freeShipping ||
              (freeShippingThreshold > 0 && activePrice >= freeShippingThreshold) ? (
                <>
                  <span className="font-medium text-ink">Free standard shipping.</span> Estimated
                  delivery {estimatedDelivery()}.
                </>
              ) : (
                <>
                  Standard shipping {formatPrice(standardShippingRate)} · Estimated delivery{" "}
                  {estimatedDelivery()}.
                  {freeShippingThreshold > 0 && (
                    <> Free over {formatPrice(freeShippingThreshold)}.</>
                  )}
                </>
              )}
            </p>
          </div>
          <div className="flex items-start gap-3">
            <RotateCcw size={17} className="mt-0.5 shrink-0 text-ink-soft" />
            <p className="text-ink-soft">
              <span className="font-medium text-ink">{returnWindowDays}-day returns.</span> Unused and in original
              packaging.
            </p>
          </div>
        </div>

        {/* Highlights */}
        {product.highlights.length > 0 && (
          <ul className="mt-6 space-y-2">
            {product.highlights.map((h) => (
              <li key={h} className="flex items-start gap-2.5 text-sm text-ink-soft">
                <Check size={15} className="mt-0.5 shrink-0 text-sage" />
                {h}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
