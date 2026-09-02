"use client";

import Link from "next/link";
import { Heart, X } from "lucide-react";
import { ProductCard } from "@/components/product-card";
import { ProductImage } from "@/components/product-image";
import { useWishlist } from "@/lib/wishlist-store";
import { useWishlistToggle } from "@/components/wishlist/use-wishlist-toggle";
import { formatPrice } from "@/lib/utils";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import type { WishlistCard } from "@/lib/wishlist";

export function WishlistView({ initialItems }: { initialItems: WishlistCard[] }) {
  const ids = useWishlist((s) => s.ids);
  const hydrated = useWishlist((s) => s.hydrated);
  const toggle = useWishlistToggle();

  // The server list is the source of product data; the client `ids` set is the
  // source of truth for membership (so a heart tapped anywhere updates here).
  const visible = initialItems.filter((it) => !hydrated || ids.includes(it.id));

  if (visible.length === 0) {
    return (
      <EmptyState
        icon={<Heart size={22} />}
        title="Your wishlist is empty"
        message="Tap the heart on any product to save it here for later."
        action={
          <Link href="/c/all" className={buttonClasses()}>
            Browse products
          </Link>
        }
      />
    );
  }

  return (
    <div>
      <p className="mb-6 text-meta text-ink-soft">
        {visible.length} saved {visible.length === 1 ? "item" : "items"}
      </p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-9 md:grid-cols-3">
        {visible.map((p) =>
          p.available ? (
            <ProductCard key={p.id} product={p} showCategory />
          ) : (
            <div key={p.id} className="group relative flex flex-col">
              <div className="relative overflow-hidden rounded-md bg-surface-sunken">
                <div className="block aspect-[4/5] opacity-60 grayscale">
                  <ProductImage src={p.image.url} alt={p.image.alt} />
                </div>
                <div className="absolute inset-x-3 bottom-3 rounded-sm bg-surface/95 py-2 text-center text-meta font-medium text-ink-soft">
                  No longer available
                </div>
                <button
                  type="button"
                  onClick={() => toggle(p.id)}
                  aria-label="Remove from wishlist"
                  className="absolute right-3 top-3 grid h-9 w-9 tap place-items-center rounded-full bg-surface/90 text-ink-soft backdrop-blur transition-colors hover:text-ink"
                >
                  <X size={16} />
                </button>
              </div>
              <div className="mt-3.5 flex flex-1 flex-col">
                <p className="eyebrow mb-1">{p.categoryName}</p>
                <h3 className="text-body font-medium leading-snug text-ink-soft">{p.name}</h3>
                <p className="mt-2 text-meta tabular-nums text-ink-faint">{formatPrice(p.price)}</p>
                <p className="mt-1 text-micro text-ink-faint">
                  This piece has been retired from the catalogue.
                </p>
              </div>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
