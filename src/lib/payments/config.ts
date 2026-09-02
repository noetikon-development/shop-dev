import "server-only";
import { prisma } from "@/lib/prisma";
import { decodeSettingValue, SETTING_FIELD_BY_KEY } from "@/lib/admin/settings-registry";

/**
 * Payments / PayMongo configuration (Step 21 P4; API-version + test/live
 * reconciliation done in Phase 6A).
 *
 * Two layers:
 *  - SECRETS come from server-only environment variables (never NEXT_PUBLIC_):
 *      PAYMONGO_SECRET_KEY      — API auth (Basic <base64(key:)>).  sk_test_… / sk_live_…
 *      PAYMONGO_WEBHOOK_SECRET  — HMAC key for webhook signature verification
 *      PAYMONGO_API_BASE        — optional override of the API base URL
 *  - BEHAVIOUR comes from StoreSetting rows (payments.*), read uncached here so
 *    the webhook handler (which runs outside a Next request scope) sees live
 *    values.
 *
 * Phase 6A status: no PayMongo env vars are set in any environment,
 * `payments.onlinePaymentEnabled` is false, and `onlinePaymentEnabled` below is
 * false no matter what — the master switch requires the setting AND both
 * secrets AND a consistent test/live mode. The customer checkout flow does not
 * import anything from this module.
 */

export type PaymentsMode = "test" | "live";

/** The default PayMongo Hosted Checkout API base. Centralised here so the
 *  version is set in exactly one place (Phase 6A target: v2 Checkout Sessions).
 *  Overridable via PAYMONGO_API_BASE for a pinned version or a mock during
 *  Phase 6B bring-up. Always HTTPS. */
export const DEFAULT_PAYMONGO_API_BASE = "https://api.paymongo.com/v2";

export function paymongoApiBase(): string {
  const override = (process.env.PAYMONGO_API_BASE ?? "").trim();
  const base = override || DEFAULT_PAYMONGO_API_BASE;
  // Refuse a non-HTTPS base outright — payments never travel over plain HTTP.
  return /^https:\/\//i.test(base) ? base.replace(/\/+$/, "") : DEFAULT_PAYMONGO_API_BASE;
}

/** Derive test/live from the secret-key prefix. Never returns or logs the key. */
export function detectKeyMode(rawKey: string | undefined): PaymentsMode | "unknown" {
  const k = (rawKey ?? "").trim();
  if (k.startsWith("sk_test_")) return "test";
  if (k.startsWith("sk_live_")) return "live";
  return "unknown";
}

export type PaymentsConfig = {
  /** Master switch. True only when the setting is on AND both secrets exist AND
   *  the configured mode agrees with the key prefix AND a live key is not being
   *  used outside production. Phase 6A: always false. */
  onlinePaymentEnabled: boolean;
  /** Pause a paid order at PAID instead of auto-advancing to PROCESSING. */
  holdForReview: boolean;
  /** The mode the store setting asks for. */
  mode: PaymentsMode;
  /** The mode implied by the configured secret key (or "unknown" if none). */
  detectedMode: PaymentsMode | "unknown";
  /** `payments.mode` setting disagrees with the key prefix, or a live key is
   *  present outside NODE_ENV=production. When true the feature stays OFF. */
  modeMismatch: boolean;
  enabledMethods: string[];
  /** Whether the PayMongo secret key is present (never the value). */
  hasSecretKey: boolean;
  /** Whether the webhook signing secret is present (never the value). */
  hasWebhookSecret: boolean;
  /** The resolved API base URL (safe to display — contains no secret). */
  apiBase: string;
};

function boolDefault(key: string): boolean {
  return Boolean(SETTING_FIELD_BY_KEY[key]?.default);
}

function envPresent(name: string): boolean {
  return Boolean((process.env[name] ?? "").trim());
}

export async function getPaymentsConfig(): Promise<PaymentsConfig> {
  const hasSecretKey = envPresent("PAYMONGO_SECRET_KEY");
  const hasWebhookSecret = envPresent("PAYMONGO_WEBHOOK_SECRET");
  const detectedMode = detectKeyMode(process.env.PAYMONGO_SECRET_KEY);

  let onlineSetting = boolDefault("payments.onlinePaymentEnabled");
  let holdForReview = boolDefault("payments.holdForReview");
  let mode: PaymentsMode = "test";
  let enabledMethods: string[] = ["COD", "CARD", "GCASH"];

  try {
    const rows = await prisma.storeSetting.findMany({
      where: {
        key: {
          in: [
            "payments.onlinePaymentEnabled",
            "payments.holdForReview",
            "payments.mode",
            "payments.enabledMethods",
          ],
        },
      },
      select: { key: true, value: true },
    });
    for (const r of rows) {
      if (r.key === "payments.onlinePaymentEnabled") onlineSetting = decodeSettingValue(r.value, "boolean") === true;
      if (r.key === "payments.holdForReview") holdForReview = decodeSettingValue(r.value, "boolean") === true;
      if (r.key === "payments.mode") {
        const m = String(decodeSettingValue(r.value, "string")).trim().toLowerCase();
        mode = m === "live" ? "live" : "test";
      }
      if (r.key === "payments.enabledMethods") {
        const v = decodeSettingValue(r.value, "json");
        if (Array.isArray(v)) enabledMethods = v.map(String);
      }
    }
  } catch {
    // DB unreachable — safe, restrictive defaults (feature stays off).
  }

  // Cross-environment safety: a mode mismatch, or a live key outside production,
  // hard-disables online payments (belt and braces alongside the master switch).
  const keyDisagrees = detectedMode !== "unknown" && detectedMode !== mode;
  const liveKeyOutsideProd = detectedMode === "live" && process.env.NODE_ENV !== "production";
  const modeMismatch = keyDisagrees || liveKeyOutsideProd;

  return {
    onlinePaymentEnabled:
      onlineSetting && hasSecretKey && hasWebhookSecret && !modeMismatch,
    holdForReview,
    mode,
    detectedMode,
    modeMismatch,
    enabledMethods,
    hasSecretKey,
    hasWebhookSecret,
    apiBase: paymongoApiBase(),
  };
}

/** Convenience — the master switch only. */
export async function isOnlinePaymentEnabled(): Promise<boolean> {
  return (await getPaymentsConfig()).onlinePaymentEnabled;
}
