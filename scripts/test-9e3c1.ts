/**
 * Phase 9E-3C-1 — assertion runner (additive schema + historical backfill).
 *
 * The 9E-3C-1 migration is a DEPLOY BOUNDARY that must not persist during
 * testing, so every DB test runs inside ONE `prisma.$transaction` that applies
 * the migration DDL first (Postgres has transactional DDL), builds a fixture
 * order, runs the backfill logic, asserts, then throws to ROLL BACK — nothing,
 * schema or data, ever persists.
 *
 * The 3 pure mapping helpers below are REPLICATED from
 * scripts/backfill-multiseller-9e3c1.ts and marked "keep in sync" (same
 * convention as scripts/test-9e2.ts).
 *
 * Groups (spec §19):
 *   A  one Order -> one SellerOrder
 *   B  multiple OrderItems -> same SellerOrder
 *   C  Axiaro seller snapshot captured onto the SellerOrder
 *   D  historical total preservation (SellerOrder totals == Order totals; Order row untouched)
 *   E  historical shipping preservation (shippingFee copied, not recomputed)
 *   F  commission == 0 for Axiaro (rate + amount)
 *   G  no accidental duplicate SellerOrders (re-running the backfill is idempotent)
 *   H  schema shape after the DDL (tables / columns / FKs / CHECKs)
 *   I  static: checkout.ts / cancellation / returns / webhook untouched; gate mechanism
 *
 *   node --env-file=.env --import tsx scripts/test-9e3c1.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient, Prisma } from "@prisma/client";

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

class Rollback extends Error {}

// --- keep in sync with scripts/backfill-multiseller-9e3c1.ts ----------------
function roundHalfUp(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}
function mapSellerOrderStatus(s: string): string {
  switch (s) {
    case "PENDING_PAYMENT": return "PENDING_PAYMENT";
    case "PENDING": case "PAID": case "PROCESSING": return "PROCESSING";
    case "SHIPPED": case "OUT_FOR_DELIVERY": return "SHIPPED";
    case "DELIVERED": return "DELIVERED";
    case "CANCELLED": return "CANCELLED";
    default: return "PENDING_PAYMENT";
  }
}
function mapSettlementStatus(p: string): string {
  if (p === "PAID") return "CAPTURED";
  if (p === "REFUNDED") return "REFUNDED";
  return "PENDING_CAPTURE";
}

// --- the 9E-3C-1 migration DDL, run inside the test transaction ------------
// Explicit statements (same pattern as scripts/test-9e2.ts). Keep in sync with
// supabase/migrations/20260904120000_multiseller_order_foundation.sql.
async function applyMigrationDDL(tx: Prisma.TransactionClient) {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS "SellerOrder" (
       "id" TEXT NOT NULL, "orderId" TEXT NOT NULL, "sellerId" TEXT NOT NULL,
       "sellerName" TEXT NOT NULL, "sellerType" TEXT NOT NULL, "supportEmail" TEXT NOT NULL,
       "commissionRate" INTEGER NOT NULL DEFAULT 0,
       "shippingMethodCode" TEXT, "shippingMethodName" TEXT,
       "shippingFee" INTEGER NOT NULL DEFAULT 0, "platformShippingSubsidy" INTEGER NOT NULL DEFAULT 0,
       "freeShippingApplied" BOOLEAN,
       "merchandiseSubtotal" INTEGER NOT NULL DEFAULT 0, "discountAllocated" INTEGER NOT NULL DEFAULT 0,
       "discountFundedBy" TEXT NOT NULL DEFAULT 'PLATFORM',
       "commissionAmount" INTEGER NOT NULL DEFAULT 0, "total" INTEGER NOT NULL DEFAULT 0,
       "status" TEXT NOT NULL DEFAULT 'PENDING_PAYMENT', "settlementStatus" TEXT NOT NULL DEFAULT 'PENDING_CAPTURE',
       "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "SellerOrder_pkey" PRIMARY KEY ("id"))`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "SellerOrder_orderId_sellerId_key" ON "SellerOrder" ("orderId", "sellerId")`,
    `CREATE INDEX IF NOT EXISTS "SellerOrder_orderId_idx" ON "SellerOrder" ("orderId")`,
    `CREATE INDEX IF NOT EXISTS "SellerOrder_sellerId_idx" ON "SellerOrder" ("sellerId")`,
    `CREATE INDEX IF NOT EXISTS "SellerOrder_status_idx" ON "SellerOrder" ("status")`,
    `CREATE INDEX IF NOT EXISTS "SellerOrder_settlementStatus_idx" ON "SellerOrder" ("settlementStatus")`,
    `ALTER TABLE "SellerOrder" DROP CONSTRAINT IF EXISTS "SellerOrder_orderId_fkey"`,
    `ALTER TABLE "SellerOrder" ADD CONSTRAINT "SellerOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    `ALTER TABLE "SellerOrder" DROP CONSTRAINT IF EXISTS "SellerOrder_sellerId_fkey"`,
    `ALTER TABLE "SellerOrder" ADD CONSTRAINT "SellerOrder_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller" ("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
    `ALTER TABLE "SellerOrder" DROP CONSTRAINT IF EXISTS sellerorder_money_nonneg`,
    `ALTER TABLE "SellerOrder" ADD CONSTRAINT sellerorder_money_nonneg CHECK ("merchandiseSubtotal" >= 0 AND "discountAllocated" >= 0 AND "shippingFee" >= 0 AND "platformShippingSubsidy" >= 0 AND "commissionAmount" >= 0 AND "total" >= 0)`,
    `ALTER TABLE "SellerOrder" DROP CONSTRAINT IF EXISTS sellerorder_commission_bps_bounds`,
    `ALTER TABLE "SellerOrder" ADD CONSTRAINT sellerorder_commission_bps_bounds CHECK ("commissionRate" >= 0 AND "commissionRate" <= 10000)`,
    `ALTER TABLE "SellerOrder" DROP CONSTRAINT IF EXISTS sellerorder_total_reconciles`,
    `ALTER TABLE "SellerOrder" ADD CONSTRAINT sellerorder_total_reconciles CHECK ("total" = "merchandiseSubtotal" - "discountAllocated" + "shippingFee")`,
    `CREATE TABLE IF NOT EXISTS "Shipment" (
       "id" TEXT NOT NULL, "sellerOrderId" TEXT NOT NULL,
       "carrier" TEXT, "carrierName" TEXT, "trackingNumber" TEXT, "trackingUrl" TEXT,
       "status" TEXT NOT NULL DEFAULT 'PENDING', "shippedAt" TIMESTAMP(3), "deliveredAt" TIMESTAMP(3), "note" TEXT,
       "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id"))`,
    `CREATE INDEX IF NOT EXISTS "Shipment_sellerOrderId_idx" ON "Shipment" ("sellerOrderId")`,
    `CREATE INDEX IF NOT EXISTS "Shipment_status_idx" ON "Shipment" ("status")`,
    `CREATE INDEX IF NOT EXISTS "Shipment_carrier_idx" ON "Shipment" ("carrier")`,
    `ALTER TABLE "Shipment" DROP CONSTRAINT IF EXISTS "Shipment_sellerOrderId_fkey"`,
    `ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_sellerOrderId_fkey" FOREIGN KEY ("sellerOrderId") REFERENCES "SellerOrder" ("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    `ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "sellerOrderId" TEXT`,
    `ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "sellerId" TEXT`,
    `ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "offerId" TEXT`,
    `ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "commissionRate" INTEGER`,
    `CREATE INDEX IF NOT EXISTS "OrderItem_sellerOrderId_idx" ON "OrderItem" ("sellerOrderId")`,
    `CREATE INDEX IF NOT EXISTS "OrderItem_sellerId_idx" ON "OrderItem" ("sellerId")`,
    `CREATE INDEX IF NOT EXISTS "OrderItem_offerId_idx" ON "OrderItem" ("offerId")`,
    `ALTER TABLE "OrderItem" DROP CONSTRAINT IF EXISTS "OrderItem_sellerOrderId_fkey"`,
    `ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_sellerOrderId_fkey" FOREIGN KEY ("sellerOrderId") REFERENCES "SellerOrder" ("id") ON DELETE SET NULL ON UPDATE CASCADE`,
    `ALTER TABLE "OrderItem" DROP CONSTRAINT IF EXISTS "OrderItem_offerId_fkey"`,
    `ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer" ("id") ON DELETE SET NULL ON UPDATE CASCADE`,
    `ALTER TABLE "OrderItem" DROP CONSTRAINT IF EXISTS orderitem_commission_bps_bounds`,
    `ALTER TABLE "OrderItem" ADD CONSTRAINT orderitem_commission_bps_bounds CHECK ("commissionRate" IS NULL OR ("commissionRate" >= 0 AND "commissionRate" <= 10000))`,
    `ALTER TABLE "SellerOrder" ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE "Shipment" ENABLE ROW LEVEL SECURITY`,
    `REVOKE ALL ON "SellerOrder", "Shipment" FROM anon, authenticated`,
  ];
  for (const s of stmts) await tx.$executeRawUnsafe(s);
}

/** Replicated backfill core for one order (keep in sync with the script). */
async function backfillOrder(
  tx: Prisma.TransactionClient,
  orderId: string,
  axiaro: { id: string; displayName: string; type: string; supportEmail: string },
) {
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { items: { orderBy: { id: "asc" } }, sellerOrders: { select: { id: true } } },
  });
  if (order.sellerOrders.length > 0) return { created: false };

  const reconciled = order.subtotal - order.discountTotal + order.shippingFee;
  if (reconciled !== order.grandTotal) throw new Error(`${order.orderNumber}: does not reconcile`);

  const merchandiseSubtotal = order.subtotal;
  const discountAllocated = order.discountTotal;
  const shippingFee = order.shippingFee;
  const total = merchandiseSubtotal - discountAllocated + shippingFee;

  const itemOfferIds = new Map<string, string | null>();
  for (const it of order.items) {
    if (!it.variantId) { itemOfferIds.set(it.id, null); continue; }
    const offers = await tx.offer.findMany({ where: { variantId: it.variantId, sellerId: axiaro.id }, select: { id: true } });
    itemOfferIds.set(it.id, offers.length === 1 ? offers[0].id : null);
  }

  const so = await tx.sellerOrder.create({
    data: {
      orderId: order.id,
      sellerId: axiaro.id,
      sellerName: axiaro.displayName,
      sellerType: axiaro.type,
      supportEmail: axiaro.supportEmail,
      commissionRate: 0,
      shippingMethodCode: order.shippingMethodCode ?? null,
      shippingMethodName: order.shippingMethodName ?? null,
      shippingFee,
      platformShippingSubsidy: 0,
      freeShippingApplied: null,
      merchandiseSubtotal,
      discountAllocated,
      discountFundedBy: "PLATFORM",
      commissionAmount: roundHalfUp((merchandiseSubtotal * 0) / 10000),
      total,
      status: mapSellerOrderStatus(order.status),
      settlementStatus: mapSettlementStatus(order.paymentStatus),
    },
    select: { id: true },
  });
  for (const it of order.items) {
    await tx.orderItem.update({
      where: { id: it.id },
      data: { sellerOrderId: so.id, sellerId: axiaro.id, offerId: itemOfferIds.get(it.id) ?? null, commissionRate: 0 },
    });
  }
  return { created: true, sellerOrderId: so.id };
}

