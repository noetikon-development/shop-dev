/**
 * ManualShippingProvider (Phase 9F-47C).
 *
 * Represents the existing manual shipment workflow: the seller types the carrier
 * and (where required) the tracking number, and Axiaro stores it. NO external
 * API, NO credentials, NO webhooks.
 *
 * `resolveManualShipment` is the validation/normalisation helper LIFTED VERBATIM
 * from `seller-order-repository.ts` (it moved here so the repository can depend
 * on the shipping layer without a cycle). Its behaviour — every check, every
 * error string, the `OTHER` handling, the auto-built tracking URL — is
 * unchanged. `seller-order-repository.ts` now reaches it through the provider
 * registry instead of calling it directly.
 */
import {
  getCourier,
  isCourierCode,
  isSafeTrackingUrl,
  buildTrackingUrl,
} from "@/lib/orders/couriers";
import type {
  NormalizedEvent,
  ProviderOutcome,
  ShipmentDraft,
  ShipmentResult,
  ShippingProvider,
} from "@/lib/shipping/provider";

export type ManualShipmentFields = {
  carrier: string;
  carrierName: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  note: string | null;
};

/**
 * Validate + normalise a manual shipment draft. Pure — no I/O. Identical logic
 * to the pre-9F-47C `resolveShipment` in `seller-order-repository.ts`.
 */
export function resolveManualShipment(
  input: Pick<ShipmentDraft, "carrier" | "carrierName" | "trackingNumber" | "trackingUrl" | "note">,
): { ok: true; data: ManualShipmentFields } | { ok: false; error: string } {
  const carrier = input.carrier?.trim();
  if (!carrier || !isCourierCode(carrier)) return { ok: false, error: "Choose a valid carrier." };
  const def = getCourier(carrier);

  const trackingNumber = input.trackingNumber?.trim() || null;
  if (trackingNumber && !/^[A-Za-z0-9_-]{1,40}$/.test(trackingNumber)) {
    return { ok: false, error: "Tracking number: up to 40 letters, numbers, hyphens or underscores." };
  }
  if (def?.requiresTracking && !trackingNumber) {
    return { ok: false, error: `${def.name} needs a tracking number.` };
  }

  let carrierName = input.carrierName?.trim() || null;
  if (carrier === "OTHER" && !carrierName) return { ok: false, error: "Enter the courier name." };
  if (!carrierName && carrier !== "OTHER") carrierName = def?.name ?? null;

  let trackingUrl = input.trackingUrl?.trim() || null;
  if (trackingUrl && !isSafeTrackingUrl(trackingUrl)) {
    return { ok: false, error: "Tracking link must be a valid https:// URL." };
  }
  if (!trackingUrl && trackingNumber) trackingUrl = buildTrackingUrl(carrier, trackingNumber);

  const note = input.note?.trim() || null;
  if (note && note.length > 300) return { ok: false, error: "Note is too long (max 300)." };

  return { ok: true, data: { carrier, carrierName, trackingNumber, trackingUrl, note } };
}

class ManualShippingProvider implements ShippingProvider {
  readonly code = "MANUAL";

  async createShipment(draft: ShipmentDraft): Promise<ProviderOutcome<ShipmentResult>> {
    const resolved = resolveManualShipment(draft);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    return {
      ok: true,
      value: {
        ...resolved.data,
        provider: this.code,
        externalShipmentId: null,
        externalOrderId: null,
        service: null,
        labelUrl: null,
        shippingCostAmount: null,
        shippingCostCurrency: null,
        estimatedDeliveryAt: null,
      },
    };
  }

  // A manually-entered shipment has no carrier callbacks.
  verifyWebhook(): boolean {
    return false;
  }

  parseWebhook(): NormalizedEvent[] {
    return [];
  }
}

export const manualShippingProvider: ShippingProvider = new ManualShippingProvider();
