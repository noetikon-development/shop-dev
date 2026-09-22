/**
 * Provider-agnostic shipping service layer (Phase 9F-47C).
 *
 * Pure types + the `ShippingProvider` contract. NO implementation, NO carrier
 * API, NO credentials. The only provider that exists today is
 * `ManualShippingProvider` (`./providers/manual`), which represents the existing
 * manual "enter the carrier + tracking number" workflow byte-for-byte.
 *
 * The interface deliberately mirrors the architecture chosen in the 9F-47A
 * audit (aggregator-first hybrid): `quote` / `getLabel` are optional because a
 * manual courier offers neither; `verifyWebhook` / `parseWebhook` exist so the
 * 9F-47E webhook route has a stable seam, but no provider implements real
 * webhook handling yet.
 *
 * `ShipmentResult` carries the full set of `Shipment` columns added in 9F-47B,
 * but the manual path persists only the five it always has (carrier /
 * carrierName / trackingNumber / trackingUrl / note) — the provider-integration
 * columns stay NULL until a real provider ships.
 */

/**
 * A postal address a real (non-manual) provider needs to book a pickup or
 * delivery. Same field shape as `SellerOriginAddress` / `SellerReturnAddress`
 * (`@/lib/marketplace/types`) so a caller can pass one through directly.
 * `lat`/`lng` are optional here because MANUAL never needs them, but a
 * provider that books a real courier (Lalamove) requires both — see its
 * `quote`/`createShipment` for the resulting validation error when absent.
 */
export type ShipmentAddress = {
  recipient: string;
  phone: string;
  line1: string;
  line2?: string | null;
  barangay?: string | null;
  city: string;
  province: string;
  postalCode: string;
  country: string;
  lat?: string;
  lng?: string;
};

/** Package data a real provider needs for a rate quote / capacity check. */
export type ShipmentPackage = {
  weightGrams?: number | null;
  lengthCm?: number | null;
  widthCm?: number | null;
  heightCm?: number | null;
  description?: string | null;
};

/** What the caller knows before a shipment exists — the seller's form input. */
export type ShipmentDraft = {
  sellerOrderId: string;
  carrier: string;
  carrierName?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  note?: string | null;
  /**
   * Real-provider fields (Phase 9F-48 — Lalamove). All optional: MANUAL
   * ignores them entirely (it only ever reads the 5 fields above via
   * `Pick<ShipmentDraft, ...>`), so adding these here cannot change MANUAL's
   * behaviour or any existing caller's payload shape.
   */
  direction?: "FORWARD" | "RETURN";
  origin?: ShipmentAddress;
  destination?: ShipmentAddress;
  package?: ShipmentPackage;
  /** Provider-specific service/vehicle hint (e.g. Lalamove's serviceType). */
  serviceType?: string;
};

/** Normalised, validated shipment fields ready to persist on `Shipment`. */
export type ShipmentResult = {
  carrier: string;
  carrierName: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  note: string | null;
  /** Provider identity for the row. `"MANUAL"` for the manual provider. */
  provider: string;
  externalShipmentId: string | null;
  externalOrderId: string | null;
  service: string | null;
  labelUrl: string | null;
  /** Integer minor units (₱ centavos). */
  shippingCostAmount: number | null;
  shippingCostCurrency: string | null;
  estimatedDeliveryAt: Date | null;
};

/** A rate option from `quote` (type only — no provider implements it yet). */
export type Quote = {
  provider: string;
  service: string;
  /** Integer minor units (₱ centavos). */
  amount: number;
  currency: string;
  estimatedDeliveryAt: Date | null;
};

export type NormalizedEventStatus =
  | "PENDING"
  | "IN_TRANSIT"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "EXCEPTION";

/** A carrier status callback, normalised (type only — 9F-47E implements it). */
export type NormalizedEvent = {
  provider: string;
  providerEventId: string;
  externalShipmentId: string | null;
  rawStatus: string;
  normStatus: NormalizedEventStatus;
  description: string | null;
  occurredAt: Date;
  payloadHash: string;
};

export type ProviderOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

export interface ShippingProvider {
  /** Stable identifier, stored on `Shipment.provider` (`"MANUAL"` today). */
  readonly code: string;

  /** Rate options for a draft. Optional — a manual courier has no rate API. */
  quote?(draft: ShipmentDraft): Promise<ProviderOutcome<Quote[]>>;

  /**
   * Validate + normalise a draft into a `ShipmentResult`. For the manual
   * provider this is pure validation (no I/O); a real provider books the
   * shipment with the carrier and fills the external id / label / cost.
   */
  createShipment(draft: ShipmentDraft): Promise<ProviderOutcome<ShipmentResult>>;

  /** Fetch / refresh a label. Optional — not every provider issues one. */
  getLabel?(externalShipmentId: string): Promise<ProviderOutcome<{ labelUrl: string }>>;

  /** Verify a carrier webhook signature. `false` for providers without webhooks. */
  verifyWebhook(rawBody: string, signatureHeader: string | null): boolean;

  /** Parse a verified webhook body into normalised events. `[]` when none. */
  parseWebhook(rawBody: string): NormalizedEvent[];
}
