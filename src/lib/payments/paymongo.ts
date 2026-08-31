import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { PaymentsMode } from "@/lib/payments/config";

/**
 * PayMongo API + webhook-signature primitives (Step 21 P4).
 *
 * Phase 4-A status:
 *  - `verifyWebhookSignature` is USED by the webhook route (it's a pure crypto
 *    check; if no secret is configured it fails closed).
 *  - `createCheckoutSession` / `createRefund` / `getCheckoutSession` are the
 *    Phase 4-B/4-D API calls. They are DORMANT — nothing in Phase 4-A imports or
 *    calls them, and each throws `PaymongoNotConfiguredError` unless
 *    PAYMONGO_SECRET_KEY is set.
 *
 * The secret key and webhook secret are read from server-only env vars and are
 * never logged, never returned, never placed in a NEXT_PUBLIC_ variable.
 */

const API_BASE = "https://api.paymongo.com/v1";
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

// ---------------------------------------------------------------------------
// API client  (DORMANT in Phase 4-A — not imported or called anywhere)
// ---------------------------------------------------------------------------

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

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify({ data: { attributes: body } }) : undefined,
    // Payments must never be served from a cache.
    cache: "no-store",
  });

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
  amount: number; // centavos
  currency?: string;
  description: string;
  referenceNumber: string; // the order number
  lineItems: { name: string; quantity: number; amount: number; currency: string }[];
  paymentMethodTypes: string[]; // e.g. ["card","gcash"]
  successUrl: string;
  cancelUrl: string;
  metadata?: Record<string, string>;
};

/** DORMANT. Creates a hosted PayMongo Checkout Session. Phase 4-B. */
export async function createCheckoutSession(
  input: CheckoutSessionInput,
  idempotencyKey: string,
): Promise<{ id: string; checkoutUrl: string }> {
  const attrs = {
    line_items: input.lineItems.map((li) => ({
      name: li.name,
      quantity: li.quantity,
      amount: li.amount,
      currency: li.currency,
    })),
    payment_method_types: input.paymentMethodTypes,
    description: input.description,
    reference_number: input.referenceNumber,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    metadata: input.metadata ?? {},
  };
  const out = await request<{ data: { id: string; attributes: { checkout_url: string } } }>(
    "POST",
    "/checkout_sessions",
    attrs,
    idempotencyKey,
  );
  return { id: out.data.id, checkoutUrl: out.data.attributes.checkout_url };
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
