"use client";

import { useCallback } from "react";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { useWishlist } from "@/lib/wishlist-store";

/**
 * One place for the "toggle heart" behaviour shared by the product card, the
 * PDP and the wishlist page: optimistic toggle, toast feedback, and a sign-in
 * prompt for guests (the wishlist is only persisted for authenticated
 * customers — spec §17).
 */
export function useWishlistToggle() {
  const router = useRouter();
  const pathname = usePathname();
  const toggle = useWishlist((s) => s.toggle);

  return useCallback(
    async (productId: string) => {
      const wasWished = useWishlist.getState().ids.includes(productId);
      const { needsAuth } = await toggle(productId);
      if (needsAuth) {
        toast("Sign in to save items to your wishlist");
        router.push(`/login?redirectTo=${encodeURIComponent(pathname)}`);
        return;
      }
      toast(wasWished ? "Removed from wishlist" : "Saved to wishlist");
    },
    [toggle, router, pathname],
  );
}
