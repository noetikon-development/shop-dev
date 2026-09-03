/**
 * Phase 9E-3D-1 — assertion runner (inventory reversal authority).
 *
 * `src/lib/admin/order-actions.ts` and `returns-actions.ts` pull in
 * `next/navigation` (via `requirePermission` → auth), so the CANCELLATION and
 * RETURN reversal cores below are REPLICATED and marked "keep in sync with
 * src/lib/admin/{order-actions,returns-actions}.ts + src/lib/marketplace/offer-inventory.ts".
 * Every DB test runs inside ONE `prisma.$transaction` that builds fixtures,
 * exercises the replicated logic, asserts, then throws to ROLL BACK.
 *
 * Groups (spec §16 / §17):
 *   A  offer-native order cancellation → both stores restored, parity, net 0
 *   B  cancellation restores only the order's quantities (unrelated variant untouched)
 *   C  offer-native return receipt → both stores restored, parity
 *   D  duplicate cancellation → 0 additional units (atomic Order.status gate)
 *   E  duplicate return receive → 0 additional units (ReturnRequest.restockedAt)
 *   F  legacy order (no SALE OfferAdjustment) cancel → Inventory only, no OfferInventory change
 *   G  legacy return → Inventory only
 *   H  a failing Inventory reversal rolls back the OfferInventory restore too
 *   I  OfferAdjustment(CANCELLATION) created with order/item note
 *   J  OfferAdjustment(RETURN) created with return/item note
 *   K  sequential SALE → admin adjust → cancel: final parity, no negative stock
 *   L  sequential SALE → cancel → admin adjust: final parity
 *   M  lock order is OfferInventory → Inventory (static source check)
 *   N  no OfferInventory/Inventory divergence after cancellation
 *   O  no OfferInventory/Inventory divergence after return
 *
 *   node --env-file=.env --import tsx scripts/test-9e3d1.ts
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

// ── keep in sync with src/lib/marketplace/offer-inventory.ts ───────────────
async function commitOfferSale(tx: Prisma.TransactionClient, offerId: string, units: number, note: string) {
  const l = await tx.$queryRawUnsafe<{ id: string; quantity: number; reserved: number }[]>(
    `SELECT "id","quantity","reserved" FROM "OfferInventory" WHERE "offerId"=$1 FOR UPDATE`, offerId);
  const oi = l[0];
  if (!oi || oi.quantity - units < 0 || oi.quantity - units < oi.reserved) throw new Error("oversell");
  await tx.offerInventory.update({ where: { id: oi.id }, data: { quantity: oi.quantity - units } });
  await tx.offerAdjustment.create({ data: { offerInventoryId: oi.id, previousQuantity: oi.quantity, delta: -units, newQuantity: oi.quantity - units, reason: "SALE", note } });
}
async function restoreOffer(tx: Prisma.TransactionClient, offerId: string, units: number, reason: string, note: string) {
  const l = await tx.$queryRawUnsafe<{ id: string; quantity: number }[]>(
    `SELECT "id","quantity" FROM "OfferInventory" WHERE "offerId"=$1 FOR UPDATE`, offerId);
  const oi = l[0];
  if (!oi) throw new Error("no offer inventory");
  await tx.offerInventory.update({ where: { id: oi.id }, data: { quantity: oi.quantity + units } });
  await tx.offerAdjustment.create({ data: { offerInventoryId: oi.id, previousQuantity: oi.quantity, delta: units, newQuantity: oi.quantity + units, reason, note } });
}
// legacy Inventory primitive (mirror of src/lib/inventory.ts adjustStock)
async function adjInv(tx: Prisma.TransactionClient, variantId: string, delta: number, reason: string, note: string, opts?: { failLow?: boolean }) {
  const l = await tx.$queryRawUnsafe<{ id: string; quantity: number; reserved: number }[]>(
    `SELECT "id","quantity","reserved" FROM "Inventory" WHERE "variantId"=$1 FOR UPDATE`, variantId);
  const inv = l[0];
  if (!inv) return { ok: false as const };
  const nq = inv.quantity + delta;
  if (nq < 0 || nq < inv.reserved || opts?.failLow) return { ok: false as const };
  await tx.inventory.update({ where: { id: inv.id }, data: { quantity: nq } });
  await tx.inventoryAdjustment.create({ data: { inventoryId: inv.id, previousQuantity: inv.quantity, delta, newQuantity: nq, reason, note } });
  await tx.$executeRawUnsafe(`UPDATE "Variant" SET "stock"=GREATEST(0, COALESCE((SELECT "quantity"-"reserved" FROM "Inventory" WHERE "variantId"=$1),0)) WHERE "id"=$1`, variantId);
  return { ok: true as const };
}

// ── keep in sync with src/lib/admin/order-actions.ts cancelOrderAction ─────
async function cancelReversal(tx: Prisma.TransactionClient, orderId: string, orderNumber: string, opts?: { failInvMirror?: boolean }) {
  const cancelled = await tx.$executeRawUnsafe(
    `UPDATE "Order" SET "status"='CANCELLED', "updatedAt"=now() WHERE "id"=$1 AND "status" IN ('PENDING_PAYMENT','PENDING','PROCESSING')`, orderId);
  if (cancelled === 0) return { restockedUnits: 0, path: "none" as const };

  const offerNative = (await tx.offerAdjustment.count({ where: { reason: "SALE", note: `Order ${orderNumber}` } })) > 0;

  // 2a. OfferInventory — offer-native only, per OrderItem.offerId. Locked FIRST.
  if (offerNative) {
    const items = await tx.orderItem.findMany({ where: { orderId, offerId: { not: null } }, select: { id: true, offerId: true, quantity: true } });
    for (const it of items) {
      if (!it.offerId || it.quantity <= 0) continue;
      await restoreOffer(tx, it.offerId, it.quantity, "CANCELLATION", `Order ${orderNumber} cancelled · item ${it.id}`);
    }
  }
  // 2b. Inventory — one CANCELLATION per SALE InventoryAdjustment. Locked AFTER.
  const saleAdj = await tx.inventoryAdjustment.findMany({
    where: { reason: "SALE", note: `Order ${orderNumber}` },
    select: { delta: true, inventory: { select: { variantId: true } } },
  });
  let restockedUnits = 0;
  for (const a of saleAdj) {
    const qty = -a.delta;
    if (qty <= 0) continue;
    const r = await adjInv(tx, a.inventory.variantId, qty, "CANCELLATION", `Order ${orderNumber} cancelled`, { failLow: opts?.failInvMirror });
    if (!r.ok) throw new Error("inventory reversal failed");
    restockedUnits += qty;
  }
  return { restockedUnits, path: offerNative ? ("offer-native" as const) : ("legacy" as const) };
}

// ── keep in sync with src/lib/admin/returns-actions.ts receiveReturnAction ──
async function returnRestock(tx: Prisma.TransactionClient, returnId: string, returnNumber: string, orderNumber: string, lines: { returnItemId: string; orderItemId: string | null; variantId: string | null; restockQuantity: number }[]) {
  const res = await tx.returnRequest.updateMany({ where: { id: returnId, status: "APPROVED", restockedAt: null }, data: { status: "RECEIVED", restockedAt: new Date() } });
  if (res.count === 0) return { restocked: 0, path: "none" as const };

  const offerNative = (await tx.offerAdjustment.count({ where: { reason: "SALE", note: `Order ${orderNumber}` } })) > 0;
  const oiIds = lines.map((l) => l.orderItemId).filter(Boolean) as string[];
  const offerByOi = new Map<string, string | null>();
  if (offerNative && oiIds.length) {
    const ois = await tx.orderItem.findMany({ where: { id: { in: oiIds } }, select: { id: true, offerId: true } });
    for (const o of ois) offerByOi.set(o.id, o.offerId);
  }
  let restocked = 0;
  for (const l of lines) {
    await tx.returnItem.update({ where: { id: l.returnItemId }, data: { restockQuantity: l.restockQuantity } });
    if (l.restockQuantity <= 0) continue;
    const boundOffer = l.orderItemId ? offerByOi.get(l.orderItemId) : undefined;
    const useOffer = offerNative && boundOffer;
    if (useOffer) await restoreOffer(tx, boundOffer!, l.restockQuantity, "RETURN", `Return ${returnNumber} (order ${orderNumber}) · item ${l.orderItemId}`);
    if (l.variantId) {
      const r = await adjInv(tx, l.variantId, l.restockQuantity, "RETURN", `Return ${returnNumber} (order ${orderNumber})`);
      if (!r.ok && !useOffer) continue;
    }
    restocked += l.restockQuantity;
  }
  return { restocked, path: offerNative ? ("offer-native" as const) : ("legacy" as const) };
}

// ── fixtures ──────────────────────────────────────────────────────────────
async function mkFixture(tx: Prisma.TransactionClient, sellerId: string, productId: string, sku: string, qty: number) {
  const v = await tx.variant.create({ data: { productId, sku, price: 1000, status: "ACTIVE", stock: qty }, select: { id: true } });
  await tx.inventory.create({ data: { variantId: v.id, sku, quantity: qty, reserved: 0, reorderPoint: 3 } });
  const o = await tx.offer.create({ data: { sellerId, variantId: v.id, price: 1000, condition: "NEW", status: "ACTIVE", sellerSku: `s-${Math.random().toString(36).slice(2, 9)}` }, select: { id: true } });
  await tx.offerInventory.create({ data: { offerId: o.id, sellerSku: `oi-${Math.random().toString(36).slice(2, 9)}`, quantity: qty, reserved: 0, reorderPoint: 3 } });
  return { variantId: v.id, offerId: o.id };
}
async function parity(tx: Prisma.TransactionClient, variantId: string, offerId: string) {
  const inv = await tx.inventory.findUniqueOrThrow({ where: { variantId }, select: { quantity: true, reserved: true } });
  const oi = (await tx.offerInventory.findFirstOrThrow({ where: { offerId }, select: { quantity: true, reserved: true } }));
  const vs = await tx.variant.findUniqueOrThrow({ where: { id: variantId }, select: { stock: true } });
  return { equal: inv.quantity === oi.quantity && inv.reserved === oi.reserved, invQ: inv.quantity, oiQ: oi.quantity, mirror: vs.stock === Math.max(0, inv.quantity - inv.reserved) };
}
async function mkOrder(tx: Prisma.TransactionClient, sellerId: string, productId: string, variantId: string, offerId: string | null, qty: number, sfx: string) {
  const seq = await tx.$queryRawUnsafe<{ v: bigint }[]>(`SELECT nextval('order_number_seq') AS v`);
  const orderNumber = `AX-TEST-${seq[0].v}`;
  const order = await tx.order.create({
    data: { orderNumber, email: "t@t.test", status: "PROCESSING", paymentStatus: "PENDING", paymentMethod: "NONE", subtotal: 1000 * qty, shippingFee: 0, discountTotal: 0, grandTotal: 1000 * qty, shippingAddress: "{}" },
    select: { id: true },
  });
  const so = await tx.sellerOrder.create({ data: { orderId: order.id, sellerId, sellerName: "Axiaro", sellerType: "FIRST_PARTY", supportEmail: "s@a.test", commissionRate: 0, shippingFee: 0, merchandiseSubtotal: 1000 * qty, discountAllocated: 0, total: 1000 * qty, status: "PROCESSING", settlementStatus: "PENDING_CAPTURE" }, select: { id: true } });
  const it = await tx.orderItem.create({ data: { orderId: order.id, sellerOrderId: so.id, productId, variantId, offerId, sellerId: offerId ? sellerId : null, commissionRate: offerId ? 0 : null, name: "Item", sku: `sku-${sfx}`, unitPrice: 1000, quantity: qty, lineTotal: 1000 * qty }, select: { id: true } });
  return { orderId: order.id, orderNumber, orderItemId: it.id };
}

async function dbTests() {
  const axiaro = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
  const product = await prisma.product.findFirst({ where: { status: "ACTIVE" }, select: { id: true } });
  if (!axiaro || !product) return ok("(skipped)", true);
  const sfx = "9e3d1-" + Date.now();

  try {
    await prisma.$transaction(async (tx) => {
      // ---- A / I / N — offer-native cancellation ----
      const f1 = await mkFixture(tx, axiaro.id, product.id, `v1-${sfx}`, 20);
      const o1 = await mkOrder(tx, axiaro.id, product.id, f1.variantId, f1.offerId, 3, sfx);
      await commitOfferSale(tx, f1.offerId, 3, `Order ${o1.orderNumber}`);
      await adjInv(tx, f1.variantId, -3, "SALE", `Order ${o1.orderNumber}`);
      let p = await parity(tx, f1.variantId, f1.offerId);
      ok("A  after SALE both stores at 17, parity", p.equal && p.oiQ === 17, JSON.stringify(p));

      const c1 = await cancelReversal(tx, o1.orderId, o1.orderNumber);
      p = await parity(tx, f1.variantId, f1.offerId);
      ok("A  after cancel both stores back to 20, parity restored (net 0)", p.equal && p.oiQ === 20 && c1.path === "offer-native", JSON.stringify({ p, c1 }));
      ok("N  no divergence after cancellation (mirror ok too)", p.equal && p.mirror);
      const cancAdj = await tx.offerAdjustment.findMany({ where: { reason: "CANCELLATION", note: { contains: o1.orderNumber } }, select: { delta: true, note: true } });
      ok("I  OfferAdjustment(CANCELLATION) created, delta +3, note carries order + item", cancAdj.length === 1 && cancAdj[0].delta === 3 && cancAdj[0].note!.includes(o1.orderItemId));

      // ---- D — duplicate cancellation ----
      const before = (await tx.offerInventory.findFirstOrThrow({ where: { offerId: f1.offerId }, select: { quantity: true } })).quantity;
      const c1b = await cancelReversal(tx, o1.orderId, o1.orderNumber);
      const after = (await tx.offerInventory.findFirstOrThrow({ where: { offerId: f1.offerId }, select: { quantity: true } })).quantity;
      ok("D  second cancellation restores 0 additional units", c1b.restockedUnits === 0 && after === before);

      // ---- B — cancel restores only this order's qty; unrelated variant untouched ----
      const f2 = await mkFixture(tx, axiaro.id, product.id, `v2-${sfx}`, 15);
      const f2q = (await tx.offerInventory.findFirstOrThrow({ where: { offerId: f2.offerId }, select: { quantity: true } })).quantity;
      const o2 = await mkOrder(tx, axiaro.id, product.id, f1.variantId, f1.offerId, 2, sfx); // another order on v1
      await commitOfferSale(tx, f1.offerId, 2, `Order ${o2.orderNumber}`);
      await adjInv(tx, f1.variantId, -2, "SALE", `Order ${o2.orderNumber}`);
      await cancelReversal(tx, o2.orderId, o2.orderNumber);
      p = await parity(tx, f1.variantId, f1.offerId);
      const f2after = (await tx.offerInventory.findFirstOrThrow({ where: { offerId: f2.offerId }, select: { quantity: true } })).quantity;
      ok("B  cancel of order-2 restores exactly 2 (v1 back to 20); unrelated v2 unchanged", p.oiQ === 20 && p.equal && f2after === f2q && f2q === 15);

      // ---- C / J / O — offer-native return ----
      const f3 = await mkFixture(tx, axiaro.id, product.id, `v3-${sfx}`, 10);
      const o3 = await mkOrder(tx, axiaro.id, product.id, f3.variantId, f3.offerId, 4, sfx);
      await commitOfferSale(tx, f3.offerId, 4, `Order ${o3.orderNumber}`);
      await adjInv(tx, f3.variantId, -4, "SALE", `Order ${o3.orderNumber}`);
      const ret = await tx.returnRequest.create({ data: { returnNumber: `RET-${sfx.slice(-6)}A`, orderId: o3.orderId, status: "APPROVED", reason: "NO_LONGER_NEEDED" }, select: { id: true, returnNumber: true } });
      const ri = await tx.returnItem.create({ data: { returnRequestId: ret.id, orderItemId: o3.orderItemId, productId: product.id, variantId: f3.variantId, name: "Item", unitPrice: 1000, quantity: 4, refundAmount: 4000 }, select: { id: true } });
      const rr = await returnRestock(tx, ret.id, ret.returnNumber, o3.orderNumber, [{ returnItemId: ri.id, orderItemId: o3.orderItemId, variantId: f3.variantId, restockQuantity: 2 }]);
      p = await parity(tx, f3.variantId, f3.offerId);
      ok("C  return receipt restocks 2 to BOTH stores (6 → 8), parity", p.equal && p.oiQ === 8 && rr.path === "offer-native", JSON.stringify({ p, rr }));
      ok("O  no divergence after return", p.equal && p.mirror);
      const retAdj = await tx.offerAdjustment.findMany({ where: { reason: "RETURN", note: { contains: ret.returnNumber } }, select: { delta: true, note: true } });
      ok("J  OfferAdjustment(RETURN) created, delta +2, note carries return + item", retAdj.length === 1 && retAdj[0].delta === 2 && retAdj[0].note!.includes(o3.orderItemId));

      // ---- E — duplicate return receive ----
      const oiBeforeE = (await tx.offerInventory.findFirstOrThrow({ where: { offerId: f3.offerId }, select: { quantity: true } })).quantity;
      const rrDup = await returnRestock(tx, ret.id, ret.returnNumber, o3.orderNumber, [{ returnItemId: ri.id, orderItemId: o3.orderItemId, variantId: f3.variantId, restockQuantity: 2 }]);
      const oiAfterE = (await tx.offerInventory.findFirstOrThrow({ where: { offerId: f3.offerId }, select: { quantity: true } })).quantity;
      ok("E  second return receive restocks 0 additional units", rrDup.restocked === 0 && oiAfterE === oiBeforeE);

      // ---- F — legacy order cancellation (Inventory-only SALE, no OfferAdjustment) ----
      const f4 = await mkFixture(tx, axiaro.id, product.id, `v4-${sfx}`, 12);
      const o4 = await mkOrder(tx, axiaro.id, product.id, f4.variantId, f4.offerId, 5, sfx);
      await adjInv(tx, f4.variantId, -5, "SALE", `Order ${o4.orderNumber}`); // ONLY Inventory (legacy writer)
      const oiF = (await tx.offerInventory.findFirstOrThrow({ where: { offerId: f4.offerId }, select: { quantity: true } })).quantity;
      const c4 = await cancelReversal(tx, o4.orderId, o4.orderNumber);
      const invF = (await tx.inventory.findUniqueOrThrow({ where: { variantId: f4.variantId }, select: { quantity: true } })).quantity;
      const oiFafter = (await tx.offerInventory.findFirstOrThrow({ where: { offerId: f4.offerId }, select: { quantity: true } })).quantity;
      ok("F  legacy cancel: Inventory 7→12, OfferInventory UNCHANGED at 12, path=legacy", invF === 12 && oiFafter === oiF && oiF === 12 && c4.path === "legacy", JSON.stringify({ invF, oiFafter, c4 }));

      // ---- G — legacy return ----
      const f5 = await mkFixture(tx, axiaro.id, product.id, `v5-${sfx}`, 8);
      const o5 = await mkOrder(tx, axiaro.id, product.id, f5.variantId, f5.offerId, 3, sfx);
      await adjInv(tx, f5.variantId, -3, "SALE", `Order ${o5.orderNumber}`); // legacy SALE
      const ret5 = await tx.returnRequest.create({ data: { returnNumber: `RET-${sfx.slice(-6)}G`, orderId: o5.orderId, status: "APPROVED", reason: "DAMAGED" }, select: { id: true, returnNumber: true } });
      const ri5 = await tx.returnItem.create({ data: { returnRequestId: ret5.id, orderItemId: o5.orderItemId, productId: product.id, variantId: f5.variantId, name: "Item", unitPrice: 1000, quantity: 3, refundAmount: 3000 }, select: { id: true } });
      const oiG = (await tx.offerInventory.findFirstOrThrow({ where: { offerId: f5.offerId }, select: { quantity: true } })).quantity;
      await returnRestock(tx, ret5.id, ret5.returnNumber, o5.orderNumber, [{ returnItemId: ri5.id, orderItemId: o5.orderItemId, variantId: f5.variantId, restockQuantity: 3 }]);
      const invG = (await tx.inventory.findUniqueOrThrow({ where: { variantId: f5.variantId }, select: { quantity: true } })).quantity;
      const oiGafter = (await tx.offerInventory.findFirstOrThrow({ where: { offerId: f5.offerId }, select: { quantity: true } })).quantity;
      ok("G  legacy return: Inventory 5→8, OfferInventory UNCHANGED at 8", invG === 8 && oiGafter === oiG && oiG === 8);

      // ---- H — a failing Inventory mirror rolls back the OfferInventory restore ----
      const f6 = await mkFixture(tx, axiaro.id, product.id, `v6-${sfx}`, 10);
      const o6 = await mkOrder(tx, axiaro.id, product.id, f6.variantId, f6.offerId, 2, sfx);
      await commitOfferSale(tx, f6.offerId, 2, `Order ${o6.orderNumber}`);
      await adjInv(tx, f6.variantId, -2, "SALE", `Order ${o6.orderNumber}`);
      const oiH0 = (await tx.offerInventory.findFirstOrThrow({ where: { offerId: f6.offerId }, select: { quantity: true } })).quantity;
      let rolledBack = false;
      await tx.$queryRawUnsafe(`SAVEPOINT h6`);
      try {
        await cancelReversal(tx, o6.orderId, o6.orderNumber, { failInvMirror: true });
      } catch {
        rolledBack = true;
        await tx.$queryRawUnsafe(`ROLLBACK TO SAVEPOINT h6`);
      }
      const oiH1 = (await tx.offerInventory.findFirstOrThrow({ where: { offerId: f6.offerId }, select: { quantity: true } })).quantity;
      ok("H  Inventory-reversal failure rolls back the OfferInventory restore (stays at 8)", rolledBack && oiH1 === oiH0 && oiH1 === 8);

      // ---- K — sequential SALE → admin adjust → cancel ----
      const f7 = await mkFixture(tx, axiaro.id, product.id, `v7-${sfx}`, 20);
      const o7 = await mkOrder(tx, axiaro.id, product.id, f7.variantId, f7.offerId, 4, sfx);
      await commitOfferSale(tx, f7.offerId, 4, `Order ${o7.orderNumber}`);           // 16 / 16
      await adjInv(tx, f7.variantId, -4, "SALE", `Order ${o7.orderNumber}`);
      // admin adjust +10 — OfferInventory first, then Inventory (§12)
      await restoreOffer(tx, f7.offerId, 10, "RESTOCK", `admin`);
      await adjInv(tx, f7.variantId, 10, "RESTOCK", `admin`);                          // 26 / 26
      await cancelReversal(tx, o7.orderId, o7.orderNumber);                            // +4 both → 30 / 30
      p = await parity(tx, f7.variantId, f7.offerId);
      ok("K  SALE → admin RESTOCK → cancel: final 30/30, parity, no negative", p.equal && p.oiQ === 30 && p.invQ === 30 && p.mirror);

      // ---- L — sequential SALE → cancel → admin adjust ----
      const f8 = await mkFixture(tx, axiaro.id, product.id, `v8-${sfx}`, 20);
      const o8 = await mkOrder(tx, axiaro.id, product.id, f8.variantId, f8.offerId, 6, sfx);
      await commitOfferSale(tx, f8.offerId, 6, `Order ${o8.orderNumber}`);
      await adjInv(tx, f8.variantId, -6, "SALE", `Order ${o8.orderNumber}`);
      await cancelReversal(tx, o8.orderId, o8.orderNumber);                            // 20 / 20
      await restoreOffer(tx, f8.offerId, -5 + 5, "CORRECTION", `admin`);               // no-op guard
      await restoreOffer(tx, f8.offerId, 3, "RESTOCK", `admin`);
      await adjInv(tx, f8.variantId, 3, "RESTOCK", `admin`);                           // 23 / 23
      p = await parity(tx, f8.variantId, f8.offerId);
      ok("L  SALE → cancel → admin RESTOCK: final 23/23, parity", p.equal && p.oiQ === 23 && p.invQ === 23);

      throw new Rollback();
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  const leaked = await prisma.variant.count({ where: { sku: { contains: sfx } } });
  const leakedOrders = await prisma.order.count({ where: { orderNumber: { contains: "AX-TEST-" } } });
  ok("ROLLBACK  no fixture variant leaked", leaked === 0, String(leaked));
  ok("ROLLBACK  no test order persisted", leakedOrders === 0, String(leakedOrders));
}

function staticChecks() {
  console.log("\nM. static — lock order OfferInventory → Inventory");
  const cancel = readFileSync(new URL("../src/lib/admin/order-actions.ts", import.meta.url), "utf8");
  const returns = readFileSync(new URL("../src/lib/admin/returns-actions.ts", import.meta.url), "utf8");
  const adminInv = readFileSync(new URL("../src/lib/admin/inventory-actions.ts", import.meta.url), "utf8");
  const offerInv = readFileSync(new URL("../src/lib/marketplace/offer-inventory.ts", import.meta.url), "utf8");
  const cancelCode = cancel.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
  const returnsCode = returns.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
  const adminCode = adminInv.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");

  const before = (s: string, a: RegExp, b: RegExp) => {
    const ia = s.search(a), ib = s.search(b);
    return ia >= 0 && ib >= 0 && ia < ib;
  };
  ok("M  cancelOrderAction: restoreOfferStock call before adjustStock call", before(cancelCode, /restoreOfferStock\s*\(/, /adjustStock\s*\(/));
  ok("M  receiveReturnAction: restoreOfferStock call before adjustStock call", before(returnsCode, /restoreOfferStock\s*\(/, /adjustStock\s*\(/));
  ok("M  adjustStockAction: syncFirstPartyOfferStock before adjustStock", before(adminCode, /syncFirstPartyOfferStock\s*\(/, /adjustStock\s*\(/));
  ok("M  updateThresholdAction: syncFirstPartyOfferReorderPoint before setReorderPoint", before(adminCode, /syncFirstPartyOfferReorderPoint\s*\(/, /setReorderPoint\s*\(/));
  ok("M  restoreOfferStock / commitOfferStockForSale use FOR UPDATE on OfferInventory", /FROM "OfferInventory"[\s\S]{0,120}FOR UPDATE/.test(offerInv));
  ok("M  offer-inventory.ts never touches Inventory / Variant.stock", !/tx\.inventory\.|prisma\.inventory\.|(FROM|UPDATE|INTO)\s+"Inventory"|"Variant"\s+SET/i.test(offerInv.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "")));
  ok("M  cancel + return keep the legacy Inventory-only fallback (offerNative gate)", /offerNative\s*=/.test(cancelCode) && /offerNative\s*=/.test(returnsCode));
  ok("M  cancel idempotency = atomic Order.status gate", /status" IN \('PENDING_PAYMENT', 'PENDING', 'PROCESSING'\)/.test(cancel));
  ok("M  return idempotency = ReturnRequest.restockedAt set-once", /status: "APPROVED", restockedAt: null/.test(returns));
  ok("M  checkout.ts unchanged (still commitOfferStockForSale then adjustStock)", (() => {
    const co = readFileSync(new URL("../src/lib/checkout.ts", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
    return before(co, /commitOfferStockForSale\s*\(/, /adjustStock\s*\(/);
  })());
}

async function gateCheck() {
  const g = await prisma.storeSetting.findUnique({ where: { key: "marketplace.multiSellerCheckout" } });
  ok("GATE  marketplace.multiSellerCheckout == 'false'", g?.value === "false", g?.value ?? "<absent>");
}

async function run() {
  await dbTests();
  staticChecks();
  await gateCheck();
  console.log(`\n  ${pass} passed, ${fail} failed.`);
  if (fail > 0) throw new Error(`${fail} Phase 9E-3D-1 check(s) failed.`);
}

run().then(() => console.log("All Phase 9E-3D-1 checks passed."))
  .catch((e) => { console.error(e.message ?? e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