async function dbTests() {
  const axiaro = await prisma.seller.findFirst({
    where: { type: "FIRST_PARTY" },
    select: { id: true, displayName: true, type: true, supportEmail: true },
  });
  const product = await prisma.product.findFirst({ where: { status: "ACTIVE" }, select: { id: true } });
  if (!axiaro || !product) return ok("(skipped — no seller/product)", true);
  const suffix = "9e3c1-" + Date.now();

  try {
    await prisma.$transaction(
      async (tx) => {
        await applyMigrationDDL(tx);

        console.log("\nH. schema shape after the 9E-3C-1 DDL (inside a rolled-back tx)");
        const soT = (await tx.$queryRawUnsafe(`SELECT 1 FROM information_schema.tables WHERE table_name='SellerOrder'`)) as unknown[];
        const shT = (await tx.$queryRawUnsafe(`SELECT 1 FROM information_schema.tables WHERE table_name='Shipment'`)) as unknown[];
        ok("H  SellerOrder + Shipment tables created", soT.length === 1 && shT.length === 1);
        const oiCols = (await tx.$queryRawUnsafe(
          `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name='OrderItem' AND column_name IN ('sellerOrderId','sellerId','offerId','commissionRate')`,
        )) as { column_name: string; is_nullable: string }[];
        ok("H  OrderItem gained 4 NULLABLE marketplace columns", oiCols.length === 4 && oiCols.every((c) => c.is_nullable === "YES"), JSON.stringify(oiCols));
        const cks = (await tx.$queryRawUnsafe(
          `SELECT conname FROM pg_constraint WHERE conname IN ('sellerorder_money_nonneg','sellerorder_commission_bps_bounds','sellerorder_total_reconciles','orderitem_commission_bps_bounds')`,
        )) as { conname: string }[];
        ok("H  4 CHECK constraints present", cks.length === 4, cks.map((c) => c.conname).join(","));
        const uq = (await tx.$queryRawUnsafe(`SELECT 1 FROM pg_indexes WHERE indexname='SellerOrder_orderId_sellerId_key'`)) as unknown[];
        ok("H  @@unique([orderId, sellerId]) present", uq.length === 1);

        // fixture: a fresh order with TWO items on one Axiaro-owned product
        const v1 = await tx.variant.create({ data: { productId: product.id, sku: `V1-${suffix}`, price: 1000, status: "ACTIVE", stock: 0 }, select: { id: true } });
        const v2 = await tx.variant.create({ data: { productId: product.id, sku: `V2-${suffix}`, price: 2500, status: "ACTIVE", stock: 0 }, select: { id: true } });
        await tx.offer.create({ data: { sellerId: axiaro.id, variantId: v1.id, price: 1000, condition: "NEW", status: "ACTIVE", sellerSku: `s1-${suffix}` } });
        await tx.offer.create({ data: { sellerId: axiaro.id, variantId: v2.id, price: 2500, condition: "NEW", status: "ACTIVE", sellerSku: `s2-${suffix}` } });

        const order = await tx.order.create({
          data: {
            orderNumber: `AX-TEST-${suffix}`,
            email: "t@example.test",
            status: "PROCESSING",
            paymentStatus: "PAID",
            paymentMethod: "CARD",
            subtotal: 6000, // 1000·1 + 2500·2
            shippingFee: 500,
            discountTotal: 0,
            grandTotal: 6500,
            shippingMethod: "STANDARD",
            shippingMethodCode: "STANDARD",
            shippingMethodName: "Standard Delivery",
            shippingAddress: "{}",
            items: {
              create: [
                { productId: product.id, variantId: v1.id, name: "Item One", sku: `V1-${suffix}`, unitPrice: 1000, quantity: 1, lineTotal: 1000 },
                { productId: product.id, variantId: v2.id, name: "Item Two", sku: `V2-${suffix}`, unitPrice: 2500, quantity: 2, lineTotal: 5000 },
              ],
            },
          },
          select: { id: true, subtotal: true, shippingFee: true, discountTotal: true, grandTotal: true, status: true },
        });

        // run the backfill
        const r1 = await backfillOrder(tx, order.id, axiaro);
        const sos = await tx.sellerOrder.findMany({ where: { orderId: order.id }, include: { items: true } });

        console.log("\nA/B. one Order -> one SellerOrder holding all its items");
        ok("A  exactly one SellerOrder created for the order", r1.created === true && sos.length === 1);
        ok("B  both OrderItems linked to that one SellerOrder", sos[0].items.length === 2 && sos[0].items.every((it) => it.sellerOrderId === sos[0].id));

        console.log("\nC. Axiaro seller snapshot");
        ok("C  sellerName / sellerType / supportEmail / commissionRate captured", sos[0].sellerName === axiaro.displayName && sos[0].sellerType === "FIRST_PARTY" && sos[0].supportEmail === axiaro.supportEmail && sos[0].commissionRate === 0);
        ok("C  sellerId snapshot on every OrderItem", sos[0].items.every((it) => it.sellerId === axiaro.id));
        ok("C  offerId resolved for both items (one 1P offer per variant)", sos[0].items.every((it) => it.offerId != null));

        console.log("\nD. historical total preservation");
        ok("D  SellerOrder.merchandiseSubtotal == Order.subtotal (6000)", sos[0].merchandiseSubtotal === order.subtotal);
        ok("D  SellerOrder.discountAllocated == Order.discountTotal (0)", sos[0].discountAllocated === order.discountTotal);
        ok("D  SellerOrder.total == Order.grandTotal (6500)", sos[0].total === order.grandTotal);
        ok("D  total == merch - discount + shipping", sos[0].total === sos[0].merchandiseSubtotal - sos[0].discountAllocated + sos[0].shippingFee);
        const orderAfter = await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { subtotal: true, shippingFee: true, discountTotal: true, grandTotal: true } });
        ok("D  Order economic row UNCHANGED by the backfill", orderAfter.subtotal === 6000 && orderAfter.shippingFee === 500 && orderAfter.discountTotal === 0 && orderAfter.grandTotal === 6500);
        const itemsAfter = await tx.orderItem.findMany({ where: { orderId: order.id }, orderBy: { unitPrice: "asc" } });
        ok("D  OrderItem unit prices / quantities / line totals UNCHANGED", itemsAfter[0].unitPrice === 1000 && itemsAfter[0].quantity === 1 && itemsAfter[1].unitPrice === 2500 && itemsAfter[1].quantity === 2 && itemsAfter[1].lineTotal === 5000);

        console.log("\nE. historical shipping preservation");
        ok("E  shippingFee copied verbatim (500), not recomputed", sos[0].shippingFee === 500);
        ok("E  freeShippingApplied left NULL (not evaluated for history)", sos[0].freeShippingApplied === null);
        ok("E  platformShippingSubsidy == 0 (never inferred)", sos[0].platformShippingSubsidy === 0);
        ok("E  shipping method snapshot copied from the order", sos[0].shippingMethodCode === "STANDARD" && sos[0].shippingMethodName === "Standard Delivery");

        console.log("\nF. commission == 0 for Axiaro");
        ok("F  SellerOrder.commissionRate == 0 and commissionAmount == 0", sos[0].commissionRate === 0 && sos[0].commissionAmount === 0);
        ok("F  every OrderItem.commissionRate == 0", sos[0].items.every((it) => it.commissionRate === 0));

        console.log("\nG. idempotency — re-running the backfill creates no duplicate");
        const r2 = await backfillOrder(tx, order.id, axiaro);
        const sos2 = await tx.sellerOrder.count({ where: { orderId: order.id } });
        ok("G  second backfill is a no-op; still exactly one SellerOrder", r2.created === false && sos2 === 1);

        console.log("\nH. status mapping");
        ok("H  PROCESSING/PAID order -> SellerOrder PROCESSING / CAPTURED", sos[0].status === "PROCESSING" && sos[0].settlementStatus === "CAPTURED");

        console.log("\nH. CHECK constraint actually bites");
        let checkBit = false;
        try {
          await tx.$executeRawUnsafe(
            `INSERT INTO "SellerOrder" ("id","orderId","sellerId","sellerName","sellerType","supportEmail","merchandiseSubtotal","discountAllocated","shippingFee","total","updatedAt") VALUES ('bad-${suffix}', '${order.id}', '${axiaro.id}', 'x', 'FIRST_PARTY', 'x@x.test', 100, 0, 0, 999, now())`,
          );
        } catch {
          checkBit = true;
        }
        ok("H  sellerorder_total_reconciles rejects total != merch - disc + ship", checkBit);

        throw new Rollback();
      },
      { timeout: 25000 },
    );
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  // everything rolled back — schema + data
  const leakedVariant = await prisma.variant.count({ where: { sku: { contains: suffix } } });
  const leakedOrder = await prisma.order.count({ where: { orderNumber: { contains: suffix } } });
  const soTableGone = (await prisma.$queryRawUnsafe(`SELECT 1 FROM information_schema.tables WHERE table_name='SellerOrder'`)) as unknown[];
  ok("ROLLBACK  no variant / order fixture leaked", leakedVariant === 0 && leakedOrder === 0, `v=${leakedVariant} o=${leakedOrder}`);
  // NB: soTableGone is only meaningful pre-migration; after the real migration is applied it will (correctly) exist.
  console.log(`  (SellerOrder table currently ${soTableGone.length === 1 ? "EXISTS — real migration already applied" : "absent — pre-migration"})`);
}

