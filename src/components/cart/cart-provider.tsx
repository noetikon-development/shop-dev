"use client";

import { useEffect, useRef } from "react";
import { useCart } from "@/lib/cart-store";

/**
 * Drives cart hydration. Mounted in the storefront layout with the current
 * app-user id (resolved server-side). On first mount — and on every auth-state
 * transition (guest→customer, logout) — it re-bootstraps the cart, which also
 * performs the one-time guest→customer merge when a signed-in visitor still
 * carries a guest cookie.
 */
export function CartProvider({
  userId,
  children,
}: {
  userId: string | null;
  children: React.ReactNode;
}) {
  const seen = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (seen.current === userId) return;
    seen.current = userId;
    void useCart.getState().bootstrap();
  }, [userId]);

  return <>{children}</>;
}
