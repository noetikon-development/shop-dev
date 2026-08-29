"use client";

import { create } from "zustand";
import { toast } from "sonner";
import type { CouponInput } from "@/lib/pricing";
import type { CartDTO, CartLineDTO } from "@/lib/cart";
import {
  getCart,
  addToCart,
  updateCartItem,
  removeCartItem,
  clearCart,
  syncCart,
} from "@/lib/cart-actions";

/**
 * Client-side mirror of the server-authoritative cart. This store never decides
 * prices, quantities or availability — it calls a server action and replaces
 * its state with whatever the server returns. <CartProvider> drives hydration
 * and the guest→customer merge.
 *
 * The applied coupon lives here in memory only (it is display maths, not cart
 * persistence — see Step 7 notes). It resets on a full page reload.
 */

export type CartLine = CartLineDTO;

type CartState = {
  lines: CartLine[];
  subtotal: number;
  itemCount: number;
  hasIssues: boolean;
  coupon: CouponInput | null;
  hydrated: boolean;
  pending: boolean;

  apply: (dto: CartDTO) => void;
  hydrate: () => Promise<void>;
  bootstrap: () => Promise<void>;
  add: (input: {
    productId: string;
    variantId?: string;
    quantity?: number;
  }) => Promise<{ ok: boolean; error?: string }>;
  setQuantity: (variantId: string, quantity: number) => Promise<void>;
  removeItem: (variantId: string) => Promise<void>;
  clear: () => Promise<void>;
  setCoupon: (coupon: CouponInput | null) => void;
  totalItems: () => number;
};

export const useCart = create<CartState>()((set, get) => ({
  lines: [],
  subtotal: 0,
  itemCount: 0,
  hasIssues: false,
  coupon: null,
  hydrated: false,
  pending: false,

  apply: (dto) =>
    set({
      lines: dto.lines,
      subtotal: dto.subtotal,
      itemCount: dto.itemCount,
      hasIssues: dto.hasIssues,
      hydrated: true,
    }),

  hydrate: async () => {
    try {
      get().apply(await getCart());
    } catch {
      set({ hydrated: true });
    }
  },

  bootstrap: async () => {
    try {
      const res = await syncCart();
      get().apply(res.cart);
      for (const n of res.notices) toast(n);
    } catch {
      await get().hydrate();
    }
  },

  add: async (input) => {
    set({ pending: true });
    try {
      const res = await addToCart({ quantity: 1, ...input });
      get().apply(res.cart);
      if (res.notice) toast(res.notice);
      return { ok: res.ok, error: res.error };
    } finally {
      set({ pending: false });
    }
  },

  setQuantity: async (variantId, quantity) => {
    set({ pending: true });
    try {
      const res = await updateCartItem({ variantId, quantity });
      get().apply(res.cart);
      if (res.error) toast.error(res.error);
      else if (res.notice) toast(res.notice);
    } finally {
      set({ pending: false });
    }
  },

  removeItem: async (variantId) => {
    set({ pending: true });
    try {
      get().apply((await removeCartItem({ variantId })).cart);
    } finally {
      set({ pending: false });
    }
  },

  clear: async () => {
    set({ pending: true });
    try {
      get().apply((await clearCart()).cart);
    } finally {
      set({ pending: false });
    }
  },

  setCoupon: (coupon) => set({ coupon }),
  totalItems: () => get().itemCount,
}));
