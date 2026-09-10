/**
 * Shipping provider registry / resolver (Phase 9F-47C).
 *
 * FAIL CLOSED TO MANUAL. `resolveShippingProvider()` returns
 * `ManualShippingProvider` unless EVERY condition for a real integration holds:
 *   - `shipping.integrationEnabled` StoreSetting is exactly `"true"`, AND
 *   - `shipping.provider` names a provider this registry knows, AND
 *   - that provider's credentials are present in the server environment.
 *
 * None of those hold today (`shipping.integrationEnabled` defaults to `false`,
 * no provider is registered, no `SHIPPING_*` env vars exist), so production
 * always resolves to MANUAL and the existing manual workflow is untouched.
 *
 * 9F-47D registers the first real provider in `PROVIDERS` below. Nothing here
 * enables the switch or reads a credential value.
 */
import "server-only";
import { prisma } from "@/lib/prisma";
import type { ShippingProvider } from "@/lib/shipping/provider";
import { manualShippingProvider } from "@/lib/shipping/providers/manual";

export type ShippingMode = "test" | "live";

export type ShippingConfig = {
  /** True ONLY when the switch, a known provider, and its credentials all line up. */
  integrationEnabled: boolean;
  /** The resolved provider code, or `""` when none / unknown. */
  provider: string;
  mode: ShippingMode;
};

/**
 * Known real providers. Empty until 9F-47D. A key here maps a
 * `shipping.provider` setting value to its `ShippingProvider` instance.
 */
const PROVIDERS: Record<string, ShippingProvider> = {};

/** True when the named provider's API key is set in the server environment. */
function providerCredentialsPresent(provider: string): boolean {
  const raw = process.env[`SHIPPING_${provider}_API_KEY`];
  return typeof raw === "string" && raw.trim().length > 0;
}

const SETTING_KEYS = ["shipping.integrationEnabled", "shipping.provider", "shipping.mode"] as const;

export async function getShippingConfig(): Promise<ShippingConfig> {
  const rows = await prisma.storeSetting.findMany({
    where: { key: { in: [...SETTING_KEYS] } },
    select: { key: true, value: true },
  });
  const map = new Map(rows.map((r) => [r.key, r.value]));

  const providerRaw = (map.get("shipping.provider") ?? "").trim();
  const providerKnown = providerRaw in PROVIDERS;
  const mode: ShippingMode = (map.get("shipping.mode") ?? "test").trim() === "live" ? "live" : "test";

  const enabled =
    map.get("shipping.integrationEnabled") === "true" &&
    providerKnown &&
    providerCredentialsPresent(providerRaw);

  return { integrationEnabled: enabled, provider: enabled ? providerRaw : "", mode };
}

/**
 * Resolve the shipping provider for the current store configuration. Always
 * returns a provider — never throws, never null. Fails closed to MANUAL.
 */
export async function resolveShippingProvider(): Promise<ShippingProvider> {
  const cfg = await getShippingConfig();
  if (!cfg.integrationEnabled) return manualShippingProvider;
  return PROVIDERS[cfg.provider] ?? manualShippingProvider;
}
