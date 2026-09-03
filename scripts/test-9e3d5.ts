/**
 * Phase 9E-3D-5 — assertion runner (offer-chain inventory writes).
 *
 * Confirms that offer-native checkout / cancellation / return mutate
 * `OfferInventory` ONLY — no `Inventory` write, no new `InventoryAdjustment`,
 * no `Variant.stock` rewrite — while the legacy fallback still restores
 * `Inventory` for a pre-retirement order.
 *
 * DB tests run inside ONE `prisma.$transaction` that builds fixtures,
 * exercises replicated cores (kept in sync with src/lib/checkout.ts +
 * order-actions.ts + returns-actions.ts + offer-inventory.ts), asserts, then
 * throws to ROLL BACK.
 *
 * Groups (spec §19):
 *   A  offer-native checkout writes OfferInventory only
 *   B  no InventoryAdjustment on a new SALE
 *   C  OfferAdjustment(SALE) created, attributable to Order + Offer + qty
 *   D  offer-native cancellation restores OfferInventory only
 *   E  OfferAdjustment(CANCELLATION) created
 *   F  offer-native return restores OfferInventory only
 *   G  OfferAdjustment(RETURN) created
 *   H  historical cancellation fallback still works
 *   I  historical return fallback still works
 *   J  duplicate cancellation does not restore twice
 *   K  duplicate return does not restore twice
 *   L  OfferInventory adjustment chain reconciles
 *   M  Inventory is not mutated by new offer-native checkout / cancel / return
 *   N  no new InventoryAdjustment row for offer-native operations
 *   O  Variant.stock is not rewritten by the removed mirror paths
 *   P  feature gate remains false
 *
 *   node --env-file=.env --import tsx scripts/test-9e3d5.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
class Rollback extends Error {}
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");

// ── replicated cores — keep in sync with src/lib/{checkout,admin/order-actions,admin/returns-actions}.ts ──
async function offerNativeSale(tx: Prisma.TransactionClient, offerId: string, units: number, orderNumber: string) {
  const l = await tx.$queryRawUnsafe<{ id: string; quantity: number; reserved: number }[]>(
    `SELECT "id","quantity","reserved" FROM "OfferInventory" WHERE "offerId"=$1 FOR UPDATE`, offerId);
  const oi = l[0];
  if (!oi || oi.quantity - units < 0 || oi.quantity - units < oi.reserved) throw new Error("sold out");
  await tx.offerInventory.update({ where: { id: oi.id }, data: { quantity: oi.quantity - units } });
  await tx.offerAdjustment.create({ data: { offerInventoryId: oi.id, previousQuantity: oi.quantity, delta: -units, newQuantity: oi.quantity - units, reason: "SALE", note: `Order ${orderNumber}` } });
}
async function legacySale(tx: Prisma.TransactionClient, variantId: string, units: number, orderNumber: string) {
  const l = await tx.$queryRawUnsafe<{ id: string; quantity: number }[]>(`SELECT "id","quantity" FROM "Inventory" WHERE "variantId"=$1 FOR UPDATE`, variantId);
  const inv = l[0];
  await tx.inventory.update({ where: { id: inv.id }, data: { quantity: inv.quantity - units } });
  await tx.inventoryAdjustment.create({ data: { inventoryId: inv.id, previousQuantity: inv.quantity, delta: -units, newQuantity: inv.quantity - units, reason: "SALE", note: `Order ${orderNumber}` } });
  await tx.$executeRawUnsafe(`UPDATE "Variant" SET "stock"=GREATEST(0, COALESCE((SELECT "quantity"-"reserved" FROM "Inventory" WHERE "variantId"=$1),0)) WHERE "id"=$1`, variantId);
}
async function restoreOffer(tx: Prisma.TransactionClient, offerId: string, units: number, reason: string, note: string) {
  const l = await tx.$queryRawUnsafe<{ id: string; quantity: number }[]>(`SELECT "id","quantity" FROM "OfferInventory" WHERE "offerId"=$1 FOR UPDATE`, offerId);
  const oi = l[0];
  await tx.offerInventory.update({ where: { id: oi.id }, data: { quantity: oi.quantity + units } });
  await tx.offerAdjustment.create({ data: { offerInventoryId: oi.id, previousQuantity: oi.quantity, delta: units, newQuantity: oi.quantity + units, reason, note } });
}
async function adjInv(tx: Prisma.TransactionClient, variantId: string, delta: number, reason: string, note: string) {
  const l = await tx.$queryRawUnsafe<{ id: string; quantity: number }[]>(`SELECT "id","quantity" FROM "Inventory" WHERE "variantId"=$1 FOR UPDATE`, variantId);
  const inv = l[0];
  await tx.inventory.update({ where: { id: inv.id }, data: { quantity: inv.quantity + delta } });
  await tx.inventoryAdjustment.create({ data: { inventoryId: inv.id, previousQuantity: inv.quantity, delta, newQuantity: inv.quantity + delta, reason, note } });
  await tx.$executeRawUnsafe(`UPDATE "Variant" SET "stock"=GREATEST(0, COALESCE((SELECT "quantity"-"reserved" FROM "Inventory" WHERE "variantId"=$1),0)) WHERE "id"=$1`, variantId);
}
async function cancel(tx: Prisma.TransactionClient, orderId: string, orderNumber: string) {
  const c = await tx.$executeRawUnsafe(`UPDATE "Order" SET "status"='CANCELLED', "updatedAt"=now() WHERE "id"=$1 AND "status" IN ('PENDING_PAYMENT','PENDING','PROCESSING')`, orderId);
  if (c === 0) return { units: 0, path: "none" as const };
  const offerNative = (await tx.offerAdjustment.count({ where: { reason: "SALE", note: `Order ${orderNumber}` } })) > 0;
  let units = 0;
  if (offerNative) {
    const items = await tx.orderItem.findMany({ where: { orderId }, select: { id: true, offerId: true, quantity: true } });
    for (const it of items) { if (it.quantity <= 0) continue; if (it.offerId) await restoreOffer(tx, it.offerId, it.quantity, "CANCELLATION", `Order ${orderNumber} cancelled · item ${it.id}`); units += it.quantity; }
  } else {
    const sale = await tx.inventoryAdjustment.findMany({ where: { reason: "SALE", note: `Order ${orderNumber}` }, select: { delta: true, inventory: { select: { variantId: true } } } });
    for (const a of sale) { const q = -a.delta; if (q <= 0) continue; await adjInv(tx, a.inventory.variantId, q, "CANCELLATION", `Order ${orderNumber} cancelled`); units += q; }
  }
  return { units, path: offerNative ? ("offer-native" as const) : ("legacy" as const) };
}
async function receiveReturn(tx: Prisma.TransactionClient, returnId: string, returnNumber: string, orderNumber: string, lines: { returnItemId: string; orderItemId: string; variantId: string; restockQuantity: number }[]) {
  const r = await tx.returnRequest.updateMany({ where: { id: returnId, status: "APPROVED", restockedAt: null }, data: { status: "RECEIVED", restockedAt: new Date() } });
  if (r.count === 0) return { restocked: 0, path: "none" as const };
  const offerNative = (await tx.offerAdjustment.count({ where: { reason: "SALE", note: `Order ${orderNumber}` } })) > 0;
  const byOi = new Map<string, string | null>();
  if (offerNative) { const ois = await tx.orderItem.findMany({ where: { id: { in: lines.map((l) => l.orderItemId) } }, select: { id: true, offerId: true } }); for (const o of ois) byOi.set(o.id, o.offerId); }
  let restocked = 0;
  for (const l of lines) {
    await tx.returnItem.update({ where: { id: l.returnItemId }, data: { restockQuantity: l.restockQuantity } });
    if (l.restockQuantity <= 0) continue;
    const boundOffer = byOi.get(l.orderItemId);
    if (offerNative && boundOffer) { await restoreOffer(tx, boundOffer, l.restockQuantity, "RETURN", `Return ${returnNumber} (order ${orderNumber}) · item ${l.orderItemId}`); restocked += l.restockQuantity; continue; }
    await adjInv(tx, l.variantId, l.restockQuantity, "RETURN", `Return ${returnNumber} (order ${orderNumber})`);
    restocked += l.restockQuantity;
  }
  return { restocked, path: offerNative ? ("offer-native" as const) : ("legacy" as const) };
}

// ── fixtures ──────────────────────────────────────────────────────────────
async function mkFixture(tx: Prisma.TransactionClient, sellerId: string, productId: string, sku: string, qty: number) {
  const v = await tx.variant.create({ data: { productId, sku, price: 1000, status: "ACTIVE", stock: qty }, select: { id: true } });
  await tx.inventory.create({ data: { variantId: v.id, sku, quantity: qty, reserved: 0, reorderPoint: 3 } });
  const o = await tx.offer.create({ data: { sellerId, variantId: v.id, price: 1000, condition: "NEW", status: "ACTIVE", sellerSku: `s-${sku}` }, select: { id: true } });
  await tx.offerInventory.create({ data: { offerId: o.id, sellerSku: `oi-${sku}`, quantity: qty, reserved: 0, reorderPoint: 3 } });
  return { variantId: v.id, offerId: o.id };
}
async function mkOrder(tx: Prisma.TransactionClient, sellerId: string, productId: string, variantId: string, offerId: string, qty: number, sfx: string) {
  const seq = await tx.$queryRawUnsafe<{ v: bigint }[]>(`SELECT nextval('order_number_seq') AS v`);
  const orderNumber = `AX-TEST-${seq[0].v}`;
  const order = await tx.order.create({ data: { orderNumber, email: "t@t.test", status: "PROCESSING", paymentStatus: "PENDING", paymentMethod: "NONE", subtotal: 1000 * qty, shippingFee: 0, discountTotal: 0, grandTotal: 1000 * qty, shippingAddress: "{}" }, select: { id: true } });
  const so = await tx.sellerOrder.create({ data: { orderId: order.id, sellerId, sellerName: "Axiaro", sellerType: "FIRST_PARTY", supportEmail: "s@a.test", commissionRate: 0, shippingFee: 0, merchandiseSubtotal: 1000 * qty, discountAllocated: 0, total: 1000 * qty, status: "PROCESSING", settlementStatus: "PENDING_CAPTURE" }, select: { id: true } });
  const it = await tx.orderItem.create({ data: { orderId: order.id, sellerOrderId: so.id, productId, variantId, offerId, sellerId, commissionRate: 0, name: "Item", sku: `sku-${sfx}`, unitPrice: 1000, quantity: qty, lineTotal: 1000 * qty }, select: { id: true } });
  return { orderId: order.id, orderNumber, orderItemId: it.id };
}
const invOf = (tx: Prisma.TransactionClient, variantId: string) => tx.inventory.findUniqueOrThrow({ where: { variantId }, select: { quantity: true } }).then((x) => x.quantity);
const oiOf = (tx: Prisma.TransactionClient, offerId: string) => tx.offerInventory.findFirstOrThrow({ where: { offerId }, select: { quantity: true } }).then((x) => x.quantity);
const vsOf = (tx: Prisma.TransactionClient, variantId: string) => tx.variant.findUniqueOrThrow({ where: { id: variantId }, select: { stock: true } }).then((x) => x.stock);

async function dbTests() {
  const axiaro = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
  const product = await prisma.product.findFirst({ where: { status: "ACTIVE" }, select: { id: true } });
  if (!axiaro || !product) return ok("(skipped)", true);
  const sfx = "9e3d5-" + Date.now();

  try {
    await prisma.$transaction(async (tx) => {
      // ---- A / B / C / M / N / O — offer-native checkout ----
      const f1 = await mkFixture(tx, axiaro.id, product.id, `a-${sfx}`, 20);
      const o1 = await mkOrder(tx, axiaro.id, product.id, f1.variantId, f1.offerId, 3, sfx);
      const vsBefore = await vsOf(tx, f1.variantId);
      await offerNativeSale(tx, f1.offerId, 3, o1.orderNumber);
      ok("A  offer-native checkout: OfferInventory 20 → 17", (await oiOf(tx, f1.offerId)) === 17);
      ok("M  Inventory UNCHANGED at 20 by the SALE", (await invOf(tx, f1.variantId)) === 20);
      ok("O  Variant.stock NOT rewritten by the SALE (still 20)", (await vsOf(tx, f1.variantId)) === vsBefore && vsBefore === 20);
      const saleOA = await tx.offerAdjustment.findMany({ where: { reason: "SALE", note: `Order ${o1.orderNumber}` }, select: { delta: true, note: true, offerInventoryId: true } });
      const saleIA = await tx.inventoryAdjustment.count({ where: { reason: "SALE", note: `Order ${o1.orderNumber}` } });
      ok("B / N  ZERO SALE InventoryAdjustment for the new order", saleIA === 0);
      ok("C  one SALE OfferAdjustment, delta -3, note identifies the order; row ties to the offer", saleOA.length === 1 && saleOA[0].delta === -3 && saleOA[0].note === `Order ${o1.orderNumber}` && !!saleOA[0].offerInventoryId);

      // ---- D / E / M — offer-native cancellation ----
      const c1 = await cancel(tx, o1.orderId, o1.orderNumber);
      ok("D  offer-native cancel: OfferInventory back to 20, path=offer-native", (await oiOf(tx, f1.offerId)) === 20 && c1.path === "offer-native");
      ok("M  Inventory STILL 20 after cancel (never touched)", (await invOf(tx, f1.variantId)) === 20);
      const cancOA = await tx.offerAdjustment.findMany({ where: { reason: "CANCELLATION", note: { contains: o1.orderNumber } }, select: { delta: true, note: true } });
      const cancIA = await tx.inventoryAdjustment.count({ where: { reason: "CANCELLATION", note: { contains: o1.orderNumber } } });
      ok("E  one OfferAdjustment(CANCELLATION), delta +3, note carries order + item; ZERO InventoryAdjustment", cancOA.length === 1 && cancOA[0].delta === 3 && cancOA[0].note!.includes(o1.orderItemId) && cancIA === 0);

      // ---- J — duplicate cancellation ----
      const before = await oiOf(tx, f1.offerId);
      const c1b = await cancel(tx, o1.orderId, o1.orderNumber);
      ok("J  second cancellation restores 0 additional units", c1b.units === 0 && (await oiOf(tx, f1.offerId)) === before);

      // ---- F / G / M — offer-native return ----
      const f2 = await mkFixture(tx, axiaro.id, product.id, `f-${sfx}`, 10);
      const o2 = await mkOrder(tx, axiaro.id, product.id, f2.variantId, f2.offerId, 5, sfx);
      await offerNativeSale(tx, f2.offerId, 5, o2.orderNumber); // OfferInv 10 → 5
      const ret2 = await tx.returnRequest.create({ data: { returnNumber: `RET-${sfx.slice(-6)}F`, orderId: o2.orderId, status: "APPROVED", reason: "NO_LONGER_NEEDED" }, select: { id: true, returnNumber: true } });
      const ri2 = await tx.returnItem.create({ data: { returnRequestId: ret2.id, orderItemId: o2.orderItemId, productId: product.id, variantId: f2.variantId, name: "Item", unitPrice: 1000, quantity: 5, refundAmount: 5000 }, select: { id: true } });
      const rr2 = await receiveReturn(tx, ret2.id, ret2.returnNumber, o2.orderNumber, [{ returnItemId: ri2.id, orderItemId: o2.orderItemId, variantId: f2.variantId, restockQuantity: 3 }]);
      ok("F  offer-native return: OfferInventory 5 → 8, path=offer-native", (await oiOf(tx, f2.offerId)) === 8 && rr2.path === "offer-native");
      ok("M  Inventory UNCHANGED at 10 by the return", (await invOf(tx, f2.variantId)) === 10);
      const retOA = await tx.offerAdjustment.findMany({ where: { reason: "RETURN", note: { contains: ret2.returnNumber } }, select: { delta: true, note: true } });
      const retIA = await tx.inventoryAdjustment.count({ where: { reason: "RETURN", note: { contains: ret2.returnNumber } } });
      ok("G  one OfferAdjustment(RETURN), delta +3, note carries return + item; ZERO InventoryAdjustment", retOA.length === 1 && retOA[0].delta === 3 && retOA[0].note!.includes(o2.orderItemId) && retIA === 0);

      // ---- K — duplicate return ----
      const oiBeforeK = await oiOf(tx, f2.offerId);
      const rr2b = await receiveReturn(tx, ret2.id, ret2.returnNumber, o2.orderNumber, [{ returnItemId: ri2.id, orderItemId: o2.orderItemId, variantId: f2.variantId, restockQuantity: 3 }]);
      ok("K  second return receive restocks 0 additional units", rr2b.restocked === 0 && (await oiOf(tx, f2.offerId)) === oiBeforeK);

      // ---- H — historical (legacy) cancellation fallback ----
      const f3 = await mkFixture(tx, axiaro.id, product.id, `h-${sfx}`, 12);
      const o3 = await mkOrder(tx, axiaro.id, product.id, f3.variantId, f3.offerId, 4, sfx);
      await legacySale(tx, f3.variantId, 4, o3.orderNumber); // ONLY Inventory (pre-retirement writer)
      const oiH = await oiOf(tx, f3.offerId);
      const c3 = await cancel(tx, o3.orderId, o3.orderNumber);
      ok("H  legacy cancel: Inventory 8 → 12 restored, OfferInventory UNCHANGED, path=legacy", (await invOf(tx, f3.variantId)) === 12 && (await oiOf(tx, f3.offerId)) === oiH && c3.path === "legacy");
      ok("H  legacy cancel wrote InventoryAdjustment(CANCELLATION) — the documented fallback", (await tx.inventoryAdjustment.count({ where: { reason: "CANCELLATION", note: { contains: o3.orderNumber } } })) === 1);

      // ---- I — historical (legacy) return fallback ----
      const f4 = await mkFixture(tx, axiaro.id, product.id, `i-${sfx}`, 8);
      const o4 = await mkOrder(tx, axiaro.id, product.id, f4.variantId, f4.offerId, 3, sfx);
      await legacySale(tx, f4.variantId, 3, o4.orderNumber);
      const ret4 = await tx.returnRequest.create({ data: { returnNumber: `RET-${sfx.slice(-6)}I`, orderId: o4.orderId, status: "APPROVED", reason: "DAMAGED" }, select: { id: true, returnNumber: true } });
      const ri4 = await tx.returnItem.create({ data: { returnRequestId: ret4.id, orderItemId: o4.orderItemId, productId: product.id, variantId: f4.variantId, name: "Item", unitPrice: 1000, quantity: 3, refundAmount: 3000 }, select: { id: true } });
      const oiI = await oiOf(tx, f4.offerId);
      await receiveReturn(tx, ret4.id, ret4.returnNumber, o4.orderNumber, [{ returnItemId: ri4.id, orderItemId: o4.orderItemId, variantId: f4.variantId, restockQuantity: 3 }]);
      ok("I  legacy return: Inventory 5 → 8 restored, OfferInventory UNCHANGED", (await invOf(tx, f4.variantId)) === 8 && (await oiOf(tx, f4.offerId)) === oiI);

      // ---- L — OfferInventory adjustment chain reconciles (offer-native offers) ----
      const chainRows = await tx.$queryRawUnsafe<{ id: string; quantity: number; opening: number | null; sumdelta: number; n: number }[]>(
        `SELECT oi."id", oi."quantity",
                (SELECT "previousQuantity" FROM "OfferAdjustment" a WHERE a."offerInventoryId"=oi."id" ORDER BY a."createdAt" ASC, a."id" ASC LIMIT 1) AS opening,
                COALESCE((SELECT SUM("delta") FROM "OfferAdjustment" a WHERE a."offerInventoryId"=oi."id"),0)::int AS sumdelta,
                (SELECT COUNT(*) FROM "OfferAdjustment" a WHERE a."offerInventoryId"=oi."id")::int AS n
         FROM "OfferInventory" oi
         WHERE oi."offerId" IN ($1,$2,$3,$4)`, f1.offerId, f2.offerId, f3.offerId, f4.offerId);
      const withHistory = chainRows.filter((r) => r.n > 0);
      ok("L  OfferInventory chain: opening + Σ OfferAdjustment.delta == quantity (f1 SALE+CANCEL nets to 20; f2 SALE-5 RETURN+3 → 8)",
        withHistory.length === 2 && withHistory.every((r) => (r.opening ?? 0) + r.sumdelta === r.quantity), JSON.stringify(chainRows));

      throw new Rollback();
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  ok("ROLLBACK  no fixture variant leaked", (await prisma.variant.count({ where: { sku: { contains: sfx } } })) === 0);
  ok("ROLLBACK  no test order persisted", (await prisma.order.count({ where: { orderNumber: { contains: "AX-TEST-" } } })) === 0);
}

function staticChecks() {
  console.log("\nstatic — offer-native flows write OfferInventory only");
  const checkout = readFileSync(new URL("../src/lib/checkout.ts", import.meta.url), "utf8");
  const cancel = strip(readFileSync(new URL("../src/lib/admin/order-actions.ts", import.meta.url), "utf8"));
  const returns = strip(readFileSync(new URL("../src/lib/admin/returns-actions.ts", import.meta.url), "utf8"));
  const reconcile = readFileSync(new URL("./reconcile-9e3d.ts", import.meta.url), "utf8");
  const co = strip(checkout);

  const offerBranch = (src: string, head: RegExp) => {
    const m = src.match(head);
    if (!m) return "";
    const start = m.index! + m[0].length;
    let depth = 1, i = start;
    while (i < src.length && depth > 0) { const c = src[i++]; if (c === "{") depth++; else if (c === "}") depth--; }
    return src.slice(start, i);
  };

  ok("A/B  checkout.ts SALE commit is commitOfferStockForSale ONLY — no adjustStock, no @/lib/inventory import", /commitOfferStockForSale\s*\(/.test(co) && !/adjustStock\s*\(/.test(co) && !/from ["']@\/lib\/inventory["']/.test(checkout));
  ok("D/E  cancelOrderAction `if (offerNative)` branch writes NO Inventory (no adjustStock / tx.inventory)", (() => {
    const b = offerBranch(cancel, /if\s*\(\s*offerNative\s*\)\s*\{/);
    return b.length > 0 && !/adjustStock\s*\(|tx\.inventory\./.test(b) && /restoreOfferStock\s*\(/.test(b);
  })());
  ok("H  cancelOrderAction keeps the `else` legacy branch with adjustStock + InventoryAdjustment walk", (() => {
    const b = offerBranch(cancel, /\}\s*else\s*\{/);
    return /adjustStock\s*\(/.test(b) && /inventoryAdjustment\.findMany/.test(b) && /reason: "SALE"/.test(b);
  })());
  ok("F/G  receiveReturnAction offer-native line uses restoreOfferStock then `continue` (no Inventory write)", (() => {
    const b = offerBranch(returns, /if\s*\(\s*useOfferPath\s*\)\s*\{/);
    return /restoreOfferStock\s*\(/.test(b) && /continue;/.test(b) && !/adjustStock\s*\(|tx\.inventory\./.test(b);
  })());
  ok("I  receiveReturnAction keeps the legacy adjustStock(RETURN) path for a non-offer line", /adjustStock\s*\([\s\S]{0,120}reason:\s*"RETURN"/.test(returns) && /tx\.inventory\.findUnique/.test(returns));
  ok("reconcile:9e3d distinguishes PRE-RETIREMENT ARCHIVE from POST-RETIREMENT OFFER CHAIN", /POST-RETIREMENT OFFER CHAIN/.test(reconcile) && /PRE-RETIREMENT LEGACY ARCHIVE/.test(reconcile) && /un-moved offers/.test(reconcile));
  ok("reconcile:9e3d treats a moved offer's cross-store divergence as [INFO], not a failure", /\[INFO\][\s\S]{0,120}legitimately diverged/.test(reconcile));
}

async function gateCheck() {
  const g = await prisma.storeSetting.findUnique({ where: { key: "marketplace.multiSellerCheckout" } });
  ok("P  GATE  marketplace.multiSellerCheckout == 'false'", g?.value === "false", g?.value ?? "<absent>");
  ok("P  GATE  PayMongo dormant (0 payments, 0 webhookEvents)", (await prisma.payment.count()) === 0 && (await prisma.webhookEvent.count()) === 0);
}

async function run() {
  await dbTests();
  staticChecks();
  await gateCheck();
  console.log(`\n  ${pass} passed, ${fail} failed.`);
  if (fail > 0) throw new Error(`${fail} Phase 9E-3D-5 check(s) failed.`);
}

run().then(() => console.log("All Phase 9E-3D-5 checks passed."))
  .catch((e) => { console.error(e.message ?? e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
