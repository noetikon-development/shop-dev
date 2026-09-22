import "server-only";
import crypto from "node:crypto";
import type {
  NormalizedEvent,
  NormalizedEventStatus,
  ProviderOutcome,
  Quote,
  ShipmentAddress,
  ShipmentDraft,
  ShipmentPackage,
  ShipmentResult,
  ShippingProvider,
} from "@/lib/shipping/provider";

/**
 * Lalamove `ShippingProvider` (Phase 9F-48). Built and verified against
 * Lalamove's SANDBOX exclusively — see the sandbox due-diligence + webhook
 * due-diligence sessions this implementation is drawn from. NOT wired into
 * checkout, `saveSellerShipment`, or any live order flow — `registry.ts`
 * fails closed to MANUAL in Production because no `SHIPPING_LALAMOVE_*` env
 * var is set there. This file is safe to ship dormant.
 *
 * ── What's LIVE-SANDBOX-VERIFIED (this session, against real Lalamove PH
 *    sandbox responses) vs DOCUMENTED-ONLY (official docs/PDF, never
 *    exercised) is called out in comments throughout. ──
 *
 * Known, deliberate gaps carried over from the sandbox findings:
 *   - No label/waybill concept exists on Lalamove — `getLabel` is simply not
 *     implemented (mirrors how `ManualShippingProvider` omits it), matching
 *     the interface's existing "optional == unsupported" convention.
 *   - Lalamove's quotation API takes a WEIGHT BUCKET, never exact grams, and
 *     never accepts item dimensions — dimensions are read-only vehicle
 *     metadata on `GET /v3/cities`. `quote`/`createShipment` derive a bucket
 *     from `ShipmentPackage.weightGrams`.
 *   - Lalamove does NOT validate weight/dimensions against the selected
 *     vehicle's capacity (sandbox-proven: a MOTORCYCLE quote with a
 *     1000_TO_12000_KG item was accepted, HTTP 201). `validateCapacity()`
 *     below is Axiaro's own guard, run BEFORE any Lalamove API call.
 *   - Lalamove requires `lat`/`lng` coordinates on every stop. Axiaro has no
 *     geocoding pipeline today, so `origin.lat/lng` / `destination.lat/lng`
 *     must already be populated on the draft — this provider will not guess
 *     or geocode. Missing coordinates fail fast with a clear error, no call
 *     is made.
 */

// ---------------------------------------------------------------------------
// Config — fails closed to SANDBOX by default (never guesses "live")
// ---------------------------------------------------------------------------

type LalamoveMode = "sandbox" | "live";

function mode(): LalamoveMode {
  return process.env.SHIPPING_LALAMOVE_MODE === "live" ? "live" : "sandbox";
}

function baseUrl(): string {
  return mode() === "live" ? "https://rest.lalamove.com" : "https://rest.sandbox.lalamove.com";
}

const MARKET = "PH";

/**
 * The webhook route's own path — part of the signed string for both
 * outbound request signing (N/A here) and inbound webhook verification.
 * Must match the route created in `src/app/api/webhooks/shipping/[provider]/route.ts`.
 */
const WEBHOOK_PATH = "/api/webhooks/shipping/lalamove";

function credentials(): { key: string; secret: string } | null {
  const key = process.env.SHIPPING_LALAMOVE_API_KEY;
  const secret = process.env.SHIPPING_LALAMOVE_API_SECRET;
  if (!key || !secret) return null;
  return { key, secret };
}

// ---------------------------------------------------------------------------
// Request signing — LIVE-SANDBOX-VERIFIED
//   Authorization: hmac KEY:TIMESTAMP:SIGNATURE
//   SIGNATURE = hex(HMAC_SHA256(secret, `${timestamp}\r\n${method}\r\n${path}\r\n\r\n${body}`))
//   POST bodies are wrapped in { "data": {...} } (confirmed against the real
//   lalamove/api-examples SDK source, not paraphrased docs).
// ---------------------------------------------------------------------------

