"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Heart } from "lucide-react";
import { ProductCard, ProductCardSkeleton } from "@/components/product-card";
import { useWishlist } from "@/lib/wishlist-store";
import type { ProductCardView } from "@/lib/types";

export function WishlistView() {
  const slugs = useWishlist((s) => s.slugs);
  const hydrated = useWishlist((s) => s.hydrated);
  const clear = useWishlist((s) => s.clear);
  const [products, setProducts] = useState<ProductCardView[] | null>(null);

  useEffect(() => {
    if (!hydrated) return;
    if (slugs.length === 0) {
      setProducts([]);
      return;
    }
    fetch(`/api/products/by-slugs?slugs=${slugs.map(encodeURIComponent).join(",")}`)
      .then((r) => r.json())
      .then((d) => setProducts(d.products ?? []))
      .catch(() => setProducts([]));
  }, [slugs, hydrated]);

  if (!hydrated || products === null) {
    return (
      <div className="grid grid-cols-2 gap-x-4 gap-y-9 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <ProductCardSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (products.length === 0) {
    return (
      <div className="flex flex-col items-center rounded-lg border border-dashed border-line-strong py-20 text-center">
        <div className="grid h-14 w-14 place-items-center rounded-full bg-surface-sunken">
          <Heart size={22} className="text-ink-faint" />
        </div>
        <h2 className="mt-4 text-lg">Your wishlist is empty</h2>
        <p className="mt-1.5 max-w-sm text-sm text-ink-soft">
          Tap the heart on any product to save it here for later.
        </p>
        <Link href="/c/all" className="btn btn-primary mt-5">
          Browse products
        </Link>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <p className="text-sm text-ink-soft">
          {products.length} saved {products.length === 1 ? "item" : "items"}
        </p>
        <button
          onClick={clear}
          className="text-sm text-ink-faint underline underline-offset-4 hover:text-ink"
        >
          Clear all
        </button>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-9 sm:grid-cols-3 lg:grid-cols-4">
        {products.map((p) => (
          <ProductCard key={p.id} product={p} showCategory />
        ))}
      </div>
    </div>
  );
}
