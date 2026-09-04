import "server-only";
import { cache } from "react";
import { prisma } from "@/lib/prisma";

/**
 * Thin, per-request-cached reader for a single `StoreSetting` row — used by the
 * seller plane to check `marketplace.multiSellerCheckout` without pulling the
 * whole settings bag. Returns the raw string `value` (or `null` when absent).
 *
 * This module NEVER writes. `marketplace.multiSellerCheckout` has no admin UI
 * and is not changed by any code path (9E-3C onwards).
 */
export const getStoreSetting = cache(async (key: string): Promise<string | null> => {
  const row = await prisma.storeSetting.findUnique({ where: { key }, select: { value: true } });
  return row?.value ?? null;
});

/** True only when `marketplace.multiSellerCheckout` is explicitly `"true"`. */
export async function isMultiSellerCheckoutEnabled(): Promise<boolean> {
  return (await getStoreSetting("marketplace.multiSellerCheckout")) === "true";
}
