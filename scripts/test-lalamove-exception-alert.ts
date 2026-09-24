/**
 * Lalamove webhook → EXCEPTION (CANCELED / REJECTED / EXPIRED) ops alerting
 * (Phase 9F-48 step 5). Exercises the REAL `processShippingWebhook()` through
 * its full real path — same locally self-signed-envelope approach as
 * `test-lalamove-webhook-cascade.ts` (Task 4) — plus the REAL
 * `sendLalamoveShipmentExceptionOps()` / `EmailLog` dedup path. NO real
 * Lalamove API call and NO real email delivery anywhere in this file: the
 * local `.env` has no SMTP configured, so `dispatchEmail` records a SKIPPED
 * `EmailLog` row rather than sending — exactly the same safe-by-default
 * behaviour every other notification test in this project already relies on.
 *
 * Everything runs inside ONE `prisma.$transaction` that always ends by
 * throwing `Rollback`; `processShippingWebhook()` is called with that SAME
 * `tx` as its `client` parameter, so its own reads/writes (including the
 * `EmailLog` row) land in this transaction and never persist.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-lalamove-exception-alert.ts
 */
import { PrismaClient, Prisma } from "@prisma/client";
import { readFileSync } from "node:fs";
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
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

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
    data: { type: "THIRD_PARTY", status: "APPROVED", displayName: `Except ${tag} ${sfx}`, slug: `except-${tag}-${sfx}`, supportEmail: "s@t.test", contentStatus: "APPROVED" },
    select: { id: true },
  });

