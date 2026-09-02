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

/** The PayMongo Checkout Sessions API base — set in exactly one place.
 *
 *  Phase 6B: confirmed against PayMongo's own OpenAPI spec + reference docs that
 *  Checkout Sessions live at **`POST https://api.paymongo.com/v1/checkout_sessions`**.
 *  There is no `/v2/checkout_sessions` endpoint (the Phase 6A default of `/v2`
 *  was based on the stage brief, not the live API, and is corrected here). If
 *  PayMongo ever ships a v2 Checkout Sessions API, set `PAYMONGO_API_BASE`
 *  rather than editing code.
 *
 *  Overridable via `PAYMONGO_API_BASE` (a pinned version, or a localhost mock
 *  during bring-up). HTTPS is required except for an explicit `http://localhost`
 *  / `http://127.0.0.1` mock in local development. */
export const DEFAULT_PAYMONGO_API_BASE = "https://api.paymongo.com/v1";

export function paymongoApiBase(): string {
  const override = (process.env.PAYMONGO_API_BASE ?? "").trim();
  const base = override || DEFAULT_PAYMONGO_API_BASE;
  const httpsOk = /^https:\/\//i.test(base);
  const localhostHttpOk =
    process.env.NODE_ENV !== "production" && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(base);
  return httpsOk || localhostHttpOk ? base.replace(/\/+$/, "") : DEFAULT_PAYMONGO_API_BASE;
}

/** Derive test/live from the secret-key prefix. Never returns or logs the key. */
export function detectKeyMode(rawKey: string | undefined): PaymentsMode | "unknown" {
  const k = (rawKey ?? "").trim();
  if (k.startsWith("sk_test_")) return "test";
  if (k.startsWith("sk_live_")) return "live";
  return "unknown";
}

export type PaymentsConfig = {
  /** Phase 6B gate — enough to CREATE a Checkout Session and redirect the
   *  customer: the `payments.onlinePaymentEnabled` setting is on AND
   *  `PAYMONGO_SECRET_KEY` is present AND `!modeMismatch`. Does NOT require the
   *  webhook secret. */
  sessionsEnabled: boolean;
  /** Master switch (Phase 6C) — `sessionsEnabled` AND `PAYMONGO_WEBHOOK_SECRET`
   *  is present, so a verified webhook can actually confirm a payment. The
   *  webhook handler and refund routing gate on THIS. Phase 6A/6B: false. */
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

  const sessionsEnabled = onlineSetting && hasSecretKey && !modeMismatch;

  return {
    sessionsEnabled,
    onlinePaymentEnabled: sessionsEnabled && hasWebhookSecret,
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
