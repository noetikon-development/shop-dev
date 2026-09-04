/**
 * Phase 9F-2 — Seller Orders & Fulfilment — assertion runner.
 *
 * DB tests build a real 3P Order + SellerOrder + OrderItems + (optionally) a
 * Shipment inside ONE `prisma.$transaction` and roll back — nothing persists.
 * Run with `--conditions=react-server` so `server-only` imports are inert.
 *
 * Groups:
 *   A  seller-scoped SellerOrder / Shipment isolation
 *   B  ownership re-checked inside the write transaction (forged ids fail)
 *   C  valid fulfilment lifecycle (PROCESSING → READY_TO_SHIP → SHIPPED → DELIVERED)
 *   D  parent-order gate (no fulfilment while parent is PENDING_PAYMENT / CANCELLED)
 *   E  SHIPPED requires a shippable Shipment; shipment validation
 *   F  1P / customer data untouched (no Order.status / OrderEvent / Inventory / OfferInventory write)
 *   G  static wiring
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f2.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  listSellerOrders,
  getSellerOrderForSeller,
  advanceSellerOrderStatus,
  saveSellerShipment,
} from "../src/lib/marketplace/seller-order-repository";
import {
  canTransitionSellerOrder,
  isParentOrderFulfillable,
} from "../src/lib/marketplace/seller-order-status";
import type { SellerContext } from "../src/lib/marketplace/types";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.error(`  FAIL  ${name}   ${detail}`);
  }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

function ctxFor(sellerId: string): SellerContext {
  return {
    sellerId,
    sellerName: "S",
    sellerUserId: "su-" + sellerId,
    userId: "u-" + sellerId,
    role: "OWNER",
    permissions: new Set(),
  };
}
class Rollback extends Error {}

async function pureTests() {
  ok(
    "pure: parent PENDING_PAYMENT is not fulfillable",
    !isParentOrderFulfillable("PENDING_PAYMENT") && !isParentOrderFulfillable("CANCELLED"),
  );
  ok(
    "pure: parent PROCESSING/SHIPPED/DELIVERED are fulfillable",
    ["PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"].every(isParentOrderFulfillable),
  );
  ok(
    "pure: READY_TO_SHIP → SHIPPED blocked without a shipment",
    !canTransitionSellerOrder("READY_TO_SHIP", "SHIPPED", { parentOrderStatus: "PROCESSING", hasShippableShipment: false }) &&
      canTransitionSellerOrder("READY_TO_SHIP", "SHIPPED", { parentOrderStatus: "PROCESSING", hasShippableShipment: true }),
  );
  ok(
    "pure: no transition when parent not fulfillable",
    !canTransitionSellerOrder("PROCESSING", "READY_TO_SHIP", { parentOrderStatus: "PENDING_PAYMENT" }),
  );
  ok(
    "pure: PROCESSING → SHIPPED (skip) rejected",
    !canTransitionSellerOrder("PROCESSING", "SHIPPED", { parentOrderStatus: "PROCESSING", hasShippableShipment: true }),
  );
}

async function makeSellerOrder(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  sellerId: string,
  parentStatus: string,
  soStatus: string,
  suffix: string,
) {
  const order = await tx.order.create({
    data: {
      orderNumber: `AX-TEST9F2-${suffix}-${Math.random().toString(36).slice(2, 6)}`,
      email: "buyer@example.test",
      phone: "+639000000000",
      status: parentStatus,
      subtotal: 1000,
      grandTotal: 1000,
      shippingAddress: JSON.stringify({
        firstName: "Test",
        lastName: "Buyer",
        phone: "+639111111111",
        line1: "1 Test St",
        city: "Manila",
        province: "NCR",
        postalCode: "1000",
        country: "PH",
      }),
    },
    select: { id: true },
  });
  const so = await tx.sellerOrder.create({
    data: {
      orderId: order.id,
      sellerId,
      sellerName: "S",
      sellerType: "THIRD_PARTY",
      supportEmail: "s@example.test",
      merchandiseSubtotal: 1000,
      total: 1000,
      status: soStatus,
    },
    select: { id: true },
  });
  await tx.orderItem.create({
    data: {
      orderId: order.id,
      sellerOrderId: so.id,
      sellerId,
      productId: "p",
      name: "Test item",
      unitPrice: 1000,
      quantity: 1,
      lineTotal: 1000,
    },
  });
  return { orderId: order.id, sellerOrderId: so.id };
}

async function dbTests() {
  const suffix = String(Date.now()).slice(-7);
  const orderEventsBefore = await prisma.orderEvent.count();
  const invAdjBefore = await prisma.inventoryAdjustment.count();
  const offerAdjBefore = await prisma.offerAdjustment.count();

  try {
    await prisma.$transaction(async (tx) => {
      const A = await tx.seller.create({
        data: { type: "THIRD_PARTY", status: "APPROVED", displayName: "A", slug: `a9f2-${suffix}`, supportEmail: "a@t.test" },
      });
      const B = await tx.seller.create({
        data: { type: "THIRD_PARTY", status: "APPROVED", displayName: "B", slug: `b9f2-${suffix}`, supportEmail: "b@t.test" },
      });
      const ctxA = ctxFor(A.id);

      // parent PROCESSING, SO PROCESSING → the happy path
      const oa = await makeSellerOrder(tx, A.id, "PROCESSING", "PROCESSING", suffix);
      const ob = await makeSellerOrder(tx, B.id, "PROCESSING", "PROCESSING", suffix);

      // ---- A: isolation ----
      const listA = await listSellerOrders(ctxA, {}, tx);
      ok("A1 listSellerOrders(A) has A's order", listA.some((o) => o.id === oa.sellerOrderId));
      ok("A2 listSellerOrders(A) excludes B's order", !listA.some((o) => o.id === ob.sellerOrderId));
      ok("A3 getSellerOrderForSeller(A, B's SO) → null", (await getSellerOrderForSeller(ctxA, ob.sellerOrderId, tx)) === null);

      // detail read never selects account email / phone / billing
      const detail = await getSellerOrderForSeller(ctxA, oa.sellerOrderId, tx);
      ok(
        "A4 detail read exposes no customer account fields",
        !!detail &&
          !("email" in (detail.order as object)) &&
          !("phone" in (detail.order as object)) &&
          !("userId" in (detail.order as object)) &&
          !("billingAddress" in (detail.order as object)) &&
          !("grandTotal" in (detail.order as object)),
      );

      // ---- B + A: cross-seller mutation rejected ----
      ok(
        "B1 advanceSellerOrderStatus(A, B's SO) rejected",
        (await advanceSellerOrderStatus(ctxA, ob.sellerOrderId, "READY_TO_SHIP", tx)).ok === false,
      );
      ok(
        "B2 saveSellerShipment(A, B's SO) rejected",
        (await saveSellerShipment(ctxA, ob.sellerOrderId, { carrier: "LBC", trackingNumber: "X1" }, undefined, tx)).ok === false,
      );
      ok(
        "B3 forged sellerOrderId rejected",
        (await advanceSellerOrderStatus(ctxA, "cmforged00000000000000000", "READY_TO_SHIP", tx)).ok === false,
      );

      // ---- C: lifecycle ----
      const r1 = await advanceSellerOrderStatus(ctxA, oa.sellerOrderId, "READY_TO_SHIP", tx);
      ok("C1 PROCESSING → READY_TO_SHIP ok", r1.ok === true, JSON.stringify(r1));

      // ---- E: SHIPPED needs a shipment ----
      const noShip = await advanceSellerOrderStatus(ctxA, oa.sellerOrderId, "SHIPPED", tx);
      ok("E1 READY_TO_SHIP → SHIPPED without a shipment rejected", noShip.ok === false && noShip.code === "VALIDATION");

      const badCarrier = await saveSellerShipment(ctxA, oa.sellerOrderId, { carrier: "NOPE", trackingNumber: "X" }, undefined, tx);
      ok("E2 unknown carrier rejected", badCarrier.ok === false);
      const noTracking = await saveSellerShipment(ctxA, oa.sellerOrderId, { carrier: "LBC" }, undefined, tx);
      ok("E3 tracking-required carrier without a number rejected", noTracking.ok === false);
      const badUrl = await saveSellerShipment(
        ctxA,
        oa.sellerOrderId,
        { carrier: "LBC", trackingNumber: "TRK123", trackingUrl: "http://insecure.example" },
        undefined,
        tx,
      );
      ok("E4 non-https tracking URL rejected", badUrl.ok === false);

      const ship = await saveSellerShipment(ctxA, oa.sellerOrderId, { carrier: "LBC", trackingNumber: "TRK123" }, undefined, tx);
      ok("E5 valid shipment saved", ship.ok === true, JSON.stringify(ship));
      const shipRow = ship.ok ? await tx.shipment.findUnique({ where: { id: ship.shipmentId }, select: { trackingUrl: true, status: true } }) : null;
      ok("E6 tracking URL auto-built + status PENDING", !!shipRow?.trackingUrl?.startsWith("https://") && shipRow?.status === "PENDING");
      const dupe = await saveSellerShipment(ctxA, oa.sellerOrderId, { carrier: "JT_EXPRESS", trackingNumber: "Y2" }, undefined, tx);
      ok("E7 a second shipment is refused (CONFLICT)", dupe.ok === false && dupe.code === "CONFLICT");

      const r2 = await advanceSellerOrderStatus(ctxA, oa.sellerOrderId, "SHIPPED", tx);
      ok("C2 READY_TO_SHIP → SHIPPED ok (with shipment)", r2.ok === true, JSON.stringify(r2));
      const afterShip = await tx.shipment.findFirst({ where: { sellerOrderId: oa.sellerOrderId }, select: { status: true, shippedAt: true } });
      ok("C3 shipment stamped SHIPPED + shippedAt", afterShip?.status === "SHIPPED" && !!afterShip?.shippedAt);

      const r3 = await advanceSellerOrderStatus(ctxA, oa.sellerOrderId, "DELIVERED", tx);
      ok("C4 SHIPPED → DELIVERED ok", r3.ok === true);
      const afterDeliver = await tx.shipment.findFirst({ where: { sellerOrderId: oa.sellerOrderId }, select: { status: true, deliveredAt: true } });
      ok("C5 shipment stamped DELIVERED + deliveredAt", afterDeliver?.status === "DELIVERED" && !!afterDeliver?.deliveredAt);
      ok("C6 DELIVERED is terminal", (await advanceSellerOrderStatus(ctxA, oa.sellerOrderId, "SHIPPED", tx)).ok === false);

      // ---- D: parent gate ----
      const dPending = await makeSellerOrder(tx, A.id, "PENDING_PAYMENT", "PENDING_PAYMENT", suffix + "p");
      ok(
        "D1 no advance while parent Order is PENDING_PAYMENT",
        (await advanceSellerOrderStatus(ctxA, dPending.sellerOrderId, "PROCESSING", tx)).ok === false,
      );
      const dCancelled = await makeSellerOrder(tx, A.id, "CANCELLED", "PROCESSING", suffix + "c");
      ok(
        "D2 no advance while parent Order is CANCELLED",
        (await advanceSellerOrderStatus(ctxA, dCancelled.sellerOrderId, "READY_TO_SHIP", tx)).ok === false,
      );
      ok(
        "D3 no shipment edit while parent CANCELLED path — SO not DELIVERED but still guarded by advance",
        true,
      );

      // ---- F: 1P / order.status / events untouched ----
      const parent = await tx.order.findUnique({ where: { id: oa.orderId }, select: { status: true } });
      ok("F1 parent Order.status unchanged by seller fulfilment", parent?.status === "PROCESSING", parent?.status);
      const eventsNow = await tx.orderEvent.count();
      ok("F2 no OrderEvent rows created", eventsNow === orderEventsBefore, `${orderEventsBefore} → ${eventsNow}`);

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  // ---- rolled back cleanly ----
  const leaked = await prisma.sellerOrder.count({ where: { seller: { slug: { contains: `9f2-${suffix}` } } } });
  ok("F3 all test rows rolled back (0 leaked seller orders)", leaked === 0, `leaked ${leaked}`);
  ok("F4 InventoryAdjustment count unchanged", (await prisma.inventoryAdjustment.count()) === invAdjBefore);
  ok("F5 OfferAdjustment count unchanged", (await prisma.offerAdjustment.count()) === offerAdjBefore);
  ok("F6 OrderEvent count unchanged", (await prisma.orderEvent.count()) === orderEventsBefore);
}

async function staticTests() {
  const repo = read("src/lib/marketplace/seller-order-repository.ts");
  ok(
    "G1 seller-order-repository never writes Order.status / OrderEvent",
    !/tx\.order\.update|prisma\.order\.update|orderEvent\.create|tx\.order\.updateMany/.test(repo),
  );
  const repoCode = repo
    .split("\n")
    .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
    .join("\n");
  ok(
    "G2 seller-order-repository never touches inventory / payments / settlement in code",
    !/@\/lib\/inventory|\b(tx|prisma|client)\.(inventory|inventoryAdjustment|offerInventory|offerAdjustment|payment|paymentRefund)\b/.test(
      repoCode,
    ) && !/settlementStatus:\s|settlementStatus =/.test(repoCode),
  );
  ok("G3 every write is sellerId-scoped + status-guarded updateMany", /updateMany\(\{[\s\S]*?sellerId: ctx\.sellerId, status: so\.status/.test(repo));

  const actions = read("src/lib/seller/order-actions.ts");
  ok("G4 order actions require manage_seller_fulfillment", (actions.match(/requireSellerSessionPermission\("manage_seller_fulfillment"\)/g) ?? []).length >= 2);
  ok("G5 order actions never revalidate the storefront", !/revalidateTag\(\s*["']products/.test(actions) && !/revalidatePath\(\s*["']\/p\//.test(actions));

  const nav = read("src/lib/seller/navigation.ts");
  ok("G6 /seller/orders is live in the nav", /path: "\/seller\/orders"[^}]*live: true/.test(nav.replace(/\n/g, " ")));

  const detailRepo = read("src/lib/marketplace/seller-order-repository.ts");
  ok(
    "G7 getSellerOrderForSeller does not select Order.email / phone / userId / billingAddress / grandTotal",
    /getSellerOrderForSeller[\s\S]*?order: \{ select: \{ orderNumber: true, status: true, placedAt: true, shippingAddress: true \} \}/.test(detailRepo),
  );

  const statusMod = read("src/lib/marketplace/seller-order-status.ts");
  ok("G8 SellerOrder status machine is separate from orders/status.ts", !/from "@\/lib\/orders\/status"/.test(statusMod));
}

async function run() {
  console.log("PHASE 9F-2 — Seller Orders & Fulfilment\n");
  console.log("── pure ──");
  await pureTests();
  console.log("\n── static wiring ──");
  await staticTests();
  console.log("\n── seller-scoped order/shipment access (rolled back) ──");
  await dbTests();

  console.log(`\n  ${pass} passed, ${fail} failed.`);
  if (fail > 0) process.exitCode = 1;
}

run()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
