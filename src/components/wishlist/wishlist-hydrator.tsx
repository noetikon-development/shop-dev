"use client";

import { useEffect } from "react";
import { useWishlist } from "@/lib/wishlist-store";

/**
 * Seeds the client wishlist mirror with the ids resolved server-side for the
 * signed-in user (empty array for guests). Rendered once in the shop layout.
 */
export function WishlistHydrator({ ids }: { ids: string[] }) {
  const hydrate = useWishlist((s) => s.hydrate);

  useEffect(() => {
    hydrate(ids);
    // Re-run when the server-provided set changes (e.g. after login navigation).
  }, [ids, hydrate]);

  return null;
}
