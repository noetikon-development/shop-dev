import "server-only";
import { prisma } from "@/lib/prisma";
import { decodeSettingValue, SETTING_FIELD_BY_KEY } from "@/lib/admin/settings-registry";

/**
 * Payments / PayMongo configuration (Step 21 P4, Phase 4-A).
 *
 * Two layers:
 *  - SECRETS come from server-only environment variables (never NEXT_PUBLIC_):
 *      PAYMONGO_SECRET_KEY      — API auth (Basic <base64(key:)>)
 *      PAYMONGO_WEBHOOK_SECRET  — HMAC key for webhook signature verification
 *  - BEHAVIOUR comes from StoreSetting rows (payments.*), read uncached here so
 *    the webhook handler (which runs outside a Next request scope) sees live
 *    values.
 *
 * Phase 4-A: no env vars are set, `payments.onlinePaymentEnabled` is false, and
 * `isOnlinePaymentEnabled()` returns false no matter what — belt and braces.
 */

export type PaymentsMode = "test" | "live";

export type PaymentsConfig = {
  /** Master switch. True only when BOTH the setting is on AND the secrets exist. */
  onlinePaymentEnabled: boolean;
  /** Pause a paid order at PAID instead of auto-advancing to PROCESSING. */
  holdForReview: boolean;
  mode: PaymentsMode;
  enabledMethods: string[];
  /** Whether the PayMongo secret key is present (never the value). */
  hasSecretKey: boolean;
  /** Whether the webhook signing secret is present (never the value). */
  hasWebhookSecret: boolean;
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

  return {
    // The master switch requires the setting AND both secrets. In Phase 4-A no
    // secrets are set, so this is false regardless of the setting.
    onlinePaymentEnabled: onlineSetting && hasSecretKey && hasWebhookSecret,
    holdForReview,
    mode,
    enabledMethods,
    hasSecretKey,
    hasWebhookSecret,
  };
}

/** Convenience — the master switch only. */
export async function isOnlinePaymentEnabled(): Promise<boolean> {
  return (await getPaymentsConfig()).onlinePaymentEnabled;
}
