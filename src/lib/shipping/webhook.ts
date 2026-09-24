import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getProviderByCode } from "@/lib/shipping/registry";
import { advanceSellerOrderStatusFromWebhook } from "@/lib/marketplace/seller-order-repository";
import { sendLalamoveShipmentExceptionOps } from "@/lib/email/notifications";

/**
 * Provider-agnostic shipping-webhook processing (Phase 9F-48, Lalamove first).
 *
 * The route (`/api/webhooks/shipping/[provider]`) is a thin wrapper: read the
 * raw body, hand it here with the `provider` path segment, translate the
 * result to a status code — same split as `processPaymongoWebhook`.
 *
 * Sequence, unchanged in shape from before this phase, now with two more
 * steps at the end: verify → parse → dedupe by `(provider, providerEventId)`
 * → if a matching `Shipment` row exists, record a `ShipmentEvent` and update
 * `Shipment.lastCarrierStatus` / `lastCarrierStatusAt` → NORMAL-STATUS CASCADE
 * (Phase 9F-48 step 4) → EXCEPTION OPS ALERT (Phase 9F-48 step 5). The normal
 * cascade only ever calls the EXISTING `SellerOrder`/`Shipment`/`Order`
 * transition authority (`advanceSellerOrderStatusFromWebhook`, which shares
 * its guarded core with the seller-facing `advanceSellerOrderStatus`) — this
 * module never writes a `SellerOrder.status`/`Shipment.status`/`Order.status`
 * column itself.
 *
 * CANCELED / REJECTED / EXPIRED (`normStatus === "EXCEPTION"`) never trigger a
 * cascade — no automatic `Shipment`/`SellerOrder`/`Order` status change is
 * ever made for them. Instead, one deduplicated, informational
 * `sendLalamoveShipmentExceptionOps()` alert is raised so a human operator can
 * decide whether to cancel, rebook, contact the seller, or otherwise
 * intervene. The alert is sent AFTER the record-and-cascade transaction
 * commits (same post-commit, best-effort discipline as the rollup audit in
 * `advanceSellerOrderStatus`/`advanceSellerOrderStatusFromWebhook`) — email
 * delivery never throws (`renderAndDispatch` catches everything), so it can
 * never turn a successfully-processed webhook into a 5xx.
 *
 * In practice this whole path is inert until a real `Shipment.provider =
 * "LALAMOVE"` row exists, which requires `shipping.integrationEnabled = true`
 * AND a real provider booking — neither has happened in Production/Preview.
 */

export type WebhookResult = { status: number; body: string };

const OK: WebhookResult = { status: 200, body: "ok" };

/**
 * `NormalizedEvent.normStatus` → the SellerOrder status this webhook cascade
 * attempts, or `null` for a status this phase deliberately does not cascade
 * (`PENDING`/`IN_TRANSIT` — no Axiaro state means "driver assigned/en route
 * to pickup" — and `EXCEPTION`, deferred to the ops-alerting task).
 *
 * `DELIVERED` attempts BOTH hops in order — `SHIPPED` first, then
 * `DELIVERED` — so a `COMPLETED` event arriving while the SellerOrder is
 * still `READY_TO_SHIP` (the carrier's own dispatch can race a slow webhook
 * delivery) still lands correctly: `canTransitionSellerOrder()` allows
 * `READY_TO_SHIP → SHIPPED → DELIVERED`, and a SellerOrder already at
 * `SHIPPED` or `DELIVERED` simply no-ops the redundant `SHIPPED` attempt
 * (`SELLER_ORDER_STATUS_TRANSITIONS["SHIPPED"]`/`["DELIVERED"]` don't list
 * `SHIPPED` as a valid target from either state). No custom out-of-order
 * logic is written here — this relies entirely on the existing guard.
 */
function cascadeTargetsFor(normStatus: string): ("SHIPPED" | "DELIVERED")[] {
  if (normStatus === "OUT_FOR_DELIVERY") return ["SHIPPED"];
  if (normStatus === "DELIVERED") return ["SHIPPED", "DELIVERED"];
  return [];
}

type Client = Prisma.TransactionClient | typeof prisma;

