import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getProviderByCode } from "@/lib/shipping/registry";

/**
 * Provider-agnostic shipping-webhook processing (Phase 9F-48, Lalamove first).
 *
 * The route (`/api/webhooks/shipping/[provider]`) is a thin wrapper: read the
 * raw body, hand it here with the `provider` path segment, translate the
 * result to a status code — same split as `processPaymongoWebhook`.
 *
 * Scope, deliberately conservative for this first provider (per the 9F-48
 * task): verify → parse → dedupe by `(provider, providerEventId)` → if a
 * matching `Shipment` row exists, record a `ShipmentEvent` and update only
 * `Shipment.lastCarrierStatus` / `lastCarrierStatusAt` (explicitly
 * audit/debugging fields per the schema comment). This does NOT touch
 * `Shipment.status`, `SellerOrder`, or `Order` — that cascade is a later,
 * separate task. In practice this whole path is inert until a real
 * `Shipment.provider = "LALAMOVE"` row exists, which requires
 * `shipping.integrationEnabled = true` AND `saveSellerShipment` to be wired
 * to pass the new draft fields through — neither has happened yet.
 */

export type WebhookResult = { status: number; body: string };

const OK: WebhookResult = { status: 200, body: "ok" };

export async function processShippingWebhook(
  providerCode: string,
  rawBody: string,
  opts: { isHttps: boolean },
): Promise<WebhookResult> {
  if (!opts.isHttps) return { status: 400, body: "https required" };

  const provider = getProviderByCode(providerCode);
  if (!provider) return { status: 404, body: "unknown provider" };

  if (!provider.verifyWebhook(rawBody, null)) {
    return { status: 401, body: "invalid signature" };
  }

  const events = provider.parseWebhook(rawBody);
  // Some event types carry no shipment reference (e.g. Lalamove's
  // WALLET_BALANCE_CHANGED) — `parseWebhook` correctly returns `[]` for
  // those. Nothing to record; still acknowledge with 200.
  if (events.length === 0) return OK;

  for (const event of events) {
    if (!event.externalShipmentId) continue;

    const shipment = await prisma.shipment.findFirst({
      where: { provider: providerCode.toUpperCase(), externalShipmentId: event.externalShipmentId },
      select: { id: true },
    });
    // No matching Axiaro Shipment — expected while the provider is dormant /
    // under test (no LALAMOVE Shipment rows exist yet). Not an error.
    if (!shipment) continue;

    try {
      await prisma.$transaction([
        prisma.shipmentEvent.create({
          data: {
            shipmentId: shipment.id,
            provider: event.provider,
            providerEventId: event.providerEventId,
            rawStatus: event.rawStatus,
            normStatus: event.normStatus,
            description: event.description,
            occurredAt: event.occurredAt,
            payloadHash: event.payloadHash,
            status: "RECEIVED",
          },
        }),
        prisma.shipment.update({
          where: { id: shipment.id },
          data: { lastCarrierStatus: event.rawStatus, lastCarrierStatusAt: event.occurredAt },
        }),
      ]);
    } catch (err) {
      // @@unique([provider, providerEventId]) — Lalamove retries a webhook up
      // to 10x within 24h; a duplicate delivery throws P2002 here. That IS
      // success (the event was already recorded once) — never a duplicate row.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
      console.error("[shipping/webhook] failed to record ShipmentEvent", err);
    }
  }

  return OK;
}
