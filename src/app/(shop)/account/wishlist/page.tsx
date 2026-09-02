import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { loadWishlist } from "@/lib/wishlist";
import { WishlistView } from "@/components/wishlist/wishlist-view";

export const metadata: Metadata = { title: "Wishlist" };
export const dynamic = "force-dynamic";

export default async function AccountWishlistPage() {
  const user = await requireUser("/account/wishlist");
  const items = await loadWishlist(user.id);

  return (
    <section>
      <h2 className="text-subtitle">Wishlist</h2>
      <p className="mt-1.5 text-sm text-ink-soft">
        Pieces you&apos;ve saved for later. Saved to your account and synced across devices.
      </p>
      <div className="mt-6">
        <WishlistView initialItems={items} />
      </div>
    </section>
  );
}
