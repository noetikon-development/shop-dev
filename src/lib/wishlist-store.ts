"use client";

import { create } from "zustand";
import { toggleWishlistItem } from "@/lib/wishlist-actions";

/**
 * Client mirror of the server-persisted wishlist (Step 15).
 *
 * The authoritative wishlist lives in PostgreSQL. This store holds only the set
 * of product ids so the heart controls can render instantly and toggle
 * optimistically. It is hydrated once per page load by <WishlistProvider> and
 * never written to localStorage.
 */

type WishlistState = {
  ids: string[];
  hydrated: boolean;
  /** productIds with an in-flight toggle */
  pending: string[];
  hydrate: (ids: string[]) => void;
  has: (productId: string) => boolean;
  /** Optimistic toggle. Resolves to whether the caller must prompt a sign-in. */
  toggle: (productId: string) => Promise<{ needsAuth: boolean }>;
};

export const useWishlist = create<WishlistState>()((set, get) => ({
  ids: [],
  hydrated: false,
  pending: [],

  hydrate: (ids) => set({ ids, hydrated: true }),

  has: (productId) => get().ids.includes(productId),

  toggle: async (productId) => {
    if (get().pending.includes(productId)) return { needsAuth: false };
    const had = get().ids.includes(productId);
    // optimistic
    set((s) => ({
      ids: had ? s.ids.filter((id) => id !== productId) : [productId, ...s.ids],
      pending: [...s.pending, productId],
    }));

    try {
      const res = await toggleWishlistItem({ productId });
      if (res.ok) {
        set((s) => ({ ids: res.ids, pending: s.pending.filter((id) => id !== productId) }));
        return { needsAuth: false };
      }
      // revert
      set((s) => ({
        ids: had ? [productId, ...s.ids.filter((id) => id !== productId)] : s.ids.filter((id) => id !== productId),
        pending: s.pending.filter((id) => id !== productId),
      }));
      return { needsAuth: Boolean(res.needsAuth) };
    } catch {
      set((s) => ({
        ids: had ? [productId, ...s.ids.filter((id) => id !== productId)] : s.ids.filter((id) => id !== productId),
        pending: s.pending.filter((id) => id !== productId),
      }));
      return { needsAuth: false };
    }
  },
}));
