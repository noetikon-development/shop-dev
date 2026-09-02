import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { paymongoApiBase, type PaymentsMode } from "@/lib/payments/config";

/**
 * PayMongo API + webhook-signature primitives (Step 21 P4; API base centralised
 * in Phase 6A).
 *
 * Status (Phase 6A):
 *  - `verifyWebhookSignature` is USED by the webhook route (it's a pure crypto
 *    check; if no secret is configured it fails closed).
 *  - `createCheckoutSession` / `createRefund` / `getCheckoutSession` are the
 *    Phase 6B/6D API calls. They are DORMANT — nothing in the customer checkout
 *    flow imports or calls them; the only references are admin-gated
 *    reconciliation paths that themselves check `getPaymentsConfig()` first.
 *    Each throws `PaymongoNotConfiguredError` unless PAYMONGO_SECRET_KEY is set.
 *
 * The API base + version live in ONE place — `paymongoApiBase()` in config.ts
 * (default `https://api.paymongo.com/v2`, HTTPS-enforced, overridable via
 * PAYMONGO_API_BASE). The secret key and webhook secret are read from
 * server-only env vars and are never logged, never returned, never placed in a
 * NEXT_PUBLIC_ variable.
 *
 * NOTE for Phase 6B: confirm the exact Checkout Sessions path + payload shape
 * against the current PayMongo docs on the first real call, and pin
 * PAYMONGO_API_BASE if the account is on a different version.
 */

const MAX_SIGNATURE_SKEW_SECONDS = 300;

export class PaymongoNotConfiguredError extends Error {
  constructor() {
    super("PayMongo is not configured (PAYMONGO_SECRET_KEY missing).");
    this.name = "PaymongoNotConfiguredError";
  }
}

export class PaymongoApiError extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string) {
    super(`PayMongo API ${status}: ${detail}`);
    this.name = "PaymongoApiError";
    this.status = status;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Webhook signature verification  (USED in Phase 4-A)
// ---------------------------------------------------------------------------

export type SignatureVerification =
  | { ok: true }
  | { ok: false; reason: "no_secret" | "malformed_header" | "timestamp_skew" | "mismatch" };

/**
 * Verify a `Paymongo-Signature: t=<ts>,te=<test_sig>,li=<live_sig>` header
 * against the raw request body. `rawBody` MUST be the exact bytes received —
 * never a re-serialised object.
 *
 * - Fails closed when `webhookSecret` is empty (Phase 4-A: always).
 * - Rejects a timestamp more than 5 minutes from now (replay window).
 * - Constant-time comparison of the HMAC.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  webhookSecret: string,
  mode: PaymentsMode,
  now: Date = new Date(),
): SignatureVerification {
  if (!webhookSecret) return { ok: false, reason: "no_secret" };
  if (!signatureHeader) return { ok: false, reason: "malformed_header" };

  const parts: Record<string, string> = {};
  for (const seg of signatureHeader.split(",")) {
    const [k, v] = seg.split("=", 2);
    if (k && v) parts[k.trim()] = v.trim();
  }
  const ts = parts.t;
  const provided = mode === "live" ? parts.li : parts.te;
  if (!ts || !provided || !/^\d+$/.test(ts)) return { ok: false, reason: "malformed_header" };

  const skew = Math.abs(Math.floor(now.getTime() / 1000) - Number(ts));
  if (skew > MAX_SIGNATURE_SKEW_SECONDS) return { ok: false, reason: "timestamp_skew" };

  const expected = createHmac("sha256", webhookSecret).update(`${ts}.${rawBody}`).digest("hex");

  // timingSafeEqual needs equal-length buffers.
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return { ok: false, reason: "mismatch" };
  return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: "mismatch" };
}

export class PaymongoTimeoutError extends Error {
  constructor() {
    super("PayMongo API request timed out.");
    this.name = "PaymongoTimeoutError";
  }
}

// ---------------------------------------------------------------------------
// API client
//
// Phase 6B: `createCheckoutSession` is now LIVE-callable, but only ever reached
// via `src/lib/payments/checkout-session.ts`, which itself requires
// `getPaymentsConfig().sessionsEnabled`. `getCheckoutSession` / `createRefund`
// stay dormant (admin-gated reconciliation / Phase 6D).
// ---------------------------------------------------------------------------

const API_TIMEOUT_MS = 20_000;

function authHeader(): string {
  const key = (process.env.PAYMONGO_SECRET_KEY ?? "").trim();
  if (!key) throw new PaymongoNotConfiguredError();
  return `Basic ${Buffer.from(`${key}:`).toString("base64")}`;
}

async function request<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: authHeader(),
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${paymongoApiBase()}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify({ data: { attributes: body } }) : undefined,
      // Payments must never be served from a cache.
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new PaymongoTimeoutError();
    // Network error — do not surface the raw message (may echo the URL).
    throw new PaymongoApiError(0, "network error reaching PayMongo");
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }

  if (!res.ok) {
    const detail =
      (json as { errors?: { detail?: string }[] })?.errors?.[0]?.detail ?? `HTTP ${res.status}`;
    throw new PaymongoApiError(res.status, detail);
  }
  return json as T;
}

export type CheckoutSessionInput = {
  amount: number; // centavos — for our own post-check, never sent (PayMongo sums line_items)
  currency?: string;
  description: string;
  referenceNumber: string; // the order number
  lineItems: { name: string; quantity: number; amount: number; currency: string; description?: string }[];
  paymentMethodTypes: string[]; // e.g. ["card","gcash"]
  successUrl: string;
  cancelUrl: string;
  metadata?: Record<string, string>;
  /** PayMongo's own receipt email. Off by default — Axiaro sends its own. */
  sendEmailReceipt?: boolean;
  /** Billing email shown on the hosted page (pre-fills, not a correlation key). */
  billingEmail?: string;
};