function staticChecks() {
  console.log("\nI. checkout writer / cancellation / returns / webhook untouched (file inspection)");
  const checkout = readFileSync(new URL("../src/lib/checkout.ts", import.meta.url), "utf8");
  const orderActions = readFileSync(new URL("../src/lib/admin/order-actions.ts", import.meta.url), "utf8");
  const returnsActions = readFileSync(new URL("../src/lib/admin/returns-actions.ts", import.meta.url), "utf8");
  const webhook = readFileSync(new URL("../src/lib/payments/webhook.ts", import.meta.url), "utf8");
  const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  const registry = readFileSync(new URL("../src/lib/admin/settings-registry.ts", import.meta.url), "utf8");

  ok("I  checkout order line still built from v.price (writer NOT switched yet)", /unitPrice: v\.price/.test(checkout));
  ok("I  createOrderFromCart does not create a SellerOrder", !/sellerOrder\.create|tx\.sellerOrder/.test(checkout));
  ok("I  cancelOrderAction untouched (still note-string reversal)", /reason: "SALE", note: `Order \$\{order\.orderNumber\}`/.test(orderActions) || /note: `Order \$\{order\.orderNumber\}`/.test(orderActions));
  ok("I  order-actions does not touch SellerOrder / OfferInventory", !/sellerOrder|offerInventory/i.test(orderActions));
  ok("I  returns-actions does not touch SellerOrder / OfferInventory", !/sellerOrder|offerInventory/i.test(returnsActions));
  ok("I  webhook does not touch SellerOrder", !/sellerOrder/i.test(webhook));
  ok("I  schema has SellerOrder + Shipment models", /model SellerOrder \{/.test(schema) && /model Shipment \{/.test(schema));
  ok("I  OrderItem marketplace columns are optional (String? / Int?)", /sellerOrderId\s+String\?/.test(schema) && /offerId\s+String\?/.test(schema) && /commissionRate\s+Int\?/.test(schema));
  ok("I  marketplace.multiSellerCheckout is NOT in SETTINGS_REGISTRY (no admin UI yet)", !/marketplace\.multiSellerCheckout/.test(registry));
}

async function run() {
  await dbTests();
  staticChecks();
  console.log(`\n  ${pass} passed, ${fail} failed.`);
  if (fail > 0) throw new Error(`${fail} Phase 9E-3C-1 check(s) failed.`);
}

run()
  .then(() => console.log("All Phase 9E-3C-1 checks passed."))
  .catch((e) => {
    console.error(e.message ?? e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