function sign(secret: string, method: string, path: string, rawBody: string, timestamp: string): string {
  const toSign = `${timestamp}\r\n${method}\r\n${path}\r\n\r\n${rawBody}`;
  return crypto.createHmac("sha256", secret).update(toSign).digest("hex");
}

type LalamoveApiError = { ok: false; error: string; httpStatus?: number };

/**
 * Low-level authenticated call. Never logs the key, secret, Authorization
 * header, or signature. Maps every failure mode (network, malformed JSON,
 * auth, 4xx, 5xx) to a plain `LalamoveApiError` — callers never see a thrown
 * exception from this function.
 */
async function callLalamove(
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
): Promise<{ ok: true; status: number; json: unknown } | LalamoveApiError> {
  const creds = credentials();
  if (!creds) return { ok: false, error: "Lalamove credentials are not configured." };

  const rawBody = body === undefined ? "" : JSON.stringify(body);
  const timestamp = Date.now().toString();
  const signature = sign(creds.secret, method, path, rawBody, timestamp);

  let res: Response;
  try {
    res = await fetch(baseUrl() + path, {
      method,
      headers: {
        Authorization: `hmac ${creds.key}:${timestamp}:${signature}`,
        Market: MARKET,
        "Request-ID": crypto.randomUUID(),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : rawBody,
    });
  } catch {
    // Network failure — never expose the underlying error (may carry request details).
    return { ok: false, error: "Could not reach Lalamove." };
  }

  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, error: "Lalamove returned a malformed response.", httpStatus: res.status };
    }
  }

  if (res.status === 401) return { ok: false, error: "Lalamove authentication failed.", httpStatus: 401 };
  if (!res.ok) {
    const detail =
      json && typeof json === "object" && "errors" in json && Array.isArray((json as { errors: unknown }).errors)
        ? ((json as { errors: { message?: string; detail?: string }[] }).errors[0]?.message ??
          (json as { errors: { message?: string; detail?: string }[] }).errors[0]?.detail)
        : undefined;
    return { ok: false, error: detail ?? `Lalamove request failed (HTTP ${res.status}).`, httpStatus: res.status };
  }

  return { ok: true, status: res.status, json };
}

// ---------------------------------------------------------------------------
// Weight bucket + capacity validation — Axiaro's OWN guard.
// LIVE-SANDBOX-VERIFIED table, captured from a real GET /v3/cities PH response
// (2026-09-22). Lalamove does not expose a "GET one city" lookup distinct
// from this, and does not validate capacity itself — this table is the only
// protection Axiaro has against booking an undersized vehicle.
// ---------------------------------------------------------------------------

export const LALAMOVE_WEIGHT_BUCKETS = [
  "LESS_THAN_20_KG",
  "20_TO_200_KG",
  "200_TO_400_KG",
  "400_TO_600_KG",
  "600_TO_1000_KG",
  "1000_TO_12000_KG",
] as const;
export type LalamoveWeightBucket = (typeof LALAMOVE_WEIGHT_BUCKETS)[number];

export function weightBucketFor(weightGrams: number): LalamoveWeightBucket {
  const kg = weightGrams / 1000;
  if (kg < 20) return "LESS_THAN_20_KG";
  if (kg < 200) return "20_TO_200_KG";
  if (kg < 400) return "200_TO_400_KG";
  if (kg < 600) return "400_TO_600_KG";
  if (kg < 1000) return "600_TO_1000_KG";
  return "1000_TO_12000_KG";
}

