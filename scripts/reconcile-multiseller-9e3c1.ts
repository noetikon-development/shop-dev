/**
 * Phase 9E-3C-1 — schema + backfill reconciliation. READ-ONLY.
 *
 * Auto-detects migration state (does the SellerOrder table exist?):
 *
 *   PRE-migration  -> verifies the DB is SAFE to migrate + backfill:
 *       every Order reconciles: subtotal - discountTotal + shippingFee == grandTotal
 *       exactly one FIRST_PARTY seller exists
 *
 *   POST-migration -> verifies the schema + backfill landed cleanly:
 *       SellerOrder / Shipment tables + indexes + FKs + CHECKs present
 *       OrderItem gained sellerOrderId / sellerId / offerId / commissionRate (nullable)
 *       every Order has EXACTLY ONE SellerOrder, all Axiaro FIRST_PARTY
 *       every OrderItem: sellerOrderId set, sellerId == Axiaro, commissionRate == 0
 *       per Order: SellerOrder.merchandiseSubtotal/discountAllocated/shippingFee/total
 *                  == Order.subtotal/discountTotal/shippingFee/grandTotal
 *       Σ SellerOrder.total per Order == Order.grandTotal
 *       commissionAmount == 0 everywhere; Shipments == 0
 *       marketplace.multiSellerCheckout == false
 *
 * Both states: Order / OrderItem counts + economics vs the 9E-2 baseline.
 *
 * Exit 1 on any failure.
 *   node --env-file=.env --import tsx scripts/reconcile-multiseller-9e3c1.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    fail++;
    console.error(`  [FAIL] ${name}   ${detail}`);
  }
};

const q = (sql: string) => prisma.$queryRawUnsafe(sql) as Promise<Record<string, unknown>[]>;

async function run() {
  console.log("PHASE 9E-3C-1 — schema + backfill reconciliation\n");

  const soTable = await q(
    `SELECT 1 FROM information_schema.tables WHERE table_name = 'SellerOrder'`,
  );
  const applied = soTable.length === 1;
  console.log(`  migration state: ${applied ? "APPLIED (post-9E-3C-1)" : "NOT APPLIED (pre-9E-3C-1)"}\n`);

  // ── shared: historical reconciliation (must hold in BOTH states) ─────────
  // Explicit select of PRE-EXISTING columns only — the generated client now
  // knows the new OrderItem columns, but this must also run pre-migration.
  const orders = await prisma.order.findMany({
    orderBy: { placedAt: "asc" },
    select: {
      id: true, orderNumber: true, status: true, paymentStatus: true,
      subtotal: true, discountTotal: true, shippingFee: true, grandTotal: true,
      shippingMethodCode: true, shippingMethodName: true,
      items: {
        select: { id: true, orderId: true, variantId: true, name: true, unitPrice: true, quantity: true, lineTotal: true },
      },
    },
  });
  let recFail = 0;
  for (const o of orders) {
    if (o.subtotal - o.discountTotal + o.shippingFee !== o.grandTotal) {
      recFail++;
      console.error(
        `    ${o.orderNumber}: ${o.subtotal} - ${o.discountTotal} + ${o.shippingFee} != ${o.grandTotal}`,
      );
    }
  }
  check("every Order reconciles (subtotal - discount + shipping == grandTotal)", recFail === 0, `${recFail} failed`);

  const sellers = await prisma.seller.findMany({ select: { id: true, type: true } });
  const fp = sellers.filter((s) => s.type === "FIRST_PARTY");
  check("exactly one FIRST_PARTY seller", fp.length === 1, `found ${fp.length}`);
  const axiaroId = fp[0]?.id;

  // ── baseline immutability ──────────────────────────────────────────────
  const baseline = {
    orders: orders.length,
    orderItems: orders.reduce((n, o) => n + o.items.length, 0),
    sellers: sellers.length,
    offers: await prisma.offer.count(),
    offerInventory: await prisma.offerInventory.count(),
    inventory: await prisma.inventory.count(),
    payments: await prisma.payment.count(),
    returnRequests: await prisma.returnRequest.count(),
  };
  console.log(`\n  counts: ${JSON.stringify(baseline)}\n`);
  check("Order count == 3 (9E-2 baseline)", baseline.orders === 3, String(baseline.orders));
  check("OrderItem count == 3 (9E-2 baseline)", baseline.orderItems === 3, String(baseline.orderItems));
  check("Seller count == 1", baseline.sellers === 1, String(baseline.sellers));
  check("Offer / OfferInventory / Inventory == 328 / 328 / 328", baseline.offers === 328 && baseline.offerInventory === 328 && baseline.inventory === 328, JSON.stringify(baseline));
  check("Payment count == 0 (PayMongo dormant)", baseline.payments === 0);

  if (!applied) {
    check("READY: backfill will succeed (all orders reconcile, 1 FIRST_PARTY seller)", recFail === 0 && fp.length === 1);
    console.log(`\n  ${pass} passed, ${fail} failed.`);
    if (fail > 0) {
      console.error("\nRECONCILIATION FAILED.");
      process.exitCode = 1;
    } else {
      console.log("\nRECONCILIATION PASSED — DB is SAFE to apply the 9E-3C-1 migration + backfill.");
    }
    return;
  }

  // ── POST: schema shape ────────────────────────────────────────────────
  const shipTable = await q(`SELECT 1 FROM information_schema.tables WHERE table_name = 'Shipment'`);
  check("Shipment table present", shipTable.length === 1);

  const oiCols = (await q(
    `SELECT column_name, is_nullable FROM information_schema.columns
     WHERE table_name = 'OrderItem' AND column_name IN ('sellerOrderId','sellerId','offerId','commissionRate')`,
  )) as { column_name: string; is_nullable: string }[];
  check("OrderItem gained all 4 marketplace columns", oiCols.length === 4, JSON.stringify(oiCols));
  check("OrderItem marketplace columns are NULLABLE", oiCols.every((c) => c.is_nullable === "YES"));

  const idx = (await q(
    `SELECT indexname FROM pg_indexes WHERE tablename IN ('SellerOrder','Shipment','OrderItem')
     AND indexname IN ('SellerOrder_orderId_sellerId_key','SellerOrder_orderId_idx','SellerOrder_sellerId_idx',
                       'SellerOrder_status_idx','SellerOrder_settlementStatus_idx',
                       'Shipment_sellerOrderId_idx','Shipment_status_idx','Shipment_carrier_idx',
                       'OrderItem_sellerOrderId_idx','OrderItem_sellerId_idx','OrderItem_offerId_idx')`,
  )) as { indexname: string }[];
  check("all 11 new indexes present", idx.length === 11, `${idx.length}: ${idx.map((i) => i.indexname).join(", ")}`);

  const fks = (await q(
    `SELECT tc.constraint_name, rc.delete_rule
     FROM information_schema.table_constraints tc
     JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name
     WHERE tc.constraint_name IN ('SellerOrder_orderId_fkey','SellerOrder_sellerId_fkey',
                                  'Shipment_sellerOrderId_fkey','OrderItem_sellerOrderId_fkey','OrderItem_offerId_fkey')`,
  )) as { constraint_name: string; delete_rule: string }[];
  const fkRule = (n: string) => fks.find((f) => f.constraint_name === n)?.delete_rule;
  check("FK SellerOrder.orderId -> Order ON DELETE CASCADE", fkRule("SellerOrder_orderId_fkey") === "CASCADE", fkRule("SellerOrder_orderId_fkey"));
  check("FK SellerOrder.sellerId -> Seller ON DELETE RESTRICT (NO ACTION)", ["RESTRICT", "NO ACTION"].includes(fkRule("SellerOrder_sellerId_fkey") ?? ""), fkRule("SellerOrder_sellerId_fkey"));
  check("FK Shipment.sellerOrderId -> SellerOrder ON DELETE CASCADE", fkRule("Shipment_sellerOrderId_fkey") === "CASCADE", fkRule("Shipment_sellerOrderId_fkey"));
  check("FK OrderItem.sellerOrderId -> SellerOrder ON DELETE SET NULL", fkRule("OrderItem_sellerOrderId_fkey") === "SET NULL", fkRule("OrderItem_sellerOrderId_fkey"));
  check("FK OrderItem.offerId -> Offer ON DELETE SET NULL", fkRule("OrderItem_offerId_fkey") === "SET NULL", fkRule("OrderItem_offerId_fkey"));

  const checks = (await q(
    `SELECT conname FROM pg_constraint WHERE conname IN
      ('sellerorder_money_nonneg','sellerorder_commission_bps_bounds','sellerorder_total_reconciles','orderitem_commission_bps_bounds')`,
  )) as { conname: string }[];
  check("all 4 CHECK constraints present", checks.length === 4, checks.map((c) => c.conname).join(", "));

  const rls = (await q(
    `SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('SellerOrder','Shipment')`,
  )) as { relname: string; relrowsecurity: boolean }[];
  check("RLS enabled on SellerOrder + Shipment", rls.length === 2 && rls.every((r) => r.relrowsecurity === true));

  // ── POST: backfill correctness ────────────────────────────────────────
  const sellerOrders = await prisma.sellerOrder.findMany({
    include: { items: true, seller: { select: { type: true } }, shipments: true },
  });
  const soByOrder = new Map<string, typeof sellerOrders>();
  for (const so of sellerOrders) {
    const arr = soByOrder.get(so.orderId) ?? [];
    arr.push(so);
    soByOrder.set(so.orderId, arr);
  }
  check("SellerOrder count == Order count (exactly 1 per Order)", sellerOrders.length === orders.length, `${sellerOrders.length} vs ${orders.length}`);
  check("every Order has exactly one SellerOrder", orders.every((o) => (soByOrder.get(o.id)?.length ?? 0) === 1));
  check("every SellerOrder is Axiaro FIRST_PARTY", sellerOrders.every((so) => so.sellerType === "FIRST_PARTY" && so.seller.type === "FIRST_PARTY" && so.sellerId === axiaroId));
  check("no SellerOrder has a Shipment (0 backfilled)", sellerOrders.every((so) => so.shipments.length === 0));

  const allItems = await prisma.orderItem.findMany();
  check("every OrderItem has a sellerOrderId", allItems.every((it) => it.sellerOrderId != null));
  check("every OrderItem.sellerId == Axiaro", allItems.every((it) => it.sellerId === axiaroId));
  check("every OrderItem.commissionRate == 0", allItems.every((it) => it.commissionRate === 0));
  const withOffer = allItems.filter((it) => it.offerId != null).length;
  console.log(`\n  OrderItems with a resolved offerId: ${withOffer} / ${allItems.length}`);

  // per-order money preservation
  let moneyFail = 0;
  for (const o of orders) {
    const so = soByOrder.get(o.id)?.[0];
    if (!so) { moneyFail++; continue; }
    const okMoney =
      so.merchandiseSubtotal === o.subtotal &&
      so.discountAllocated === o.discountTotal &&
      so.shippingFee === o.shippingFee &&
      so.total === o.grandTotal &&
      so.commissionAmount === 0 &&
      so.platformShippingSubsidy === 0 &&
      so.freeShippingApplied === null &&
      so.discountFundedBy === "PLATFORM" &&
      so.total === so.merchandiseSubtotal - so.discountAllocated + so.shippingFee;
    if (!okMoney) {
      moneyFail++;
      console.error(`    ${o.orderNumber}: SO ${JSON.stringify({ m: so.merchandiseSubtotal, d: so.discountAllocated, s: so.shippingFee, t: so.total })} vs Order ${JSON.stringify({ sub: o.subtotal, disc: o.discountTotal, ship: o.shippingFee, grand: o.grandTotal })}`);
    }
    // Σ SellerOrder.total per order == Order.grandTotal
    const sumTotal = (soByOrder.get(o.id) ?? []).reduce((n, s) => n + s.total, 0);
    if (sumTotal !== o.grandTotal) {
      moneyFail++;
      console.error(`    ${o.orderNumber}: Σ SellerOrder.total ${sumTotal} != grandTotal ${o.grandTotal}`);
    }
  }
  check("historical money preserved (per-order + Σ reconciliation)", moneyFail === 0, `${moneyFail} failures`);

  // OrderItem economics untouched
  const knownPrices: Record<string, { unitPrice: number; quantity: number; lineTotal: number }> = {
    "AX-240418-7731": { unitPrice: 3299000, quantity: 1, lineTotal: 3299000 },
    "AX-240506-9142": { unitPrice: 429000, quantity: 2, lineTotal: 858000 },
    "AX-260902-100023": { unitPrice: 319000, quantity: 1, lineTotal: 319000 },
  };
  let priceFail = 0;
  for (const o of orders) {
    const expected = knownPrices[o.orderNumber];
    if (!expected) continue;
    const it = o.items[0];
    if (!it || it.unitPrice !== expected.unitPrice || it.quantity !== expected.quantity || it.lineTotal !== expected.lineTotal) {
      priceFail++;
      console.error(`    ${o.orderNumber}: item ${JSON.stringify({ u: it?.unitPrice, q: it?.quantity, l: it?.lineTotal })} != ${JSON.stringify(expected)}`);
    }
  }
  check("historical OrderItem unit prices / quantities / line totals unchanged", priceFail === 0, `${priceFail} changed`);

  // status mapping sanity
  const statusOk = orders.every((o) => {
    const so = soByOrder.get(o.id)?.[0];
    if (!so) return false;
    const map: Record<string, string> = {
      PENDING_PAYMENT: "PENDING_PAYMENT", PENDING: "PROCESSING", PAID: "PROCESSING", PROCESSING: "PROCESSING",
      SHIPPED: "SHIPPED", OUT_FOR_DELIVERY: "SHIPPED", DELIVERED: "DELIVERED", CANCELLED: "CANCELLED",
    };
    return so.status === (map[o.status] ?? "PENDING_PAYMENT");
  });
  check("SellerOrder.status reflects the approved historical mapping", statusOk);

  // feature gate
  const gate = await prisma.storeSetting.findUnique({ where: { key: "marketplace.multiSellerCheckout" } });
  check("marketplace.multiSellerCheckout == 'false'", gate?.value === "false", `value = ${gate?.value ?? "<absent>"}`);

  console.log(`\n  ${pass} passed, ${fail} failed.`);
  if (fail > 0) {
    console.error("\nRECONCILIATION FAILED.");
    process.exitCode = 1;
  } else {
    console.log("\nRECONCILIATION PASSED — 9E-3C-1 schema + backfill are coherent; historical economics unchanged.");
  }
}

run()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
