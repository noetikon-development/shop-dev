import "server-only";
import type { ShippingMethod } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getStoreSettings } from "@/lib/admin/settings";

/**
 * Shipping foundation (Step 11).
 *
 * Rates live in the `ShippingMethod` table (managed in /admin/shipping). The
 * server ALWAYS loads the method and its rate from the database — the browser
 * may name a `shippingMethodId` but never a price. `shipping.freeThreshold` and
 * `shipping.countries` are store-wide policy in Store Settings. Every order
 * snapshots the code / name / amount it used, so repricing or renaming a
 * method never changes historical orders.
 *
 * No courier / tracking / zone engine here — the model is only extensible for
 * those later.
 */

export type ShippingMethodDTO = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  rate: number; // current base rate, centavos
  currency: string;
  sortOrder: number;
};

const SUPPORTED_CURRENCIES = ["PHP"];

function toDTO(m: ShippingMethod): ShippingMethodDTO {
  return {
    id: m.id,
    code: m.code,
    name: m.name,
    description: m.description,
    rate: m.rate,
    currency: m.currency,
    sortOrder: m.sortOrder,
  };
}

export async function getActiveShippingMethods(): Promise<ShippingMethodDTO[]> {
  const rows = await prisma.shippingMethod.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  return rows.map(toDTO);
}

/** The method for `id` ONLY when it exists AND is active. Null otherwise. */
export async function resolveActiveShippingMethod(id: string): Promise<ShippingMethod | null> {
  if (typeof id !== "string" || id.length < 6 || id.length > 64) return null;
  const m = await prisma.shippingMethod.findUnique({ where: { id } });
  if (!m || !m.active) return null;
  return m;
}

/** Store-wide free-shipping subtotal threshold; 0 = disabled. */
export async function getFreeShippingThreshold(): Promise<number> {
  const s = await getStoreSettings();
  const v = Number(s["shipping.freeThreshold"] ?? 0);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** ISO alpha-2 country codes the store delivers to. */
export async function getSupportedShippingCountries(): Promise<string[]> {
  const s = await getStoreSettings();
  const v = s["shipping.countries"];
  if (Array.isArray(v) && v.length) return v.map((c) => String(c).toUpperCase());
  return ["PH"];
}

export function isSupportedShippingCurrency(currency: string): boolean {
  return SUPPORTED_CURRENCIES.includes(currency);
}

/** Effective fee for a method given the order subtotal (applies the free rule). */
export function effectiveShippingFee(
  rate: number,
  subtotal: number,
  freeThreshold: number,
): number {
  if (freeThreshold > 0 && subtotal >= freeThreshold) return 0;
  return Math.max(0, rate);
}
