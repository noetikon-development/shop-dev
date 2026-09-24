/**
 * Lalamove webhook → SellerOrder/Shipment/Order status cascade (Phase 9F-48
 * step 4). Exercises the REAL `processShippingWebhook()` through its FULL
 * real path — real `lalamoveShippingProvider.verifyWebhook()`/`parseWebhook()`
 * against locally self-signed envelopes (synthetic, never-sent-anywhere
 * `SHIPPING_LALAMOVE_API_KEY`/`_SECRET` values set for THIS PROCESS ONLY) —
 * and the REAL `advanceSellerOrderStatusFromWebhook()` transition authority.
 * NO real Lalamove API call anywhere in this file: signing/verification is
 * pure local HMAC, never a network request.
 *
 * Everything runs inside ONE `prisma.$transaction` that always ends by
 * throwing `Rollback`; `processShippingWebhook()` is called with that SAME
 * `tx` as its new test-only `client` parameter, so its own reads/writes land
 * in this transaction and never persist.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-lalamove-webhook-cascade.ts
 */
import { PrismaClient, Prisma } from "@prisma/client";
import crypto from "node:crypto";
import { processShippingWebhook } from "@/lib/shipping/webhook";

process.env.SHIPPING_LALAMOVE_API_KEY = "test_key_never_sent";
process.env.SHIPPING_LALAMOVE_API_SECRET = "test_secret_never_sent";
process.env.SHIPPING_LALAMOVE_MODE = "sandbox";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
class Rollback extends Error {}
type Tx = Prisma.TransactionClient;

const WEBHOOK_PATH = "/api/webhooks/shipping/lalamove";

/** Self-signs a Lalamove ORDER_STATUS_CHANGED envelope — pure local HMAC, no network call. */
function mkEnvelope(orderId: string, rawStatus: string, eventId = crypto.randomUUID()): { envelope: string; eventId: string } {
  const data = { order: { orderId, status: rawStatus }, updatedAt: new Date().toISOString() };
  const timestamp = Date.now();
  const toSign = `${timestamp}\r\nPOST\r\n${WEBHOOK_PATH}\r\n\r\n${JSON.stringify(data)}`;
  const signature = crypto.createHmac("sha256", process.env.SHIPPING_LALAMOVE_API_SECRET!).update(toSign).digest("hex");
  const envelope = JSON.stringify({
    apiKey: process.env.SHIPPING_LALAMOVE_API_KEY, timestamp, signature,
    eventId, eventType: "ORDER_STATUS_CHANGED", eventVersion: "v3", data,
  });
  return { envelope, eventId };
}

const mkSeller = async (tx: Tx, tag: string, sfx: string) =>
  tx.seller.create({
    data: { type: "THIRD_PARTY", status: "APPROVED", displayName: `Webhook ${tag} ${sfx}`, slug: `webhook-${tag}-${sfx}`, supportEmail: "s@t.test", contentStatus: "APPROVED" },
    select: { id: true },
  });

/** One Order with N SellerOrders, each with its own LALAMOVE Shipment. Returns { orderId, sellerOrders: [{soId, shipmentId, externalShipmentId}] }. */
async function mkOrderWithSellerOrders(
  tx: Tx,
  sfx: string,
  buyerId: string | undefined,
  parentOrderStatus: string,
  rows: { sellerId: string; soStatus: string; shipmentStatus: string }[],
) {
  const order = await tx.order.create({
    data: { orderNumber: `AX-WH-${sfx}-${Math.random().toString(36).slice(2, 6)}`, email: "b@e.test", phone: "+630", status: parentOrderStatus, paymentMethod: "COD", paymentStatus: "PENDING", subtotal: 1000, grandTotal: 1000, shippingFee: 0, shippingAddress: "{}", userId: buyerId },
    select: { id: true },
  });
  const sellerOrders = [];
  for (const r of rows) {
    const so = await tx.sellerOrder.create({
      data: { orderId: order.id, sellerId: r.sellerId, sellerName: "S", sellerType: "THIRD_PARTY", supportEmail: "s@t.test", merchandiseSubtotal: 1000, total: 1000, commissionRate: 1500, commissionAmount: 150, status: r.soStatus },
      select: { id: true },
    });
    const externalShipmentId = `LM-${sfx}-${Math.random().toString(36).slice(2, 8)}`;
    const shipment = await tx.shipment.create({
      data: { sellerOrderId: so.id, provider: "LALAMOVE", externalShipmentId, carrier: "LALAMOVE", carrierName: "Lalamove", trackingNumber: externalShipmentId, status: r.shipmentStatus },
      select: { id: true },
    });
    sellerOrders.push({ soId: so.id, shipmentId: shipment.id, externalShipmentId });
  }
  return { orderId: order.id, sellerOrders };
}

