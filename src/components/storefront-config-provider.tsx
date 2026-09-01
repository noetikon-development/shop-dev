"use client";

import { createContext, useContext } from "react";
import {
  FREE_SHIPPING_THRESHOLD,
  STANDARD_SHIPPING_FEE,
  SHIPPING_METHODS,
} from "@/lib/constants";

/**
 * Storefront shipping configuration, resolved once server-side (from the
 * authoritative `shipping.freeThreshold` setting + the `ShippingMethod` table)
 * and provided to the client display components — the cart estimate, the
 * order-summary lines and the PDP shipping line.
 *
 * These are DISPLAY values only. The real order total is always recomputed
 * server-side at checkout from the same authoritative sources
 * (`src/lib/checkout.ts`). If the settings layer is unavailable the fallback
 * below (the historical constants) keeps the storefront rendering.
 */

export type StorefrontShippingMethod = {
  id: string;
  code: string;
  label: string;
  fee: number; // centavos
};

export type StorefrontConfig = {
  /** Order subtotal (centavos) at/above which standard shipping is free. 0 = disabled. */
  freeShippingThreshold: number;
  /** The STANDARD method's current rate (centavos) — used in PDP copy. */
  standardShippingRate: number;
  /** Active shipping methods, current rates. */
  shippingMethods: StorefrontShippingMethod[];
  /** `returns.windowDays` setting — used in PDP "N-day returns" copy. */
  returnWindowDays: number;
};

export const STOREFRONT_CONFIG_FALLBACK: StorefrontConfig = {
  freeShippingThreshold: FREE_SHIPPING_THRESHOLD,
  standardShippingRate: STANDARD_SHIPPING_FEE,
  shippingMethods: SHIPPING_METHODS.map((m) => ({
    id: m.id,
    code: m.id.toUpperCase(),
    label: m.label,
    fee: m.fee,
  })),
  returnWindowDays: 30,
};

const Ctx = createContext<StorefrontConfig>(STOREFRONT_CONFIG_FALLBACK);

export function StorefrontConfigProvider({
  value,
  children,
}: {
  value: StorefrontConfig;
  children: React.ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Storefront shipping config, with a safe fallback if no provider is mounted. */
export function useStorefrontConfig(): StorefrontConfig {
  return useContext(Ctx);
}
