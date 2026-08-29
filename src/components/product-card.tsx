"use client";

import Link from "next/link";
import { Heart, Plus } from "lucide-react";
import { toast } from "sonner";
import { ProductImage } from "@/components/product-image";
import { Stars, PriceTag, ProductBadges } from "@/components/ui/primitives";
import { useWishlist } from "@/lib/wishlist-store";
import { useCart } from "@/lib/cart-store";
import { cn, compactNumber } from "@/lib/utils";
import type { ProductCardView } from "@/lib/types";

export function ProductCard({
  product,
  showCategory = false,
  className,
  priority,
}: {
  product: ProductCardView;
  showCategory?: boolean;
  className?: string;
  priority?: boolean;
}) {
  const wished = useWishlist((s) => s.slugs.includes(product.slug));
  const toggleWish = useWishlist((s) => s.toggle);
  const addLine = useCart((s) => s.addLine);

  const href = `/p/${product.slug}`;
  const hasVariants = product.colorSwatches.length > 0;

  function quickAdd() {
    if (hasVariants) return; // needs a choice — go to PDP
    addLine(
      {
        productId: product.id,
        slug: product.slug,
        name: product.name,
        variantId: `${product.id}-default`,
        variantLabel: "",
        optionSummary: "",
        unitPrice: product.price,
        compareAtPrice: product.compareAtPrice,
        imageUrl: product.image.url,
        maxStock: 99,
        freeShipping: product.freeShipping,
      },
      1,
    );
    toast.success(`Added ${product.name} to your bag`);
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
            onClick={() => {
              toggleWish(product.slug);
              toast(wished ? "Removed from wishlist" : "Saved to wishlist");
            }}
            aria-label={wished ? "Remove from wishlist" : "Save to wishlist"}
            aria-pressed={wished}
            className={cn(
              "pointer-events-auto grid h-9 w-9 place-items-center rounded-full bg-surface/90 backdrop-blur transition-colors",
              wished ? "text-clay" : "text-ink-soft hover:text-ink",
            )}
          >
            <Heart size={17} fill={wished ? "currentColor" : "none"} strokeWidth={1.6} />
          </button>
        </div>

        {!hasVariants && product.inStock && (
          <button
            type="button"
            onClick={quickAdd}
            className="absolute inset-x-3 bottom-3 flex translate-y-2 items-center justify-center gap-1.5 rounded-sm bg-ink/95 py-2.5 text-xs font-medium text-paper opacity-0 backdrop-blur transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100 focus-visible:translate-y-0 focus-visible:opacity-100"
          >
            <Plus size={14} /> Quick add
          </button>
        )}

        {!product.inStock && (
          <div className="absolute inset-x-3 bottom-3 rounded-sm bg-surface/95 py-2 text-center text-xs font-medium text-ink-soft">
            Out of stock
          </div>
        )}

        {product.inStock && product.stockStatus === "LOW_STOCK" && (
          <div className="pointer-events-none absolute left-3 bottom-3 rounded-full bg-surface/95 px-2 py-1 text-[10px] font-medium text-[#8a5a1f] backdrop-blur">
            Low stock
          </div>
        )}
      </div>

      <div className="mt-3.5 flex flex-1 flex-col">
        {showCategory && (
          <p className="eyebrow mb-1 !text-[10px]">{product.categoryName}</p>
        )}
        <h3 className="text-[0.95rem] font-medium leading-snug text-ink">
          <Link href={href} className="link-underline">
            {product.name}
          </Link>
        </h3>
        <p className="mt-1 line-clamp-1 text-[13px] text-ink-faint">{product.shortDescription}</p>

        <div className="mt-2.5 flex items-center gap-2">
          <Stars value={product.ratingAvg} size={13} showNumber={false} />
          <span className="text-[11px] text-ink-faint">
            {product.ratingAvg.toFixed(1)} · {compactNumber(product.soldCount)} sold
          </span>
        </div>

        <div className="mt-2 flex items-end justify-between gap-2">
          <PriceTag price={product.price} compareAt={product.compareAtPrice} size="sm" />
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
                <span className="text-[10px] text-ink-faint">
                  +{product.colorSwatches.length - 4}
                </span>
              )}
            </div>
          )}
        </div>

        {product.freeShipping && (
          <p className="mt-2 text-[11px] font-medium text-success">Free shipping</p>
        )}
      </div>
    </div>
  );
}

export function ProductCardSkeleton() {
  return (
    <div className="flex flex-col">
      <div className="aspect-[4/5] animate-pulse rounded-md bg-surface-sunken" />
      <div className="mt-3.5 space-y-2">
        <div className="h-4 w-3/4 animate-pulse rounded bg-surface-sunken" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-surface-sunken" />
        <div className="h-4 w-1/3 animate-pulse rounded bg-surface-sunken" />
      </div>
    </div>
  );
}
