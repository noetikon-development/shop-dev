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
 * 9F-48 registers the first real provider (Lalamove) in `PROVIDERS` below.
 * Registering it here does NOT enable it: Production has no
 * `SHIPPING_LALAMOVE_API_KEY` env var, so `providerCredentialsPresent()`
 * keeps `resolveShippingProvider()` on MANUAL regardless of the
 * `shipping.integrationEnabled` StoreSetting value.
 */
import "server-only";
import { prisma } from "@/lib/prisma";
import type { ShippingProvider } from "@/lib/shipping/provider";
import { manualShippingProvider } from "@/lib/shipping/providers/manual";
import { lalamoveShippingProvider } from "@/lib/shipping/providers/lalamove";

export type ShippingMode = "test" | "live";

export type ShippingConfig = {
  /** True ONLY when the switch, a known provider, and its credentials all line up. */
  integrationEnabled: boolean;
  /** The resolved provider code, or `""` when none / unknown. */
  provider: string;
  mode: ShippingMode;
};

/**
 * Known real providers. A key here maps a `shipping.provider` setting value
 * to its `ShippingProvider` instance. Presence here alone does NOT enable a
 * provider — see `getShippingConfig()`'s three-way gate.
 */
const PROVIDERS: Record<string, ShippingProvider> = {
  LALAMOVE: lalamoveShippingProvider,
};

/**
 * Resolve a provider by its stable `code` (e.g. `"LALAMOVE"`), independent of
 * the `shipping.integrationEnabled` gate. Used by the webhook route: a
 * provider must be able to verify/parse a webhook it previously received even
 * if new-shipment creation through it is currently disabled — this is normal
 * webhook-architecture behaviour, not a bypass of the enabled-gate (which
 * only governs *new* shipment creation via `resolveShippingProvider()`).
 * Returns `null` for an unknown code — never MANUAL as a fallback here, since
 * a webhook route must know definitively whether it can verify a signature.
 */
export function getProviderByCode(code: string): ShippingProvider | null {
  return PROVIDERS[code.toUpperCase()] ?? null;
}

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
