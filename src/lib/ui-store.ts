"use client";

import { create } from "zustand";

type UIState = {
  cartOpen: boolean;
  menuOpen: boolean;
  searchOpen: boolean;
  openCart: () => void;
  closeCart: () => void;
  toggleMenu: (v?: boolean) => void;
  toggleSearch: (v?: boolean) => void;
};

export const useUI = create<UIState>((set, get) => ({
  cartOpen: false,
  menuOpen: false,
  searchOpen: false,
  openCart: () => set({ cartOpen: true, menuOpen: false }),
  closeCart: () => set({ cartOpen: false }),
  toggleMenu: (v) => set({ menuOpen: v ?? !get().menuOpen }),
  toggleSearch: (v) => set({ searchOpen: v ?? !get().searchOpen }),
}));