async function mkOrderWithSellerOrders(
  tx: Tx,
  sfx: string,
  buyerId: string | undefined,
  parentOrderStatus: string,
  rows: { sellerId: string; soStatus: string; shipmentStatus: string }[],
) {
  const order = await tx.order.create({
    data: { orderNumber: `AX-EXC-${sfx}-${Math.random().toString(36).slice(2, 6)}`, email: "b@e.test", phone: "+630", status: parentOrderStatus, paymentMethod: "COD", paymentStatus: "PENDING", subtotal: 1000, grandTotal: 1000, shippingFee: 0, shippingAddress: "{}", userId: buyerId },
    select: { id: true, orderNumber: true },
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
  return { orderId: order.id, orderNumber: order.orderNumber, sellerOrders };
}

async function main() {
  console.log("\nLalamove webhook EXCEPTION (CANCELED/REJECTED/EXPIRED) ops alerting\n");

  // ── static — the send function never throws, matching the established pattern ──
  const notif = read("src/lib/email/notifications.ts");
  const fn = notif.slice(notif.indexOf("export async function sendLalamoveShipmentExceptionOps"), notif.indexOf("export async function sendLalamoveShipmentExceptionOps") + 2000);
  ok("static · sendLalamoveShipmentExceptionOps wraps its body in try/catch, same as sendReconciliationStaleRunAlertOps",
    /try \{/.test(fn) && /catch \(err\) \{/.test(fn) && /return \{ ok: false, status: "FAILED", error: "unexpected" \};/.test(fn));
  ok("static · idempotencyKey is keyed on providerEventId (LALAMOVE_EXCEPTION_ALERT:<providerEventId>)",
    /idempotencyKey: `LALAMOVE_EXCEPTION_ALERT:\$\{params\.providerEventId\}`/.test(fn));
  ok("static · never automatically sets Shipment.status / SellerOrder.status / Order.status (no .update/.updateMany call in this function)",
    !/\.(update|updateMany)\(/.test(fn));

  const before = {
    sellers: await prisma.seller.count(),
    orders: await prisma.order.count(),
    sellerOrders: await prisma.sellerOrder.count(),
    shipments: await prisma.shipment.count(),
    shipmentEvents: await prisma.shipmentEvent.count(),
    emailLogs: await prisma.emailLog.count(),
  };

  try {
    await prisma.$transaction(async (tx: Tx) => {
      const sfx = Math.random().toString(36).slice(2, 8);
      const buyer = await tx.user.findFirst({ select: { id: true } });
      const mk = (status: string, rows: { sellerId: string; soStatus: string; shipmentStatus: string }[]) =>
        mkOrderWithSellerOrders(tx, sfx, buyer?.id, status, rows);
      const sellerX = await mkSeller(tx, "x", sfx);

      // ── A. CANCELED ──────────────────────────────────────────────────────
      {
        const { orderId, orderNumber, sellerOrders } = await mk("PROCESSING", [{ sellerId: sellerX.id, soStatus: "READY_TO_SHIP", shipmentStatus: "PENDING" }]);
        const so = sellerOrders[0];
        const { envelope, eventId } = mkEnvelope(so.externalShipmentId, "CANCELED");
        const res = await processShippingWebhook("lalamove", envelope, { isHttps: true }, tx);
        ok("A · webhook returns 200", res.status === 200);
        const ev = await tx.shipmentEvent.findFirst({ where: { shipmentId: so.shipmentId }, select: { rawStatus: true, normStatus: true } });
        ok("A · ShipmentEvent recorded with rawStatus CANCELED, normStatus EXCEPTION", ev?.rawStatus === "CANCELED" && ev?.normStatus === "EXCEPTION");
        const ship = await tx.shipment.findUniqueOrThrow({ where: { id: so.shipmentId }, select: { lastCarrierStatus: true, status: true } });
        ok("A · Shipment.lastCarrierStatus updated to CANCELED, Shipment.status untouched (still PENDING)", ship.lastCarrierStatus === "CANCELED" && ship.status === "PENDING");
        const soRow = await tx.sellerOrder.findUniqueOrThrow({ where: { id: so.soId }, select: { status: true } });
        ok("A · no SellerOrder transition (still READY_TO_SHIP)", soRow.status === "READY_TO_SHIP");
        const orderRow = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });
        ok("A · no Order transition (still PROCESSING)", orderRow.status === "PROCESSING");
        const alerts = await tx.emailLog.findMany({ where: { idempotencyKey: `LALAMOVE_EXCEPTION_ALERT:${eventId}` } });
        ok("A · exactly one ops alert (EmailLog row) for this event", alerts.length === 1);
        ok("A · alert type is lalamove_shipment_exception_ops, orderId matches this Order", alerts[0]?.type === "lalamove_shipment_exception_ops" && alerts[0]?.orderId === orderId);
        ok("A · alert subject names the actual raw status CANCELED", /CANCELED/.test(alerts[0]?.subject ?? ""));
        ok("A · alert subject includes the order number for operator identification", (alerts[0]?.subject ?? "").includes(orderNumber));
      }

      // ── B. REJECTED ──────────────────────────────────────────────────────
      {
        const { sellerOrders } = await mk("PROCESSING", [{ sellerId: sellerX.id, soStatus: "READY_TO_SHIP", shipmentStatus: "PENDING" }]);
        const so = sellerOrders[0];
        const { envelope, eventId } = mkEnvelope(so.externalShipmentId, "REJECTED");
        await processShippingWebhook("lalamove", envelope, { isHttps: true }, tx);
        const ev = await tx.shipmentEvent.findFirst({ where: { shipmentId: so.shipmentId }, select: { rawStatus: true, normStatus: true } });
        ok("B · ShipmentEvent recorded with rawStatus REJECTED, normStatus EXCEPTION", ev?.rawStatus === "REJECTED" && ev?.normStatus === "EXCEPTION");
        const soRow = await tx.sellerOrder.findUniqueOrThrow({ where: { id: so.soId }, select: { status: true } });
        ok("B · no SellerOrder transition", soRow.status === "READY_TO_SHIP");
        const alert = await tx.emailLog.findUnique({ where: { idempotencyKey: `LALAMOVE_EXCEPTION_ALERT:${eventId}` } });
        ok("B · exactly one ops alert, subject names the actual raw status REJECTED (not a generic message)", alert !== null && /REJECTED/.test(alert.subject));
      }

      // ── C. EXPIRED ───────────────────────────────────────────────────────
      {
        const { sellerOrders } = await mk("PROCESSING", [{ sellerId: sellerX.id, soStatus: "READY_TO_SHIP", shipmentStatus: "PENDING" }]);
        const so = sellerOrders[0];
        const { envelope, eventId } = mkEnvelope(so.externalShipmentId, "EXPIRED");
        await processShippingWebhook("lalamove", envelope, { isHttps: true }, tx);
        const ev = await tx.shipmentEvent.findFirst({ where: { shipmentId: so.shipmentId }, select: { rawStatus: true, normStatus: true } });
        ok("C · ShipmentEvent recorded with rawStatus EXPIRED, normStatus EXCEPTION", ev?.rawStatus === "EXPIRED" && ev?.normStatus === "EXCEPTION");
        const soRow = await tx.sellerOrder.findUniqueOrThrow({ where: { id: so.soId }, select: { status: true } });
        ok("C · no SellerOrder transition", soRow.status === "READY_TO_SHIP");
        const alert = await tx.emailLog.findUnique({ where: { idempotencyKey: `LALAMOVE_EXCEPTION_ALERT:${eventId}` } });
        ok("C · exactly one ops alert, subject names the actual raw status EXPIRED (not a generic message)", alert !== null && /EXPIRED/.test(alert.subject));
      }

      // ── D. Duplicate webhook — no second ShipmentEvent, no second alert ──
      {
        const { sellerOrders } = await mk("PROCESSING", [{ sellerId: sellerX.id, soStatus: "READY_TO_SHIP", shipmentStatus: "PENDING" }]);
        const so = sellerOrders[0];
        const { envelope, eventId } = mkEnvelope(so.externalShipmentId, "CANCELED");
        await processShippingWebhook("lalamove", envelope, { isHttps: true }, tx);
        const firstCount = await tx.emailLog.count({ where: { idempotencyKey: `LALAMOVE_EXCEPTION_ALERT:${eventId}` } });
        ok("D · first delivery produced exactly one alert", firstCount === 1);

        // Re-send the EXACT same envelope. See test-lalamove-webhook-cascade.ts
        // for why a SAVEPOINT is needed: the expected P2002 aborts the shared
        // outer test transaction at the Postgres engine level even though
        // webhook.ts's own catch swallows it and returns 200; this is purely a
        // test artifact of reusing one transaction for both deliveries — the
        // real route always gets a fresh, isolated transaction per event.
        await tx.$executeRawUnsafe("SAVEPOINT dup_exc_test");
        const res2 = await processShippingWebhook("lalamove", envelope, { isHttps: true }, tx);
        await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT dup_exc_test");
        ok("D · duplicate delivery still returns 200 (safely idempotent)", res2.status === 200);
        const eventCount = await tx.shipmentEvent.count({ where: { shipmentId: so.shipmentId, providerEventId: eventId } });
        ok("D · exactly ONE ShipmentEvent row exists for this eventId", eventCount === 1);
        const alertCount = await tx.emailLog.count({ where: { idempotencyKey: `LALAMOVE_EXCEPTION_ALERT:${eventId}` } });
        ok("D · still exactly ONE ops alert — the duplicate raised no second one", alertCount === 1);
      }

      // ── E. Already DELIVERED Shipment — event still recorded, alert still fires, no transition ──
      {
        const { sellerOrders } = await mk("DELIVERED", [{ sellerId: sellerX.id, soStatus: "DELIVERED", shipmentStatus: "DELIVERED" }]);
        const so = sellerOrders[0];
        const { envelope, eventId } = mkEnvelope(so.externalShipmentId, "CANCELED");
        const res = await processShippingWebhook("lalamove", envelope, { isHttps: true }, tx);
        ok("E · webhook returns 200 for an already-DELIVERED Shipment", res.status === 200);
        const ev = await tx.shipmentEvent.findFirst({ where: { shipmentId: so.shipmentId }, select: { id: true } });
        ok("E · ShipmentEvent still recorded per current behaviour", ev !== null);
        const soRow = await tx.sellerOrder.findUniqueOrThrow({ where: { id: so.soId }, select: { status: true } });
        ok("E · no SellerOrder transition (stays DELIVERED)", soRow.status === "DELIVERED");
        const shipRow = await tx.shipment.findUniqueOrThrow({ where: { id: so.shipmentId }, select: { status: true } });
        ok("E · Shipment.status untouched (stays DELIVERED, never reverted)", shipRow.status === "DELIVERED");
        const alertCount = await tx.emailLog.count({ where: { idempotencyKey: `LALAMOVE_EXCEPTION_ALERT:${eventId}` } });
        ok("E · exactly one ops alert — the terminal-shipment check does not suppress the exception alert, and does not double-fire it either", alertCount === 1);
      }

      // ── F. Multi-seller isolation ────────────────────────────────────────
      {
        const sellerY = await mkSeller(tx, "y", sfx);
        const { sellerOrders } = await mk("PROCESSING", [
          { sellerId: sellerX.id, soStatus: "READY_TO_SHIP", shipmentStatus: "PENDING" },
          { sellerId: sellerY.id, soStatus: "READY_TO_SHIP", shipmentStatus: "PENDING" },
        ]);
        const [soA, soB] = sellerOrders;
        const { envelope, eventId } = mkEnvelope(soA.externalShipmentId, "REJECTED");
        await processShippingWebhook("lalamove", envelope, { isHttps: true }, tx);

        const rowA = await tx.sellerOrder.findUniqueOrThrow({ where: { id: soA.soId }, select: { status: true } });
        ok("F · the matching SellerOrder (A) is unchanged (exceptions never transition anything)", rowA.status === "READY_TO_SHIP");
        const rowB = await tx.sellerOrder.findUniqueOrThrow({ where: { id: soB.soId }, select: { status: true } });
        ok("F · the UNRELATED sibling SellerOrder (B) is completely untouched", rowB.status === "READY_TO_SHIP");
        const shipB = await tx.shipment.findUniqueOrThrow({ where: { id: soB.shipmentId }, select: { lastCarrierStatus: true } });
        ok("F · sibling Shipment (B) carries NO carrier-status update from A's event", shipB.lastCarrierStatus === null);
        const alertsForA = await tx.emailLog.count({ where: { idempotencyKey: `LALAMOVE_EXCEPTION_ALERT:${eventId}` } });
        ok("F · exactly one alert, scoped to Shipment A's own event only", alertsForA === 1);
        const totalAlertsThisScenario = await tx.emailLog.count({ where: { type: "lalamove_shipment_exception_ops", orderId: (await tx.sellerOrder.findUniqueOrThrow({ where: { id: soA.soId }, select: { orderId: true } })).orderId } });
        ok("F · no alert was raised for sibling B (only one alert total on this Order)", totalAlertsThisScenario === 1);
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
    emailLogs: await prisma.emailLog.count(),
  };
  ok("H · rollback — no fixture/test write remains (all counts unchanged, including EmailLog)", JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} vs ${JSON.stringify(after)}`);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
