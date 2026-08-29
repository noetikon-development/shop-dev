import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { WishlistView } from "@/components/wishlist/wishlist-view";

export const metadata: Metadata = { title: "Wishlist" };
export const dynamic = "force-dynamic";

export default async function WishlistPage() {
  await requireUser("/wishlist");

  return (
    <div className="container-page py-8 sm:py-12">
      <h1 className="text-3xl sm:text-[2.5rem]">Wishlist</h1>
      <p className="mt-1.5 text-sm text-ink-soft">Pieces you&apos;ve saved for later.</p>
      <div className="mt-8">
        <WishlistView />
      </div>
    </div>
  );
}
