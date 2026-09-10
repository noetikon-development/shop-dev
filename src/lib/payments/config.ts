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
 *  Both `POST /v1/checkout_sessions` and `POST /v2/checkout_sessions` exist;
 *  PayMongo now recommends v2 for NEW integrations (v2-only extras: pass-on
 *  fees, a deferred Payment Intent, promotions, multi-currency). Axiaro
 *  deliberately stays on **v1** for the test bring-up (9F-54) — it needs none of
 *  the v2-only features and the v1 payload/response shape is what this client is
 *  built and tested against. Moving to v2 later is a config change, not a code
 *  change: set `PAYMONGO_API_BASE=https://api.paymongo.com/v2` and review the
 *  payload (v2 defers the Payment Intent).
 *
 *  Overridable via `PAYMONGO_API_BASE` (pin a version, or point at a localhost
 *  mock during bring-up). HTTPS is required except for an explicit
 *  `http://localhost` / `http://127.0.0.1` mock in local development. */
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
  /** The `payments.*` StoreSetting read failed on every retry. The display
   *  booleans then hold their restrictive defaults (COD-only), so a page render
   *  degrades gracefully — but a write path that has ALREADY committed an order
   *  (`beginOnlinePayment`) MUST treat this as "couldn't confirm, try again",
   *  never as a genuine "online payment is switched off". */
  settingsReadFailed: boolean;
};

function boolDefault(key: string): boolean {
  return Boolean(SETTING_FIELD_BY_KEY[key]?.default);
}

function envPresent(name: string): boolean {
  return Boolean((process.env[name] ?? "").trim());
}

export type PaymentSettingRow = { key: string; value: string };

export const PAYMENT_SETTING_KEYS = [
  "payments.onlinePaymentEnabled",
  "payments.holdForReview",
  "payments.mode",
  "payments.enabledMethods",
] as const;

/**
 * Read the `payments.*` StoreSettings with a short bounded retry.
 *
 * A transient pooled-connection hiccup — e.g. a prepared-statement / contention
 * error on the query that immediately follows a large checkout `$transaction`
 * on the same warm serverless instance — must NOT be mistaken for "PayMongo is
 * disabled". Returns `null` only when every attempt fails; the caller decides
 * what a total failure means for its context.
 *
 * `reader` is injectable for tests; production uses the Prisma query.
 */
export async function readPaymentSettings(
  reader: () => Promise<PaymentSettingRow[]> = () =>
    prisma.storeSetting.findMany({
      where: { key: { in: [...PAYMENT_SETTING_KEYS] } },
      select: { key: true, value: true },
    }),
  attempts = 3,
): Promise<PaymentSettingRow[] | null> {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await reader();
    } catch (err) {
      if (i === attempts) {
        console.error(
          `[payments-config] StoreSetting read failed after ${attempts} attempts:`,
          err instanceof Error ? err.name : "unknown",
        );
        return null;
      }
      await new Promise((r) => setTimeout(r, 40 * i)); // 40ms, then 80ms
    }
  }
  return null;
}

/**
 * Map the raw setting rows onto the behaviour values. `null` rows means the
 * read failed on every attempt — the values then stay at their restrictive
 * defaults and `settingsReadFailed` is `true` (a distinct signal, never a
 * confident "disabled").
 */
export function applyPaymentSettingRows(rows: PaymentSettingRow[] | null): {
  onlineSetting: boolean;
  holdForReview: boolean;
  mode: PaymentsMode;
  enabledMethods: string[];
  settingsReadFailed: boolean;
} {
  let onlineSetting = boolDefault("payments.onlinePaymentEnabled");
  let holdForReview = boolDefault("payments.holdForReview");
  let mode: PaymentsMode = "test";
  let enabledMethods: string[] = ["COD", "CARD", "GCASH"];

  for (const r of rows ?? []) {
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

  return { onlineSetting, holdForReview, mode, enabledMethods, settingsReadFailed: rows === null };
}

export async function getPaymentsConfig(): Promise<PaymentsConfig> {
  const hasSecretKey = envPresent("PAYMONGO_SECRET_KEY");
  const hasWebhookSecret = envPresent("PAYMONGO_WEBHOOK_SECRET");
  const detectedMode = detectKeyMode(process.env.PAYMONGO_SECRET_KEY);

  const { onlineSetting, holdForReview, mode, enabledMethods, settingsReadFailed } =
    applyPaymentSettingRows(await readPaymentSettings());

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
    settingsReadFailed,
  };
}

/** Convenience — the master switch only. */
export async function isOnlinePaymentEnabled(): Promise<boolean> {
  return (await getPaymentsConfig()).onlinePaymentEnabled;
}
