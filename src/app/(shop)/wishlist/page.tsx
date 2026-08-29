import type { Metadata } from "next";
import { WishlistView } from "@/components/wishlist/wishlist-view";

export const metadata: Metadata = { title: "Wishlist" };

export default function WishlistPage() {
  return (
    <div className="container-page py-8 sm:py-12">
      <h1 className="text-3xl sm:text-[2.5rem]">Wishlist</h1>
      <p className="mt-1.5 text-sm text-ink-soft">
        Saved on this device. Sign in to keep it across devices soon.
      </p>
      <div className="mt-8">
        <WishlistView />
      </div>
    </div>
  );
}
