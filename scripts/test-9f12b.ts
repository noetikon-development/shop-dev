/**
 * PHASE 9F-12b — Marketplace order status rollup (seller → parent Order).
 *
 * When a THIRD_PARTY seller advances a SellerOrder to SHIPPED / DELIVERED and
 * EVERY SellerOrder on the parent Order has reached that milestone, the
 * customer-facing parent `Order` is rolled forward (status + courier/tracking
 * snapshot + shippedAt/deliveredAt + one OrderEvent), the seller is recorded as
 * the audit actor, and the existing customer notification fires (idempotency-
 * keyed). COD payment stays PENDING throughout. 1P/admin fulfilment untouched.
 *
 * DB tests run inside ONE rolled-back `prisma.$transaction` (nothing persists);
 * `advanceSellerOrderStatus` is called with that tx as `externalTx`.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f12b.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  advanceSellerOrderStatus,
  rollupAuditInput,
  type ParentOrderRollup,
} from "../src/lib/marketplace/seller-order-repository";
import type { SellerContext } from "../src/lib/marketplace/types";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

function ctxFor(sellerId: string): SellerContext {
  return {
    sellerId,
    sellerName: "Test Seller " + sellerId.slice(-4),
    sellerUserId: "su-" + sellerId,
    userId: "u-" + sellerId,
    role: "OWNER",
    permissions: new Set(),
  };
}
class Rollback extends Error {}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

async function makeOrderWithSellerOrders(
  tx: Tx,
  sellers: { id: string; soStatus: string; withShipment: boolean }[],
  parentStatus = "PROCESSING",
  suffix = "",
) {
  const order = await tx.order.create({
    data: {
      orderNumber: `AX-T9F12B-${suffix}-${Math.random().toString(36).slice(2, 6)}`,
      email: "buyer@example.test",
      phone: "+639000000000",
      status: parentStatus,
      // paymentStatus / paymentMethod left at their schema defaults: UNPAID / COD
      subtotal: 1000,
      grandTotal: 1150,
      shippingFee: 150,
      shippingAddress: JSON.stringify({ firstName: "T", lastName: "B", line1: "1 St", city: "Manila", province: "NCR", postalCode: "1000", country: "PH" }),
    },
    select: { id: true, orderNumber: true },
  });
  const sellerOrders: string[] = [];
  for (const s of sellers) {
    const so = await tx.sellerOrder.create({
      data: {
        orderId: order.id,
        sellerId: s.id,
        sellerName: "S",
        sellerType: "THIRD_PARTY",
        supportEmail: "s@example.test",
        merchandiseSubtotal: 1000,
        shippingFee: 150,
        total: 1150,
        status: s.soStatus,
      },
      select: { id: true },
    });
    await tx.orderItem.create({
      data: { orderId: order.id, sellerOrderId: so.id, sellerId: s.id, productId: "p", name: "Item", unitPrice: 1000, quantity: 1, lineTotal: 1000 },
    });
    if (s.withShipment) {
      await tx.shipment.create({
        data: {
          sellerOrderId: so.id,
          carrier: "OTHER",
          carrierName: "Pilot Delivery",
          trackingNumber: `TRK-${suffix}-${sellerOrders.length}`,
          trackingUrl: "https://track.example/x",
          status: "PENDING",
        },
      });
    }
    sellerOrders.push(so.id);
  }
  return { orderId: order.id, orderNumber: order.orderNumber, sellerOrders };
}

async function pureTests() {
  console.log("\n── pure — rollupAuditInput (seller is the actor) ──");
  const ctx = ctxFor("cmseller00000000000000abc");
  const rollupShipped: ParentOrderRollup = { id: "ord1", orderNumber: "AX-1", rolledTo: "SHIPPED" };
  const aShip = rollupAuditInput(ctx, rollupShipped, "so1");
  ok("audit actor is the authenticated seller user (ctx.userId)", aShip.actorUserId === ctx.userId);
  ok("SHIPPED rollup → action order.shipped", aShip.action === "order.shipped");
  ok("audit targets the parent order", aShip.targetType === "order" && aShip.targetId === "ord1");
  ok("audit meta carries trigger + seller + sellerOrder", (aShip.meta as Record<string, unknown>).trigger === "seller_rollup" && (aShip.meta as Record<string, unknown>).actorSellerId === ctx.sellerId && (aShip.meta as Record<string, unknown>).sellerOrderId === "so1");
  const aDel = rollupAuditInput(ctx, { id: "ord1", orderNumber: "AX-1", rolledTo: "DELIVERED" }, "so1");
  ok("DELIVERED rollup → action order.delivered", aDel.action === "order.delivered" && (aDel.meta as Record<string, unknown>).to === "DELIVERED");
}

async function dbTests() {
  const suffix = String(Date.now()).slice(-6);
  const orderEventsBefore = await prisma.orderEvent.count();
  const auditBefore = await prisma.adminAuditLog.count();
  const offerAdjBefore = await prisma.offerAdjustment.count();
  const invAdjBefore = await prisma.inventoryAdjustment.count();

  try {
    await prisma.$transaction(async (tx) => {
      const S1 = await tx.seller.create({ data: { type: "THIRD_PARTY", status: "APPROVED", displayName: "S1", slug: `s1-9f12b-${suffix}`, supportEmail: "s1@t.test" } });
      const S2 = await tx.seller.create({ data: { type: "THIRD_PARTY", status: "APPROVED", displayName: "S2", slug: `s2-9f12b-${suffix}`, supportEmail: "s2@t.test" } });
      const c1 = ctxFor(S1.id);
      const c2 = ctxFor(S2.id);

      // ── 1. one SellerOrder → parent SHIPPED ──────────────────────────────
      const single = await makeOrderWithSellerOrders(tx, [{ id: S1.id, soStatus: "READY_TO_SHIP", withShipment: true }], "PROCESSING", suffix + "a");
      const rShip = await advanceSellerOrderStatus(c1, single.sellerOrders[0], "SHIPPED", tx);
      ok("1 · advance to SHIPPED ok", rShip.ok === true, JSON.stringify(rShip));
      ok("1 · result carries parentOrder rolledTo SHIPPED", rShip.ok === true && rShip.parentOrder?.rolledTo === "SHIPPED" && rShip.parentOrder?.id === single.orderId);
      const oShip = await tx.order.findUnique({ where: { id: single.orderId }, select: { status: true, shippedAt: true, deliveredAt: true, courier: true, courierName: true, trackingNumber: true, trackingUrl: true, paymentStatus: true, paymentMethod: true } });
      ok("1 · parent Order.status = SHIPPED", oShip?.status === "SHIPPED");
      ok("1 · Order.shippedAt populated, deliveredAt still null", !!oShip?.shippedAt && oShip?.deliveredAt === null);

      // ── 4. shipment data copied correctly (Shipment.carrier* → Order.courier*) ─
      ok("4 · courier / courierName / trackingNumber / trackingUrl copied from the Shipment", oShip?.courier === "OTHER" && oShip?.courierName === "Pilot Delivery" && oShip?.trackingNumber === `TRK-${suffix}a-0` && oShip?.trackingUrl === "https://track.example/x", JSON.stringify(oShip));

      // ── 5/OrderEvent ───────────────────────────────────────────────────
      const evShip = await tx.orderEvent.findMany({ where: { orderId: single.orderId }, select: { status: true, title: true, detail: true } });
      ok("5 · a single SHIPPED 'Order shipped' OrderEvent was created", evShip.filter((e) => e.status === "SHIPPED" && e.title === "Order shipped").length === 1, JSON.stringify(evShip));
      ok("5 · the event detail carries the carrier + tracking", (evShip.find((e) => e.status === "SHIPPED")?.detail ?? "").includes("Pilot Delivery") && (evShip.find((e) => e.status === "SHIPPED")?.detail ?? "").includes(`TRK-${suffix}a-0`));

      // ── COD ────────────────────────────────────────────────────────────
      ok("COD · paymentStatus stays UNPAID and paymentMethod stays COD after SHIPPED", oShip?.paymentStatus === "UNPAID" && oShip?.paymentMethod === "COD");

      // ── 2. same SellerOrder → parent DELIVERED ──────────────────────────
      const rDel = await advanceSellerOrderStatus(c1, single.sellerOrders[0], "DELIVERED", tx);
      ok("2 · advance to DELIVERED ok, parentOrder rolledTo DELIVERED", rDel.ok === true && rDel.ok && rDel.parentOrder?.rolledTo === "DELIVERED");
      const oDel = await tx.order.findUnique({ where: { id: single.orderId }, select: { status: true, deliveredAt: true, paymentStatus: true } });
      ok("2 · parent Order.status = DELIVERED, deliveredAt populated (settlement window anchor)", oDel?.status === "DELIVERED" && !!oDel?.deliveredAt);
      ok("2 · a single DELIVERED 'Delivered' OrderEvent was created", (await tx.orderEvent.count({ where: { orderId: single.orderId, status: "DELIVERED", title: "Delivered" } })) === 1);
      ok("2 · COD paymentStatus still UNPAID after DELIVERED", oDel?.paymentStatus === "UNPAID");

      // ── idempotency: SellerOrder is terminal — cannot re-trigger a rollup ─
      const again = await advanceSellerOrderStatus(c1, single.sellerOrders[0], "DELIVERED", tx);
      ok("idem · repeating DELIVERED is rejected (SellerOrder terminal) → no duplicate parent transition / event", again.ok === false);
      ok("idem · still exactly one SHIPPED + one DELIVERED OrderEvent on the order", (await tx.orderEvent.count({ where: { orderId: single.orderId, status: "SHIPPED" } })) === 1 && (await tx.orderEvent.count({ where: { orderId: single.orderId, status: "DELIVERED" } })) === 1);

      // ── 3. multiple SellerOrders → parent does NOT advance until ALL qualify ─
      const multi = await makeOrderWithSellerOrders(
        tx,
        [
          { id: S1.id, soStatus: "READY_TO_SHIP", withShipment: true },
          { id: S2.id, soStatus: "READY_TO_SHIP", withShipment: true },
        ],
        "PROCESSING",
        suffix + "b",
      );
      const m1 = await advanceSellerOrderStatus(c1, multi.sellerOrders[0], "SHIPPED", tx);
      ok("3 · first of two sellers ships → NO parent rollup", m1.ok === true && m1.ok && m1.parentOrder === undefined);
      ok("3 · parent Order still PROCESSING after 1/2 shipped", (await tx.order.findUnique({ where: { id: multi.orderId }, select: { status: true } }))?.status === "PROCESSING");
      ok("3 · no SHIPPED OrderEvent yet", (await tx.orderEvent.count({ where: { orderId: multi.orderId, status: "SHIPPED" } })) === 0);

      const m2 = await advanceSellerOrderStatus(c2, multi.sellerOrders[1], "SHIPPED", tx);
      ok("3 · second seller ships → parent rolls to SHIPPED", m2.ok === true && m2.ok && m2.parentOrder?.rolledTo === "SHIPPED");
      ok("3 · parent Order.status = SHIPPED once ALL sellers shipped", (await tx.order.findUnique({ where: { id: multi.orderId }, select: { status: true } }))?.status === "SHIPPED");

      // deliver only one → parent stays SHIPPED
      const md1 = await advanceSellerOrderStatus(c1, multi.sellerOrders[0], "DELIVERED", tx);
      ok("3 · first of two sellers delivers → NO parent rollup", md1.ok === true && md1.ok && md1.parentOrder === undefined);
      ok("3 · parent Order still SHIPPED after 1/2 delivered", (await tx.order.findUnique({ where: { id: multi.orderId }, select: { status: true } }))?.status === "SHIPPED");
      const md2 = await advanceSellerOrderStatus(c2, multi.sellerOrders[1], "DELIVERED", tx);
      ok("3 · second seller delivers → parent rolls to DELIVERED", md2.ok === true && md2.ok && md2.parentOrder?.rolledTo === "DELIVERED");
      const mo = await tx.order.findUnique({ where: { id: multi.orderId }, select: { status: true, deliveredAt: true } });
      ok("3 · parent Order.status = DELIVERED + deliveredAt once ALL sellers delivered", mo?.status === "DELIVERED" && !!mo?.deliveredAt);

      // ── no PARTIALLY_* status was ever written ──────────────────────────
      const anyPartial = await tx.order.count({ where: { status: { in: ["PARTIALLY_SHIPPED", "PARTIALLY_DELIVERED"] } } });
      ok("no PARTIALLY_SHIPPED / PARTIALLY_DELIVERED status introduced", anyPartial === 0);

      // ── inventory / offer untouched by the rollup ──────────────────────
      ok("rollup created no OfferAdjustment", (await tx.offerAdjustment.count()) === offerAdjBefore);
      ok("rollup created no InventoryAdjustment", (await tx.inventoryAdjustment.count()) === invAdjBefore);

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("rolled back cleanly — no OrderEvent persisted", (await prisma.orderEvent.count()) === orderEventsBefore);
  ok("rolled back cleanly — no adminAuditLog persisted", (await prisma.adminAuditLog.count()) === auditBefore);
}

function staticTests() {
  console.log("\n── static wiring ──");
  const repo = read("src/lib/marketplace/seller-order-repository.ts");
  const actions = read("src/lib/seller/order-actions.ts");
  const send = read("src/lib/email/send.ts");

  const rollupFn = repo.slice(repo.indexOf("async function rollUpParentOrder"), repo.indexOf("export async function advanceSellerOrderStatus"));
  ok("repo · rollUpParentOrder only advances the parent from the expected state (status-guarded updateMany)", /where: \{ id: order\.id, status: "PROCESSING" \}/.test(rollupFn) && /where: \{ id: order\.id, status: \{ in: \["SHIPPED", "OUT_FOR_DELIVERY"\] \} \}/.test(rollupFn));
  ok("repo · SHIPPED rollup requires ALL SellerOrders shipped-or-beyond", /order\.sellerOrders\.every\(\(s\) => SHIPPED_OR_BEYOND\.has\(s\.status\)\)/.test(rollupFn));
  ok("repo · DELIVERED rollup requires ALL SellerOrders DELIVERED", /order\.sellerOrders\.every\(\(s\) => s\.status === "DELIVERED"\)/.test(rollupFn));
  ok("repo · reuses the SellerOrder's own Shipment — the rollup creates no shipment", !/shipment\.create|shipment\.update/i.test(rollupFn));
  ok("repo · the rollup's Order.updateMany payloads never write paymentStatus / paymentMethod", !/paymentStatus|paymentMethod/.test(rollupFn));
  ok("repo · seller-actor audit is written AFTER the transaction commits (best-effort)", /const result = await prisma\.\$transaction\(run\);[\s\S]{0,400}writeAudit\(rollupAuditInput\(ctx, result\.parentOrder, sellerOrderId\)\)/.test(repo));
  ok("repo · the rollup helper itself never calls writeAudit (kept out of the tx)", !/writeAudit/.test(rollupFn));
  ok("repo · rollup does not touch inventory / offer / settlement", !/\b(tx|prisma)\.(offerInventory|offerAdjustment|inventory|inventoryAdjustment|sellerSettlement)\b/.test(rollupFn));

  ok("actions · sends the EXISTING sendOrderShipped / sendOrderDelivered on a rollup, guarded by res.parentOrder", /if \(res\.parentOrder\) \{[\s\S]{0,400}scheduleEmail\(\(\) => \(rolledTo === "SHIPPED" \? sendOrderShipped\(id\) : sendOrderDelivered\(id\)\)\)/.test(actions));
  ok("actions · revalidates the customer order pages on a rollup", /if \(res\.parentOrder\) \{[\s\S]{0,300}revalidateOrderPaths\(res\.parentOrder\.orderNumber, res\.parentOrder\.id\)/.test(actions));
  ok("email · no NEW EmailType added (order_shipped / order_delivered already exist)", /"order_shipped"/.test(send) && /"order_delivered"/.test(send) && !/9F-12b/.test(send));

  // 1P / admin fulfilment untouched
  const fulfil = read("src/lib/admin/fulfillment-actions.ts");
  ok("1P · admin fulfillment-actions.ts not modified by this phase", !/9F-12b|rollUpParentOrder|advanceSellerOrderStatus/.test(fulfil));
  const orderActions = read("src/lib/admin/order-actions.ts");
  ok("1P · admin order-actions.ts not modified by this phase", !/9F-12b|rollUpParentOrder/.test(orderActions));
  ok("scope · no schema change", !/9F-12b|rollUpParentOrder/.test(read("prisma/schema.prisma")));
  ok("scope · seed-rbac.ts untouched marker", !/9F-12b/.test(read("scripts/seed-rbac.ts")));
}

async function main() {
  console.log("\nPHASE 9F-12b — marketplace order status rollup\n");
  await pureTests();
  staticTests();
  await dbTests();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
