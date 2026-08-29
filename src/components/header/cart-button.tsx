"use client";

import Link from "next/link";
import { ShoppingBag, Heart } from "lucide-react";
import { useCart } from "@/lib/cart-store";
import { useWishlist } from "@/lib/wishlist-store";
import { useUI } from "@/lib/ui-store";

export function CartButton() {
  const count = useCart((s) => s.itemCount);
  const hydrated = useCart((s) => s.hydrated);
  const openCart = useUI((s) => s.openCart);

  return (
    <button
      onClick={openCart}
      className="relative grid h-10 w-10 place-items-center rounded-full text-ink-soft transition-colors hover:bg-surface hover:text-ink"
      aria-label={`Open bag${hydrated && count ? `, ${count} items` : ""}`}
    >
      <ShoppingBag size={19} strokeWidth={1.6} />
      {hydrated && count > 0 && (
        <span className="absolute -right-0.5 -top-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-clay px-1 text-[10px] font-semibold text-white">
          {count > 99 ? "99+" : count}
        </span>
      )}
    </button>
  );
}

export function WishlistButton() {
  const count = useWishlist((s) => s.slugs.length);
  const hydrated = useWishlist((s) => s.hydrated);

  return (
    <Link
      href="/wishlist"
      className="relative hidden h-10 w-10 place-items-center rounded-full text-ink-soft transition-colors hover:bg-surface hover:text-ink sm:grid"
      aria-label={`Wishlist${hydrated && count ? `, ${count} items` : ""}`}
    >
      <Heart size={19} strokeWidth={1.6} />
      {hydrated && count > 0 && (
        <span className="absolute -right-0.5 -top-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-ink px-1 text-[10px] font-semibold text-paper">
          {count}
        </span>
      )}
    </Link>
  );
}
