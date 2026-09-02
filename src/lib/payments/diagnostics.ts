import "server-only";
import { getPaymentsConfig } from "@/lib/payments/config";

/**
 * PayMongo configuration diagnostics (Phase 6A).
 *
 * Server-only, read-only, **no network call and no secret value**. It reports
 * only booleans / enums derived from the environment and the payments.* store
 * settings, so it is safe to surface in an admin diagnostics view.
 *
 * It deliberately does NOT contact PayMongo. There is no harmless PayMongo
 * verification endpoint that avoids creating an object, and Phase 6A must not
 * create transactions — so real connectivity is first proven in Phase 6B when
 * the first Checkout Session is created against the test API.
 */

export type PaymongoDiagnostics = {
  /** PAYMONGO_SECRET_KEY is set (value never revealed). */
  secretKeyPresent: boolean;
  /** PAYMONGO_WEBHOOK_SECRET is set (value never revealed). */
  webhookSecretPresent: boolean;
  /** Mode implied by the key prefix: sk_test_… / sk_live_… / none configured. */
  detectedMode: "test" | "live" | "unknown";
  /** Mode requested by the `payments.mode` store setting. */
  configuredMode: "test" | "live";
  /** Setting and key prefix disagree, or a live key is present outside prod. */
  modeMismatch: boolean;
  /** Resolved API base URL — contains no secret. */
  apiBase: string;
  /** The master switch (`getPaymentsConfig().onlinePaymentEnabled`). */
  onlinePaymentEnabled: boolean;
  /** Node environment the server is running in. */
  nodeEnv: string;
  /** Plain-English summary of why online payment is (not) live. */
  summary: string;
};

export async function getPaymongoDiagnostics(): Promise<PaymongoDiagnostics> {
  const c = await getPaymentsConfig();

  let summary: string;
  if (c.onlinePaymentEnabled) {
    summary = `Online payment is LIVE in ${c.mode} mode.`;
  } else {
    const missing: string[] = [];
    if (!c.hasSecretKey) missing.push("PAYMONGO_SECRET_KEY");
    if (!c.hasWebhookSecret) missing.push("PAYMONGO_WEBHOOK_SECRET");
    if (c.modeMismatch) {
      summary =
        c.detectedMode === "live" && process.env.NODE_ENV !== "production"
          ? "Disabled — a live key is configured outside production."
          : `Disabled — key mode (${c.detectedMode}) does not match the payments.mode setting (${c.mode}).`;
    } else if (missing.length) {
      summary = `Disabled — awaiting ${missing.join(" + ")}.`;
    } else {
      summary = "Disabled — the payments.onlinePaymentEnabled setting is off.";
    }
  }

  return {
    secretKeyPresent: c.hasSecretKey,
    webhookSecretPresent: c.hasWebhookSecret,
    detectedMode: c.detectedMode,
    configuredMode: c.mode,
    modeMismatch: c.modeMismatch,
    apiBase: c.apiBase,
    onlinePaymentEnabled: c.onlinePaymentEnabled,
    nodeEnv: process.env.NODE_ENV ?? "unknown",
    summary,
  };
}