/** Creates a hosted PayMongo Checkout Session (POST /checkout_sessions). Reached
 *  only through the `sessionsEnabled`-gated `beginOnlinePayment` (Phase 6B). */
export async function createCheckoutSession(
  input: CheckoutSessionInput,
  idempotencyKey: string,
): Promise<{ id: string; checkoutUrl: string }> {
  const attrs: Record<string, unknown> = {
    line_items: input.lineItems.map((li) => ({
      name: li.name,
      quantity: li.quantity,
      amount: li.amount,
      currency: li.currency,
      ...(li.description ? { description: li.description } : {}),
    })),
    payment_method_types: input.paymentMethodTypes,
    description: input.description,
    reference_number: input.referenceNumber,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    metadata: input.metadata ?? {},
    send_email_receipt: input.sendEmailReceipt ?? false,
  };
  if (input.billingEmail) attrs.billing = { email: input.billingEmail };

  const out = await request<{ data?: { id?: string; attributes?: { checkout_url?: string } } }>(
    "POST",
    "/checkout_sessions",
    attrs,
    idempotencyKey,
  );
  const id = out.data?.id;
  const checkoutUrl = out.data?.attributes?.checkout_url;
  if (!id || !checkoutUrl) {
    throw new PaymongoApiError(502, "PayMongo response missing checkout_url");
  }
  return { id, checkoutUrl };
}

/** DORMANT. Reads a Checkout Session for reconciliation. Phase 4-B. */
export async function getCheckoutSession(id: string): Promise<unknown> {
  return request("GET", `/checkout_sessions/${encodeURIComponent(id)}`);
}

/** DORMANT. Creates a provider-side refund. Phase 4-D. */
export async function createRefund(
  input: { amount: number; paymentId: string; reason?: string },
  idempotencyKey: string,
): Promise<{ id: string; status: string }> {
  const out = await request<{ data: { id: string; attributes: { status: string } } }>(
    "POST",
    "/refunds",
    { amount: input.amount, payment_id: input.paymentId, reason: input.reason ?? "others" },
    idempotencyKey,
  );
  return { id: out.data.id, status: out.data.attributes.status };
}