/**
 * `client` is a TEST-ONLY seam, same pattern as `deriveShipmentPackage`'s own
 * `tx` parameter: the route handler always omits it (defaulting to `prisma`,
 * exactly today's behaviour), so a test can pass an already-open transaction
 * and have every fixture it created earlier in that SAME transaction be
 * visible to this function's own reads — without any real commit. When
 * `client` is the global `prisma`, each event still gets its own fresh
 * `$transaction`, unchanged from before; when it's already a
 * `Prisma.TransactionClient` (nesting isn't possible in Prisma), the same
 * per-event body just runs directly against it instead.
 */
export async function processShippingWebhook(
  providerCode: string,
  rawBody: string,
  opts: { isHttps: boolean },
  client: Client = prisma,
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

    const shipment = await client.shipment.findFirst({
      where: { provider: providerCode.toUpperCase(), externalShipmentId: event.externalShipmentId },
      select: {
        id: true,
        status: true,
        sellerOrderId: true,
        sellerOrder: { select: { sellerId: true, order: { select: { id: true, orderNumber: true } } } },
      },
    });
    // No matching Axiaro Shipment — expected while the provider is dormant /
    // under test (no LALAMOVE Shipment rows exist yet). Not an error.
    if (!shipment) continue;

    const recordAndCascade = async (tx: Prisma.TransactionClient): Promise<{ exceptionAlert: boolean }> => {
      await tx.shipmentEvent.create({
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
      });
      await tx.shipment.update({
        where: { id: shipment.id },
        data: { lastCarrierStatus: event.rawStatus, lastCarrierStatusAt: event.occurredAt },
      });

      // CANCELED / REJECTED / EXPIRED — flag for an Ops alert (sent after
      // this transaction commits, never inside it) and take NO automatic
      // action. Independent of the terminal-safety check below: an exception
      // is informational, not a transition attempt, so it's still surfaced
      // even for an already-DELIVERED Shipment (an operator may still want
      // to know the carrier later reported something unusual about it).
      if (event.normStatus === "EXCEPTION") return { exceptionAlert: true };

      // Terminal safety: a Shipment already DELIVERED never attempts
      // another transition — the event above is still recorded either way.
      if (shipment.status === "DELIVERED") return { exceptionAlert: false };

      for (const to of cascadeTargetsFor(event.normStatus)) {
        await advanceSellerOrderStatusFromWebhook(tx, {
          sellerOrderId: shipment.sellerOrderId,
          sellerIdScope: shipment.sellerOrder.sellerId,
          to,
          provider: event.provider,
        });
        // A failed hop (SellerOrder not in the expected state — e.g.
        // already SHIPPED/DELIVERED, or CANCELLED, or a race with a
        // seller's own click) is a harmless no-op, never an error to
        // surface — `canTransitionSellerOrder` already rejected it, so
        // there is nothing to roll back and no reason to stop recording
        // this event. Continuing to the next hop (SHIPPED → DELIVERED) is
        // exactly the out-of-order-COMPLETED behaviour this phase requires.
      }
      return { exceptionAlert: false };
    };

    try {
      const result = "$transaction" in client ? await client.$transaction(recordAndCascade) : await recordAndCascade(client);

      if (result.exceptionAlert) {
        // Post-commit, best-effort — same discipline as the rollup audit.
        // `client === prisma` (production) lets the sender fall back to its
        // own default (a real send); a test-supplied transaction client is
        // threaded through so the EmailLog write lands in that SAME
        // transaction and rolls back with everything else, exactly like
        // `reconciliation-watchdog.ts`'s own `sendReconciliationStaleRunAlertOps` call.
        const emailClient = client === prisma ? undefined : (client as Prisma.TransactionClient);
        await sendLalamoveShipmentExceptionOps({
          provider: event.provider,
          rawStatus: event.rawStatus,
          orderId: shipment.sellerOrder.order.id,
          orderNumber: shipment.sellerOrder.order.orderNumber,
          sellerOrderId: shipment.sellerOrderId,
          shipmentId: shipment.id,
          externalShipmentId: event.externalShipmentId,
          providerEventId: event.providerEventId,
          occurredAt: event.occurredAt,
          client: emailClient,
        });
      }
    } catch (err) {
      // @@unique([provider, providerEventId]) — Lalamove retries a webhook up
      // to 10x within 24h; a duplicate delivery throws P2002 here. That IS
      // success (the event was already recorded once, cascade/alert already
      // attempted then) — never a duplicate row, never a second cascade or
      // a second alert (this catch fires BEFORE the exceptionAlert branch
      // above is ever reached for a duplicate).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
      console.error("[shipping/webhook] failed to record ShipmentEvent", err);
    }
  }

  return OK;
}
