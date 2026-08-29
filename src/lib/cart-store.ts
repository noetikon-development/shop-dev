"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { CouponInput } from "@/lib/pricing";

export type CartLine = {
  key: string; // productId + variantId
  productId: string;
  slug: string;
  name: string;
  variantId: string;
  variantLabel: string;
  optionSummary: string;
  unitPrice: number;
  compareAtPrice: number | null;
  imageUrl: string;
  quantity: number;
  maxStock: number;
  freeShipping: boolean;
};

type CartState = {
  lines: CartLine[];
  coupon: CouponInput | null;
  hydrated: boolean;
  addLine: (line: Omit<CartLine, "key" | "quantity">, qty?: number) => void;
  setQuantity: (key: string, qty: number) => void;
  removeLine: (key: string) => void;
  clear: () => void;
  setCoupon: (coupon: CouponInput | null) => void;
  totalItems: () => number;
};

export const useCart = create<CartState>()(
  persist(
    (set, get) => ({
      lines: [],
      coupon: null,
      hydrated: false,
      addLine: (line, qty = 1) => {
        const key = `${line.productId}:${line.variantId}`;
        const lines = [...get().lines];
        const idx = lines.findIndex((l) => l.key === key);
        if (idx >= 0) {
          const next = Math.min(lines[idx].quantity + qty, line.maxStock || 99);
          lines[idx] = { ...lines[idx], quantity: next, maxStock: line.maxStock };
        } else {
          lines.push({ ...line, key, quantity: Math.min(qty, line.maxStock || 99) });
        }
        set({ lines });
      },
      setQuantity: (key, qty) => {
        const lines = get()
          .lines.map((l) =>
            l.key === key ? { ...l, quantity: Math.max(1, Math.min(qty, l.maxStock || 99)) } : l,
          )
          .filter((l) => l.quantity > 0);
        set({ lines });
      },
      removeLine: (key) => set({ lines: get().lines.filter((l) => l.key !== key) }),
      clear: () => set({ lines: [], coupon: null }),
      setCoupon: (coupon) => set({ coupon }),
      totalItems: () => get().lines.reduce((n, l) => n + l.quantity, 0),
    }),
    {
      name: "axiaro.cart.v1",
      partialize: (s) => ({ lines: s.lines, coupon: s.coupon }),
      onRehydrateStorage: () => (state) => {
        if (state) state.hydrated = true;
      },
    },
  ),
);