/** Max load (kg) and cargo-bay dimensions (cm) per PH service type, as returned by sandbox `GET /v3/cities`. */
export const LALAMOVE_PH_VEHICLE_CAPACITY: Record<string, { loadKg: number; lengthCm: number; widthCm: number; heightCm: number }> = {
  MOTORCYCLE: { loadKg: 20, lengthCm: 50, widthCm: 40, heightCm: 50 },
  SEDAN: { loadKg: 200, lengthCm: 100, widthCm: 60, heightCm: 70 },
  SEDAN_INTERCITY: { loadKg: 200, lengthCm: 100, widthCm: 60, heightCm: 70 },
  MPV: { loadKg: 300, lengthCm: 120, widthCm: 100, heightCm: 90 },
  MPV_INTERCITY: { loadKg: 300, lengthCm: 210, widthCm: 120, heightCm: 110 },
  "600KG_MPV": { loadKg: 600, lengthCm: 210, widthCm: 120, heightCm: 110 },
  "600KG_MPV_LD": { loadKg: 600, lengthCm: 210, widthCm: 120, heightCm: 110 },
  VAN: { loadKg: 600, lengthCm: 210, widthCm: 120, heightCm: 110 },
  VAN_INTERCITY: { loadKg: 600, lengthCm: 210, widthCm: 120, heightCm: 110 },
  TRUCK330: { loadKg: 1000, lengthCm: 210, widthCm: 120, heightCm: 120 },
  VAN1000: { loadKg: 1000, lengthCm: 210, widthCm: 120, heightCm: 120 },
  "2000KG_ALUMINUM": { loadKg: 2000, lengthCm: 270, widthCm: 170, heightCm: 170 },
  "2000KG_ALUMINUM_LD": { loadKg: 2000, lengthCm: 270, widthCm: 170, heightCm: 170 },
  "2000KG_FB": { loadKg: 2000, lengthCm: 270, widthCm: 170, heightCm: 170 },
  "2000KG_FB_LD": { loadKg: 2000, lengthCm: 270, widthCm: 170, heightCm: 170 },
  TRUCK550: { loadKg: 2000, lengthCm: 270, widthCm: 170, heightCm: 170 },
  "2000KG_OPENTRUCK": { loadKg: 2000, lengthCm: 450, widthCm: 180, heightCm: 200 },
  "2000KG_OPENTRUCK_LD": { loadKg: 2000, lengthCm: 450, widthCm: 180, heightCm: 200 },
  "3000KG_TRUCK": { loadKg: 3000, lengthCm: 430, widthCm: 180, heightCm: 210 },
  "7000KG_TRUCK": { loadKg: 7000, lengthCm: 640, widthCm: 200, heightCm: 230 },
  "10WHEEL_TRUCK": { loadKg: 12000, lengthCm: 1000, widthCm: 240, heightCm: 230 },
  LD_10WHEEL_TRUCK: { loadKg: 12000, lengthCm: 1000, widthCm: 240, heightCm: 230 },
};

/**
 * Axiaro's own capacity guard — Lalamove will NOT reject an oversized item
 * for a given serviceType (sandbox-proven). Called before every quote/order.
 */
