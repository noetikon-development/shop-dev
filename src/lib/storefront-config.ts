import "server-only";
import { unstable_cache } from "next/cache";
import { getFreeShippingThreshold, getActiveShippingMethods } from "@/lib/shipping";
import { getReturnsConfig } from "@/lib/returns";
import {
  STOREFRONT_CONFIG_FALLBACK,
  type StorefrontConfig,
} from "@/components/storefront-config-provider";

/**
 * Server resolver for the storefront shipping display config (Phase 5A).
 *
 * Authoritative sources:
 *   - free-shipping threshold  -> `shipping.freeThreshold` StoreSetting
 *   - shipping rates / methods -> the `ShippingMethod` table
 *
 * There is no second hardcoded rate source: the historical `constants.ts`
 * values are used ONLY as the fallback when the database is unreachable.
 *
 * Cached under the `settings` tag so an admin change to Settings or to a
 * Shipping method refreshes the storefront without a redeploy.
 */

const load = unstable_cache(
  async (): Promise<StorefrontConfig> => {
    try {
      const [threshold, methods, returns] = await Promise.all([
        getFreeShippingThreshold(),
        getActiveShippingMethods(),
        getReturnsConfig(),
      ]);

      const shippingMethods = methods.length
        ? methods.map((m) => ({ id: m.id, code: m.code, label: m.name, fee: m.rate }))
        : STOREFRONT_CONFIG_FALLBACK.shippingMethods;

      const standard =
        shippingMethods.find((m) => m.code.toUpperCase() === "STANDARD") ?? shippingMethods[0];

      return {
        freeShippingThreshold:
          threshold > 0 ? threshold : STOREFRONT_CONFIG_FALLBACK.freeShippingThreshold,
        standardShippingRate: standard
          ? standard.fee
          : STOREFRONT_CONFIG_FALLBACK.standardShippingRate,
        shippingMethods,
        returnWindowDays:
          returns.windowDays > 0
            ? returns.windowDays
            : STOREFRONT_CONFIG_FALLBACK.returnWindowDays,
      };
    } catch {
      return STOREFRONT_CONFIG_FALLBACK;
    }
  },
  ["storefront-shipping-config"],
  { revalidate: 300, tags: ["settings"] },
);

export function getStorefrontConfig(): Promise<StorefrontConfig> {
  return load();
}