async function main() {
  console.log("\nLalamove webhook status cascade — verify/parse/dedupe/record/cascade\n");

  const before = {
    sellers: await prisma.seller.count(),
    orders: await prisma.order.count(),
    sellerOrders: await prisma.sellerOrder.count(),
    shipments: await prisma.shipment.count(),
    shipmentEvents: await prisma.shipmentEvent.count(),
    auditLogs: await prisma.adminAuditLog.count(),
  };

  try {
    await prisma.$transaction(async (tx: Tx) => {
      const sfx = Math.random().toString(36).slice(2, 8);
      const buyer = await tx.user.findFirst({ select: { id: true } });
      const mk = (status: string, rows: { sellerId: string; soStatus: string; shipmentStatus: string }[]) =>
        mkOrderWithSellerOrders(tx, sfx, buyer?.id, status, rows);

      const sellerX = await mkSeller(tx, "x", sfx);

      // ── A. ASSIGNING_DRIVER — event recorded, lastCarrierStatus updated, nothing else moves ──
      {
        const { sellerOrders } = await mk("PROCESSING", [{ sellerId: sellerX.id, soStatus: "READY_TO_SHIP", shipmentStatus: "PENDING" }]);
        const so = sellerOrders[0];
        const { envelope } = mkEnvelope(so.externalShipmentId, "ASSIGNING_DRIVER");
        const res = await processShippingWebhook("lalamove", envelope, { isHttps: true }, tx);
        ok("A · webhook returns 200", res.status === 200);
        const ev = await tx.shipmentEvent.findFirst({ where: { shipmentId: so.shipmentId }, select: { rawStatus: true, normStatus: true } });
        ok("A · ShipmentEvent recorded with rawStatus ASSIGNING_DRIVER, normStatus PENDING", ev?.rawStatus === "ASSIGNING_DRIVER" && ev?.normStatus === "PENDING");
        const ship = await tx.shipment.findUniqueOrThrow({ where: { id: so.shipmentId }, select: { lastCarrierStatus: true, status: true } });
        ok("A · Shipment.lastCarrierStatus updated, Shipment.status still PENDING (not stamped)", ship.lastCarrierStatus === "ASSIGNING_DRIVER" && ship.status === "PENDING");
        const soRow = await tx.sellerOrder.findUniqueOrThrow({ where: { id: so.soId }, select: { status: true } });
        ok("A · SellerOrder unchanged (still READY_TO_SHIP)", soRow.status === "READY_TO_SHIP");
        const orderRow = await tx.order.findFirst({ where: { sellerOrders: { some: { id: so.soId } } }, select: { status: true } });
        ok("A · parent Order unchanged (still PROCESSING)", orderRow?.status === "PROCESSING");
      }

      // ── B. ON_GOING — same shape as A ────────────────────────────────────
      {
        const { sellerOrders } = await mk("PROCESSING", [{ sellerId: sellerX.id, soStatus: "READY_TO_SHIP", shipmentStatus: "PENDING" }]);
        const so = sellerOrders[0];
        const { envelope } = mkEnvelope(so.externalShipmentId, "ON_GOING");
        await processShippingWebhook("lalamove", envelope, { isHttps: true }, tx);
        const ev = await tx.shipmentEvent.findFirst({ where: { shipmentId: so.shipmentId }, select: { rawStatus: true, normStatus: true } });
        ok("B · ShipmentEvent recorded with rawStatus ON_GOING, normStatus IN_TRANSIT", ev?.rawStatus === "ON_GOING" && ev?.normStatus === "IN_TRANSIT");
        const soRow = await tx.sellerOrder.findUniqueOrThrow({ where: { id: so.soId }, select: { status: true } });
        ok("B · SellerOrder unchanged", soRow.status === "READY_TO_SHIP");
      }

      // ── C/D. PICKED_UP then COMPLETED — READY_TO_SHIP → SHIPPED → DELIVERED, in sequence, with parent rollup each time ──
      {
        const { orderId, sellerOrders } = await mk("PROCESSING", [{ sellerId: sellerX.id, soStatus: "READY_TO_SHIP", shipmentStatus: "PENDING" }]);
        const so = sellerOrders[0];

        const { envelope: picked } = mkEnvelope(so.externalShipmentId, "PICKED_UP");
        const r1 = await processShippingWebhook("lalamove", picked, { isHttps: true }, tx);
        ok("C · webhook returns 200", r1.status === 200);
        const soAfterPick = await tx.sellerOrder.findUniqueOrThrow({ where: { id: so.soId }, select: { status: true } });
        ok("C · PICKED_UP → SellerOrder READY_TO_SHIP → SHIPPED", soAfterPick.status === "SHIPPED");
        const shipAfterPick = await tx.shipment.findUniqueOrThrow({ where: { id: so.shipmentId }, select: { status: true, shippedAt: true } });
        ok("C · Shipment.status → SHIPPED via the SAME shipmentStatusForSellerOrder() stamping used by the seller UI", shipAfterPick.status === "SHIPPED" && shipAfterPick.shippedAt !== null);
        const orderAfterPick = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });
        ok("C · parent Order rolled up to SHIPPED (sole active SellerOrder reached SHIPPED)", orderAfterPick.status === "SHIPPED");
        const auditAfterPick = await tx.adminAuditLog.findFirst({ where: { targetId: orderId, action: "order.shipped" }, select: { actorUserId: true, summary: true } });
        ok("C · rollup audit row written with actorUserId=null (system/webhook actor, same convention as adminCascadeAuditInput)", auditAfterPick !== null && auditAfterPick.actorUserId === null && /System \(LALAMOVE webhook\)/.test(auditAfterPick.summary ?? ""));

        const { envelope: completed } = mkEnvelope(so.externalShipmentId, "COMPLETED");
        const r2 = await processShippingWebhook("lalamove", completed, { isHttps: true }, tx);
        ok("D · webhook returns 200", r2.status === 200);
        const soAfterComplete = await tx.sellerOrder.findUniqueOrThrow({ where: { id: so.soId }, select: { status: true } });
        ok("D · COMPLETED → SellerOrder SHIPPED → DELIVERED", soAfterComplete.status === "DELIVERED");
        const shipAfterComplete = await tx.shipment.findUniqueOrThrow({ where: { id: so.shipmentId }, select: { status: true, deliveredAt: true } });
        ok("D · Shipment.status → DELIVERED, deliveredAt stamped", shipAfterComplete.status === "DELIVERED" && shipAfterComplete.deliveredAt !== null);
        const orderAfterComplete = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });
        ok("D · parent Order rolled up to DELIVERED", orderAfterComplete.status === "DELIVERED");
      }

      // ── E. Out-of-order COMPLETED — READY_TO_SHIP directly to DELIVERED, both hops in one webhook call ──
      {
        const { orderId, sellerOrders } = await mk("PROCESSING", [{ sellerId: sellerX.id, soStatus: "READY_TO_SHIP", shipmentStatus: "PENDING" }]);
        const so = sellerOrders[0];
        const { envelope } = mkEnvelope(so.externalShipmentId, "COMPLETED");
        await processShippingWebhook("lalamove", envelope, { isHttps: true }, tx);
        const soRow = await tx.sellerOrder.findUniqueOrThrow({ where: { id: so.soId }, select: { status: true } });
        ok("E · out-of-order COMPLETED while READY_TO_SHIP → SellerOrder ends at DELIVERED (both hops in one call)", soRow.status === "DELIVERED");
        const shipRow = await tx.shipment.findUniqueOrThrow({ where: { id: so.shipmentId }, select: { status: true, shippedAt: true, deliveredAt: true } });
        ok("E · Shipment carries BOTH stamps (shippedAt AND deliveredAt), not just the final one — proves the intermediate hop genuinely ran", shipRow.status === "DELIVERED" && shipRow.shippedAt !== null && shipRow.deliveredAt !== null);
        const orderRow = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });
        ok("E · parent Order also reaches DELIVERED", orderRow.status === "DELIVERED");
      }

      // ── F. Already SHIPPED + COMPLETED — only the final hop occurs ───────
      {
        const { sellerOrders } = await mk("SHIPPED", [{ sellerId: sellerX.id, soStatus: "SHIPPED", shipmentStatus: "SHIPPED" }]);
        const so = sellerOrders[0];
        const preShippedAt = new Date("2020-01-01T00:00:00Z");
        await tx.shipment.update({ where: { id: so.shipmentId }, data: { shippedAt: preShippedAt } });
        const { envelope } = mkEnvelope(so.externalShipmentId, "COMPLETED");
        await processShippingWebhook("lalamove", envelope, { isHttps: true }, tx);
        const shipRow = await tx.shipment.findUniqueOrThrow({ where: { id: so.shipmentId }, select: { status: true, shippedAt: true, deliveredAt: true } });
        ok("F · already-SHIPPED + COMPLETED → Shipment.status DELIVERED", shipRow.status === "DELIVERED" && shipRow.deliveredAt !== null);
        ok("F · the redundant SHIPPED hop was a genuine no-op — shippedAt is UNCHANGED from before this webhook (not re-stamped)", shipRow.shippedAt?.toISOString() === preShippedAt.toISOString());
      }

      // ── G. Already DELIVERED + repeated normal webhook — no transition attempted, event still recorded ──
      {
        const { sellerOrders } = await mk("DELIVERED", [{ sellerId: sellerX.id, soStatus: "DELIVERED", shipmentStatus: "DELIVERED" }]);
        const so = sellerOrders[0];
        const { envelope } = mkEnvelope(so.externalShipmentId, "COMPLETED");
        const res = await processShippingWebhook("lalamove", envelope, { isHttps: true }, tx);
        ok("G · webhook still returns 200 for an already-terminal Shipment", res.status === 200);
        const ev = await tx.shipmentEvent.findFirst({ where: { shipmentId: so.shipmentId }, select: { id: true } });
        ok("G · ShipmentEvent still recorded even though no transition is attempted", ev !== null);
        const soRow = await tx.sellerOrder.findUniqueOrThrow({ where: { id: so.soId }, select: { status: true } });
        ok("G · SellerOrder unchanged (still DELIVERED)", soRow.status === "DELIVERED");
      }

      // ── H. CANCELLED SellerOrder — no normal transition, event still recorded ──
      {
        const { sellerOrders } = await mk("PROCESSING", [{ sellerId: sellerX.id, soStatus: "CANCELLED", shipmentStatus: "PENDING" }]);
        const so = sellerOrders[0];
        const { envelope } = mkEnvelope(so.externalShipmentId, "PICKED_UP");
        const res = await processShippingWebhook("lalamove", envelope, { isHttps: true }, tx);
        ok("H · webhook returns 200 for a CANCELLED SellerOrder", res.status === 200);
        const ev = await tx.shipmentEvent.findFirst({ where: { shipmentId: so.shipmentId }, select: { id: true } });
        ok("H · ShipmentEvent recorded despite CANCELLED SellerOrder", ev !== null);
        const soRow = await tx.sellerOrder.findUniqueOrThrow({ where: { id: so.soId }, select: { status: true } });
        ok("H · SellerOrder stays CANCELLED — canTransitionSellerOrder's existing guard rejects the move (no bespoke CANCELLED check needed)", soRow.status === "CANCELLED");
        const shipRow = await tx.shipment.findUniqueOrThrow({ where: { id: so.shipmentId }, select: { status: true } });
        ok("H · Shipment.status untouched (still PENDING, never stamped SHIPPED)", shipRow.status === "PENDING");
      }

      // ── I. Duplicate webhook — second delivery does not execute the cascade again ──
      {
        const { sellerOrders } = await mk("PROCESSING", [{ sellerId: sellerX.id, soStatus: "READY_TO_SHIP", shipmentStatus: "PENDING" }]);
        const so = sellerOrders[0];
        const { envelope, eventId } = mkEnvelope(so.externalShipmentId, "PICKED_UP");
        await processShippingWebhook("lalamove", envelope, { isHttps: true }, tx);
        const soAfterFirst = await tx.sellerOrder.findUniqueOrThrow({ where: { id: so.soId }, select: { status: true } });
        ok("I · first delivery → SellerOrder SHIPPED", soAfterFirst.status === "SHIPPED");

        // Re-send the EXACT same envelope (same eventId/providerEventId) a second
        // time. The resulting P2002 aborts the Postgres transaction at the engine
        // level even though webhook.ts's own catch swallows it and returns 200 —
        // a SAVEPOINT isolates that expected abort so the outer test transaction
        // (and every assertion after it) keeps working. This is purely a test
        // artifact of reusing one shared transaction for both deliveries; the
        // real route never needs this — each event gets its OWN fresh
        // `$transaction`, so a duplicate there only ever aborts its own,
        // already-isolated transaction.
        await tx.$executeRawUnsafe("SAVEPOINT dup_test");
        const res2 = await processShippingWebhook("lalamove", envelope, { isHttps: true }, tx);
        await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT dup_test");
        ok("I · duplicate delivery still returns 200 (treated as successfully processed)", res2.status === 200);
        const eventCount = await tx.shipmentEvent.count({ where: { shipmentId: so.shipmentId, providerEventId: eventId } });
        ok("I · exactly ONE ShipmentEvent row exists for this eventId — the duplicate created no second row", eventCount === 1);
        const soAfterDup = await tx.sellerOrder.findUniqueOrThrow({ where: { id: so.soId }, select: { status: true } });
        ok("I · SellerOrder still SHIPPED — the duplicate never re-entered the cascade", soAfterDup.status === "SHIPPED");
        const auditCount = await tx.adminAuditLog.count({ where: { targetType: "order", meta: { contains: so.soId } } });
        ok("I · the parent-Order rollup audit fired only ONCE, not twice", auditCount === 1);
      }

      // ── J. Multi-seller Order — only the matching SellerOrder changes, sibling untouched, rollup blocked until BOTH ship ──
      {
        const sellerY = await mkSeller(tx, "y", sfx);
        const { orderId, sellerOrders } = await mk("PROCESSING", [
          { sellerId: sellerX.id, soStatus: "READY_TO_SHIP", shipmentStatus: "PENDING" },
          { sellerId: sellerY.id, soStatus: "READY_TO_SHIP", shipmentStatus: "PENDING" },
        ]);
        const [soA, soB] = sellerOrders;
        const { envelope } = mkEnvelope(soA.externalShipmentId, "PICKED_UP");
        await processShippingWebhook("lalamove", envelope, { isHttps: true }, tx);

        const rowA = await tx.sellerOrder.findUniqueOrThrow({ where: { id: soA.soId }, select: { status: true } });
        ok("J · the matching SellerOrder (A) advances to SHIPPED", rowA.status === "SHIPPED");
        const rowB = await tx.sellerOrder.findUniqueOrThrow({ where: { id: soB.soId }, select: { status: true } });
        ok("J · the UNRELATED sibling SellerOrder (B) is completely untouched (still READY_TO_SHIP)", rowB.status === "READY_TO_SHIP");
        const orderRow = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });
        ok("J · parent Order does NOT roll up yet — not every active SellerOrder has reached SHIPPED", orderRow.status === "PROCESSING");

        // Now ship B too — the parent should roll up correctly once both are done.
        const { envelope: envelopeB } = mkEnvelope(soB.externalShipmentId, "PICKED_UP");
        await processShippingWebhook("lalamove", envelopeB, { isHttps: true }, tx);
        const orderAfterBoth = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });
        ok("J · parent Order rolls up to SHIPPED once BOTH SellerOrders have shipped", orderAfterBoth.status === "SHIPPED");
      }

      throw new Rollback();
    }, { timeout: 60_000, maxWait: 15_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  const after = {
    sellers: await prisma.seller.count(),
    orders: await prisma.order.count(),
    sellerOrders: await prisma.sellerOrder.count(),
    shipments: await prisma.shipment.count(),
    shipmentEvents: await prisma.shipmentEvent.count(),
    auditLogs: await prisma.adminAuditLog.count(),
  };
  ok("K · rollback — no fixture/test write remains (all counts unchanged)", JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} vs ${JSON.stringify(after)}`);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