export function validateCapacity(
  serviceType: string,
  pkg: ShipmentPackage | undefined,
): { ok: true } | { ok: false; error: string } {
  const cap = LALAMOVE_PH_VEHICLE_CAPACITY[serviceType];
  if (!cap) return { ok: false, error: `Unknown Lalamove service type "${serviceType}".` };
  if (!pkg) return { ok: true }; // nothing to validate against — caller's responsibility to supply package data
  if (pkg.weightGrams != null && pkg.weightGrams / 1000 > cap.loadKg) {
    return { ok: false, error: `Package weight exceeds ${serviceType}'s ${cap.loadKg}kg capacity.` };
  }
  if (pkg.lengthCm != null && pkg.lengthCm > cap.lengthCm) {
    return { ok: false, error: `Package length exceeds ${serviceType}'s ${cap.lengthCm}cm cargo bay.` };
  }
  if (pkg.widthCm != null && pkg.widthCm > cap.widthCm) {
    return { ok: false, error: `Package width exceeds ${serviceType}'s ${cap.widthCm}cm cargo bay.` };
  }
  if (pkg.heightCm != null && pkg.heightCm > cap.heightCm) {
    return { ok: false, error: `Package height exceeds ${serviceType}'s ${cap.heightCm}cm cargo bay.` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Quotation — LIVE-SANDBOX-VERIFIED (POST /v3/quotations)
// ---------------------------------------------------------------------------

type Stop = { coordinates: { lat: string; lng: string }; address: string };

function toStop(a: ShipmentAddress): { ok: true; stop: Stop } | { ok: false; error: string } {
  if (!a.lat || !a.lng) {
    return { ok: false, error: "Lalamove requires a geocoded lat/lng for every stop; none was supplied." };
  }
  const line = [
    a.recipient,
    a.line1,
    a.line2,
    [a.barangay, a.city].filter(Boolean).join(", "),
    [a.province, a.postalCode].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(", ");
  return { ok: true, stop: { coordinates: { lat: a.lat, lng: a.lng }, address: line } };
}

type QuotationData = {
  quotationId: string;
  expiresAt: string;
  serviceType: string;
  stops: { stopId: string; coordinates: { lat: string; lng: string }; address: string }[];
  priceBreakdown: { total: string; currency: string };
};

async function requestQuotation(
  draft: ShipmentDraft,
): Promise<{ ok: true; data: QuotationData } | { ok: false; error: string }> {
  const serviceType = draft.serviceType;
  if (!serviceType) return { ok: false, error: "A Lalamove service type (vehicle) is required." };
  if (!draft.origin) return { ok: false, error: "An origin address is required." };
  if (!draft.destination) return { ok: false, error: "A destination address is required." };

  const capacity = validateCapacity(serviceType, draft.package);
  if (!capacity.ok) return { ok: false, error: capacity.error };

  const originStop = toStop(draft.origin);
  if (!originStop.ok) return { ok: false, error: `Origin: ${originStop.error}` };
  const destStop = toStop(draft.destination);
  if (!destStop.ok) return { ok: false, error: `Destination: ${destStop.error}` };

  const weightBucket = draft.package?.weightGrams != null ? weightBucketFor(draft.package.weightGrams) : "LESS_THAN_20_KG";

  const body = {
    serviceType,
    specialRequests: [] as string[],
    language: "en_PH",
    stops: [originStop.stop, destStop.stop],
    item: {
      quantity: "1",
      weight: weightBucket,
      categories: ["APPLIANCES_OR_FURNITURE"],
      handlingInstructions: ["NO_SPECIAL_HANDLING"],
    },
  };

  const res = await callLalamove("POST", "/v3/quotations", { data: body });
  if (!res.ok) return { ok: false, error: res.error };
  const data = (res.json as { data?: QuotationData })?.data;
  if (!data?.quotationId) return { ok: false, error: "Lalamove did not return a quotation ID." };
  return { ok: true, data };
}

// ---------------------------------------------------------------------------
// ShippingProvider implementation
// ---------------------------------------------------------------------------

class LalamoveShippingProvider implements ShippingProvider {
  readonly code = "LALAMOVE";

  async quote(draft: ShipmentDraft): Promise<ProviderOutcome<Quote[]>> {
    const q = await requestQuotation(draft);
    if (!q.ok) return { ok: false, error: q.error };
    return {
      ok: true,
      value: [
        {
          provider: this.code,
          service: q.data.serviceType,
          amount: Math.round(Number(q.data.priceBreakdown.total) * 100),
          currency: q.data.priceBreakdown.currency,
          // Lalamove is on-demand courier dispatch, not a scheduled network —
          // there is no ETA field on a quotation. NOT SUPPORTED, not unknown.
          estimatedDeliveryAt: null,
        },
      ],
    };
  }

  /**
   * `ShipmentDraft` carries no `quotationId` (the interface has none), so
   * this internally quotes-then-books in one call — LIVE-SANDBOX-VERIFIED
   * end to end (quotation → order, same flow proven in the sandbox spike).
   */
  async createShipment(draft: ShipmentDraft): Promise<ProviderOutcome<ShipmentResult>> {
    if (!draft.origin) return { ok: false, error: "An origin address is required." };
    if (!draft.destination) return { ok: false, error: "A destination address is required." };

    const q = await requestQuotation(draft);
    if (!q.ok) return { ok: false, error: q.error };

    const senderStop = q.data.stops[0];
    const recipientStop = q.data.stops[1];
    if (!senderStop || !recipientStop) return { ok: false, error: "Lalamove quotation is missing stop IDs." };

    // Minimal known-good shape — the sandbox spike's ONE unexplained HTTP 500
    // came from a richer payload (isPODEnabled + metadata); this deliberately
    // omits both until proven necessary.
    const orderBody = {
      quotationId: q.data.quotationId,
      sender: { stopId: senderStop.stopId, name: draft.origin.recipient, phone: draft.origin.phone },
      recipients: [
        {
          stopId: recipientStop.stopId,
          name: draft.destination.recipient,
          phone: draft.destination.phone,
          ...(draft.note ? { remarks: draft.note } : {}),
        },
      ],
    };

    const res = await callLalamove("POST", "/v3/orders", { data: orderBody });
    if (!res.ok) return { ok: false, error: res.error };
    const order = (res.json as { data?: { orderId?: string; shareLink?: string; status?: string; priceBreakdown?: { total?: string; currency?: string } } })?.data;
    if (!order?.orderId) return { ok: false, error: "Lalamove did not return an order ID." };

    return {
      ok: true,
      value: {
        carrier: "LALAMOVE",
        carrierName: "Lalamove",
        trackingNumber: order.orderId,
        // Lalamove has no waybill/label — the share link IS the tracking surface.
        trackingUrl: order.shareLink ?? null,
        note: draft.note ?? null,
        provider: this.code,
        externalShipmentId: order.orderId,
        externalOrderId: order.orderId,
        service: draft.serviceType ?? null,
        // Intentional: Lalamove has no label/waybill concept (sandbox-proven —
        // no such field exists anywhere in its quotation or order response).
        labelUrl: null,
        shippingCostAmount: order.priceBreakdown?.total != null ? Math.round(Number(order.priceBreakdown.total) * 100) : null,
        shippingCostCurrency: order.priceBreakdown?.currency ?? null,
        // On-demand dispatch has no scheduled ETA.
        estimatedDeliveryAt: null,
      },
    };
  }

  // getLabel intentionally NOT implemented — Lalamove has no label/waybill.
  // Omitting it (rather than returning an error) matches the interface's own
  // convention: `getLabel?` is optional and ManualShippingProvider omits it
  // too. A caller must feature-detect with `provider.getLabel?.(...)`.

  // -------------------------------------------------------------------------
  // Webhook — LIVE-SANDBOX-VERIFIED signature formula; DOCUMENTED-ONLY retry
  // behaviour (official PDF, not forced live per instruction).
  //
  // Lalamove's signature travels IN THE JSON BODY (field "signature"), never
  // as an HTTP header — `signatureHeader` is therefore unused here; it exists
  // only because the shared `ShippingProvider` interface has that parameter
  // for providers that DO use a header. `WEBHOOK_PATH` supplies the "path"
  // component of the signing input, since the interface has no path
  // parameter and this route's path is fixed and known to the provider.
  // -------------------------------------------------------------------------

  verifyWebhook(rawBody: string, _signatureHeader: string | null): boolean {
    void _signatureHeader;
    const creds = credentials();
    if (!creds) return false; // fails closed — no secret configured (Preview default)

    let parsed: { apiKey?: string; timestamp?: number; signature?: string; data?: unknown };
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return false;
    }
    if (parsed.apiKey !== creds.key) return false;
    if (typeof parsed.timestamp !== "number" || typeof parsed.signature !== "string" || parsed.data === undefined) {
      return false;
    }

    const expected = sign(creds.secret, "POST", WEBHOOK_PATH, JSON.stringify(parsed.data), String(parsed.timestamp));
    const receivedBuf = Buffer.from(parsed.signature, "utf8");
    const expectedBuf = Buffer.from(expected, "utf8");
    if (receivedBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(receivedBuf, expectedBuf);
  }

  parseWebhook(rawBody: string): NormalizedEvent[] {
    let parsed: {
      eventId?: string;
      eventType?: string;
      timestamp?: number;
      data?: { order?: { orderId?: string; status?: string }; updatedAt?: string };
    };
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return [];
    }
    if (!parsed.eventId || !parsed.eventType) return [];

    // WALLET_BALANCE_CHANGED (and other account-level events) carry no
    // shipment/order — LIVE-SANDBOX-VERIFIED: no `data.order` on that event.
    // Nothing to normalise; returning [] is correct, not a bug.
    const order = parsed.data?.order;
    const rawStatus = order?.status ?? parsed.eventType;
    const occurredAt = parsed.data?.updatedAt ? new Date(parsed.data.updatedAt) : new Date();

    const payloadHash = crypto.createHash("sha256").update(rawBody).digest("hex");

    if (parsed.eventType === "ORDER_CREATED" || parsed.eventType === "ORDER_STATUS_CHANGED") {
      return [
        {
          provider: this.code,
          providerEventId: parsed.eventId,
          externalShipmentId: order?.orderId ?? null,
          rawStatus,
          normStatus: normalizeStatus(order?.status),
          description: null,
          occurredAt,
          payloadHash,
        },
      ];
    }

    // DRIVER_ASSIGNED / ORDER_AMOUNT_CHANGED / ORDER_EDITED / ORDER_REPLACED /
    // POD_STATUS_CHANGED / POP_STATUS_CHANGED / DELIVERY_CODE_STATUS_CHANGED —
    // DOCUMENTED-ONLY, never captured live this session. Treated as an
    // informational event tied to the order (when present) with PENDING as a
    // conservative default rather than guessing a status change.
    if (order?.orderId) {
      return [
        {
          provider: this.code,
          providerEventId: parsed.eventId,
          externalShipmentId: order.orderId,
          rawStatus: parsed.eventType,
          normStatus: "PENDING",
          description: `Lalamove event ${parsed.eventType} (not yet mapped to a specific status)`,
          occurredAt,
          payloadHash,
        },
      ];
    }

    return [];
  }
}

/**
 * ORDER_STATUS_CHANGED status mapping. Only `ASSIGNING_DRIVER` is
 * LIVE-SANDBOX-VERIFIED (the sandbox never progresses past it — no real
 * driver exists to advance the order). The other 6 are DOCUMENTED-ONLY, taken
 * from Lalamove's own confidential webhook tutorial (v3_Webhook_v1.5.pdf).
 */
function normalizeStatus(raw: string | undefined): NormalizedEventStatus {
  switch (raw) {
    case "ASSIGNING_DRIVER": // LIVE-SANDBOX-VERIFIED
      return "PENDING";
    case "ON_GOING": // DOCUMENTED-ONLY — driver en route to pickup
      return "IN_TRANSIT";
    case "PICKED_UP": // DOCUMENTED-ONLY — goods collected, heading to recipient
      return "OUT_FOR_DELIVERY";
    case "COMPLETED": // DOCUMENTED-ONLY
      return "DELIVERED";
    case "CANCELED": // DOCUMENTED-ONLY
    case "REJECTED": // DOCUMENTED-ONLY
    case "EXPIRED": // DOCUMENTED-ONLY
      return "EXCEPTION";
    default:
      return "PENDING";
  }
}

export const lalamoveShippingProvider: ShippingProvider = new LalamoveShippingProvider();
