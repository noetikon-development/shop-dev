"use client";

import { useState } from "react";
import Link from "next/link";
import { Heart, Plus } from "lucide-react";
import { toast } from "sonner";
import { ProductImage } from "@/components/product-image";
import { Stars, PriceTag, ProductBadges } from "@/components/ui/primitives";
import { Skeleton } from "@/components/ui/skeleton";
import { useWishlist } from "@/lib/wishlist-store";
import { useWishlistToggle } from "@/components/wishlist/use-wishlist-toggle";
import { useCart } from "@/lib/cart-store";
import { cn, compactNumber } from "@/lib/utils";
import type { ProductCardView } from "@/lib/types";

export function ProductCard({
  product,
  showCategory = false,
  className,
  priority,
  dense = false,
}: {
  product: ProductCardView;
  showCategory?: boolean;
  className?: string;
  priority?: boolean;
  /**
   * Tightens the info block for horizontal rails: title clamped to one line and
   * the free-shipping line dropped. Keeps card heights close together so a
   * swipeable strip doesn't reserve a tall block of empty space under the
   * shorter cards. Full-width grids leave it off.
   */
  dense?: boolean;
}) {
  const wished = useWishlist((s) => s.ids.includes(product.id));
  const toggleWish = useWishlistToggle();
  const add = useCart((s) => s.add);
  const [adding, setAdding] = useState(false);

  const href = `/p/${product.slug}`;
  const hasVariants = product.colorSwatches.length > 0;
  const canQuickAdd = !hasVariants && product.inStock && Boolean(product.defaultVariantId);

  async function quickAdd() {
    if (!product.defaultVariantId || adding) return;
    setAdding(true);
    const res = await add({
      productId: product.id,
      variantId: product.defaultVariantId,
      quantity: 1,
    });
    setAdding(false);
    if (res.ok) toast.success(`Added ${product.name} to your cart`);
    else toast.error(res.error ?? "Couldn’t add that to your cart");
  }

  return (
    <div className={cn("group relative flex flex-col", className)}>
      <div className="relative overflow-hidden rounded-md bg-surface-sunken">
        <Link href={href} aria-label={product.name} className="block aspect-[4/5]">
          <ProductImage
            src={product.image.url}
            alt={product.image.alt}
            priority={priority}
            className="transition-transform duration-500 ease-out group-hover:scale-[1.04]"
          />
        </Link>

        <div className="pointer-events-none absolute inset-x-3 top-3 flex items-start justify-between">
          <ProductBadges badges={product.badges} />
          <button
            type="button"
            onClick={() => toggleWish(product.id)}
            aria-label={wished ? "Remove from wishlist" : "Save to wishlist"}
            aria-pressed={wished}
            className={cn(
              "pointer-events-auto grid h-9 w-9 tap place-items-center rounded-full bg-surface/90 backdrop-blur transition-colors",
              wished ? "text-clay" : "text-ink-soft hover:text-ink",
            )}
          >
            <Heart size={17} fill={wished ? "currentColor" : "none"} strokeWidth={1.6} />
          </button>
        </div>

        {canQuickAdd && (
          <button
            type="button"
            onClick={quickAdd}
            disabled={adding}
            className="absolute inset-x-3 bottom-3 flex translate-y-2 items-center justify-center gap-1.5 rounded-sm bg-ink/95 py-2.5 text-meta font-medium text-paper opacity-0 backdrop-blur transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100 focus-visible:translate-y-0 focus-visible:opacity-100 disabled:opacity-60"
          >
            <Plus size={14} /> {adding ? "Adding…" : "Quick add"}
          </button>
        )}

        {!product.inStock && (
          <div className="absolute inset-x-3 bottom-3 rounded-sm bg-surface/95 py-2 text-center text-meta font-medium text-ink-soft">
            Out of stock
          </div>
        )}

        {product.inStock && product.stockStatus === "LOW_STOCK" && (
          <div className="pointer-events-none absolute left-3 bottom-3 rounded-full bg-surface/95 px-2 py-1 text-micro font-medium text-warning backdrop-blur">
            Low stock
          </div>
        )}
      </div>

      <div className="mt-3.5 flex flex-1 flex-col">
        {showCategory && (
          <p className="eyebrow mb-1">{product.categoryName}</p>
        )}
        <h3
          className={cn(
            "text-body font-medium leading-snug text-ink",
            dense && "line-clamp-1",
          )}
        >
          <Link href={href} className="link-underline">
            {product.name}
          </Link>
        </h3>
        <p className="mt-1 line-clamp-1 text-meta text-ink-faint">{product.shortDescription}</p>

        <div className="mt-2.5 flex items-center gap-2">
          <Stars value={product.ratingAvg} size={13} showNumber={false} />
          <span className="text-micro text-ink-faint">
            {product.ratingAvg.toFixed(1)} · {compactNumber(product.soldCount)} sold
          </span>
        </div>

        <div className="mt-2 flex items-end justify-between gap-2">
          <PriceTag
            price={product.price}
            compareAt={product.compareAtPrice}
            from={product.priceFrom}
            size="sm"
          />
          {product.colorSwatches.length > 0 && (
            <div className="flex items-center gap-1">
              {product.colorSwatches.slice(0, 4).map((hex, i) => (
                <span
                  key={i}
                  className="h-3.5 w-3.5 rounded-full border border-line-strong"
                  style={{ backgroundColor: hex }}
                />
              ))}
              {product.colorSwatches.length > 4 && (
                <span className="text-micro text-ink-faint">
                  +{product.colorSwatches.length - 4}
                </span>
              )}
            </div>
          )}
        </div>

        {product.freeShipping && !dense && (
          <p className="mt-2 text-micro font-medium text-success">Free shipping</p>
        )}
      </div>
    </div>
  );
}

export function ProductCardSkeleton() {
  return (
    <div className="flex flex-col">
      <Skeleton className="aspect-[4/5] rounded-md" />
      <div className="mt-3.5 space-y-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="h-4 w-1/3" />
      </div>
    </div>
  );
}
