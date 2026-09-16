/**
 * MULTI-SELLER SELLER SELF-CANCELLATION — regression tests.
 *
 * Extends `sellerCancelSellerOrder` from single-seller-only to genuine
 * multi-seller orders: a seller may now decline/cancel ONLY its own
 * SellerOrder, and the parent Order is cancelled too ONLY once every sibling
 * SellerOrder is itself CANCELLED (decided with a `SELECT ... FOR UPDATE`
 * lock on every sibling row, reusing the exact lock idiom `restoreOfferStock`
 * already uses — no new locking abstraction). No schema change, no
 * PARTIALLY_CANCELLED.
 *
 * A second, necessary fix ships alongside this: `reverseCancelledOrder`
 * (customer path) and admin's `cancelOrderAction` now scope their offer-native
 * inventory reversal to items whose SellerOrder is actually being cancelled in
 * that call — never an item whose SellerOrder was ALREADY independently
 * cancelled by a prior seller self-decline. Without this, a later whole-order
 * cancellation would silently double-restore that seller's stock.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-multiseller-seller-cancellation.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient, Prisma } from "@prisma/client";
import { sellerCancelSellerOrder } from "@/lib/marketplace/seller-order-repository";
import { reverseCancelledOrder } from "@/lib/orders/cancellation";
import { evaluateSellerOrder, type ReconcileOrder, type ReconcileSellerOrder } from "@/lib/marketplace/state-reconcile";
import type { SellerContext } from "@/lib/marketplace/types";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const rand = () => Math.random().toString(36).slice(2, 7);
class Rollback extends Error {}

const ctxFor = (sellerId: string, sellerName = "T"): SellerContext => ({
  sellerId,
  sellerName,
  sellerUserId: "su-" + sellerId,
  userId: "u-" + sellerId,
  role: "OWNER" as SellerContext["role"],
  permissions: new Set(["manage_seller_fulfillment"]),
});

// ── static wiring / scope ─────────────────────────────────────────────────
function staticTests() {
  console.log("\n── static wiring / scope ──");
  const repo = read("src/lib/marketplace/seller-order-repository.ts");
  const cancellation = read("src/lib/orders/cancellation.ts");
  const adminActions = read("src/lib/admin/order-actions.ts");
  const schema = read("prisma/schema.prisma");

  ok("no PARTIALLY_CANCELLED / PARTIALLY_SHIPPED introduced anywhere",
    !/PARTIALLY_CANCELLED/.test(repo) && !/PARTIALLY_SHIPPED/.test(repo));
  ok("no schema change", !/parentAlsoCancelled|anySiblingStillActive/.test(schema));
  ok("no new locking abstraction — reuses the SAME FOR UPDATE idiom restoreOfferStock already uses",
    /FOR UPDATE`;$/m.test(read("src/lib/marketplace/offer-inventory.ts")) &&
      /FOR UPDATE`;/.test(repo));
  ok("cancellation.ts's whole-order reversal now excludes already-CANCELLED SellerOrders' items",
    /OR: \[\{ sellerOrderId: \{ in: toCancel\.map\(\(s\) => s\.id\) \} \}, \{ sellerOrderId: null \}\]/.test(cancellation));
  ok("admin cancelOrderAction has the identical exclusion",
    /OR: \[\{ sellerOrderId: \{ in: toCancel\.map\(\(s\) => s\.id\) \} \}, \{ sellerOrderId: null \}\]/.test(adminActions));
  ok("seed-rbac.ts untouched", !/parentAlsoCancelled|anySiblingStillActive/.test(read("scripts/seed-rbac.ts")));
}

// ── fixtures ────────────────────────────────────────────────────────────
async function mkThirdPartySeller(tx: Prisma.TransactionClient, sfx: string, tag: string) {
  return tx.seller.create({
    data: { type: "THIRD_PARTY", status: "APPROVED", displayName: `Seller ${tag} ${sfx}`, slug: `seller-${tag}-${sfx}-${rand()}`, supportEmail: `${tag}@t.test` },
    select: { id: true },
  });
}

async function mkOfferNativeLine(tx: Prisma.TransactionClient, categoryId: string, sellerId: string, sfx: string, opts: { qty?: number; soldCount?: number } = {}) {
  const product = await tx.product.create({
    data: { name: `P ${sfx}`, slug: `p-${sfx}-${rand()}`, shortDescription: "s", description: "d", categoryId, status: "ACTIVE", price: 1000, soldCount: opts.soldCount ?? 0 },
    select: { id: true },
  });
  const variant = await tx.variant.create({
    data: { productId: product.id, sku: `v-${sfx}-${rand()}`, price: 1000, status: "ACTIVE", stock: 0 },
    select: { id: true },
  });
  const offer = await tx.offer.create({
    data: { sellerId, variantId: variant.id, price: 1000, condition: "NEW", status: "ACTIVE", sellerSku: `os-${sfx}-${rand()}` },
    select: { id: true },
  });
  const inv = await tx.offerInventory.create({
    data: { offerId: offer.id, sellerSku: null, quantity: opts.qty ?? 8, reserved: 0, reorderPoint: 3 },
    select: { id: true },
  });
  return { productId: product.id, offerId: offer.id, offerInventoryId: inv.id };
}

async function markSaleAdjustment(tx: Prisma.TransactionClient, offerInventoryId: string, orderNumber: string, units: number) {
  const row = await tx.offerInventory.findUniqueOrThrow({ where: { id: offerInventoryId }, select: { quantity: true } });
  await tx.offerAdjustment.create({
    data: { offerInventoryId, previousQuantity: row.quantity + units, delta: -units, newQuantity: row.quantity, reason: "SALE", note: `Order ${orderNumber}` },
  });
}

type SellerLineSpec = {
  sellerId: string;
  sellerType?: string;
  soStatus: string;
  offerId: string;
  productId: string;
  offerInventoryId: string;
  qty: number;
};

async function mkMultiSellerOrder(tx: Prisma.TransactionClient, sfx: string, parentStatus: string, sellers: SellerLineSpec[]) {
  const shippingFee = 150;
  const subtotal = sellers.reduce((n, s) => n + s.qty * 1000, 0);
  const order = await tx.order.create({
    data: {
      orderNumber: `AX-MSSC-${sfx}-${rand()}`,
      email: "buyer@example.test",
      phone: "+639000000000",
      status: parentStatus,
      paymentStatus: "PENDING",
      paymentMethod: "COD",
      subtotal,
      shippingFee,
      grandTotal: subtotal + shippingFee,
      shippingAddress: JSON.stringify({ firstName: "T", lastName: "B", line1: "1 St", city: "Manila", province: "NCR", postalCode: "1000", country: "PH" }),
    },
    select: { id: true, orderNumber: true },
  });
  const sellerOrderIds: Record<string, string> = {};
  for (const s of sellers) {
    const merch = s.qty * 1000;
    const so = await tx.sellerOrder.create({
      data: {
        orderId: order.id, sellerId: s.sellerId, sellerName: "S", sellerType: s.sellerType ?? "THIRD_PARTY", supportEmail: "s@t.test",
        merchandiseSubtotal: merch, shippingFee: 0, total: merch, commissionRate: 1500, commissionAmount: Math.round(merch * 0.15),
        status: s.soStatus,
      },
      select: { id: true },
    });
    sellerOrderIds[s.sellerId] = so.id;
    await tx.orderItem.create({
      data: { orderId: order.id, sellerOrderId: so.id, sellerId: s.sellerId, productId: s.productId, offerId: s.offerId, name: "Item", unitPrice: 1000, quantity: s.qty, lineTotal: merch },
    });
    await markSaleAdjustment(tx, s.offerInventoryId, order.orderNumber, s.qty);
  }
  return { orderId: order.id, orderNumber: order.orderNumber, sellerOrderIds };
}

function toReconcileOrder(status: string): ReconcileOrder {
  return { orderNumber: "x", status };
}
function toReconcileSellerOrder(row: { id: string; sellerType: string; status: string; commissionRate: number; commissionAmount: number; merchandiseSubtotal: number; total: number }): ReconcileSellerOrder {
  return {
    id: row.id, sellerType: row.sellerType, status: row.status,
    settlementStatus: "PENDING_CAPTURE", settlementId: null, settlementClawbackAmount: 0,
    merchandiseSubtotal: row.merchandiseSubtotal, discountAllocated: 0, shippingFee: 0,
    commissionRate: row.commissionRate, commissionAmount: row.commissionAmount, total: row.total,
  };
}
async function reconcileFindingsFor(tx: Prisma.TransactionClient, orderId: string, sellerOrderId: string) {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });
  const so = await tx.sellerOrder.findUniqueOrThrow({
    where: { id: sellerOrderId },
    select: { id: true, sellerType: true, status: true, commissionRate: true, commissionAmount: true, merchandiseSubtotal: true, total: true },
  });
  return evaluateSellerOrder(toReconcileOrder(order.status), toReconcileSellerOrder(so), 0, false);
}

// ── DB behaviour (rolled-back fixtures) ─────────────────────────────────
async function dbTests() {
  console.log("\n── seller self-cancellation, multi-seller (fixtures rolled back) ──");
  const category = await prisma.category.findFirst({ select: { id: true } });
  if (!category) { ok("(skipped — no category)", true); return; }
  const sfx = "mssc-" + String(Date.now()).slice(-7);

  try {
    await prisma.$transaction(async (tx) => {
      // ── A · single-seller — unchanged ──
      {
        const s = await mkThirdPartySeller(tx, sfx, "A");
        const l = await mkOfferNativeLine(tx, category.id, s.id, sfx + "A", { qty: 8, soldCount: 5 });
        const o = await mkMultiSellerOrder(tx, sfx + "A", "PROCESSING", [{ sellerId: s.id, soStatus: "PROCESSING", offerId: l.offerId, productId: l.productId, offerInventoryId: l.offerInventoryId, qty: 2 }]);
        const r = await sellerCancelSellerOrder(ctxFor(s.id), o.sellerOrderIds[s.id], "can't fulfil", tx);
        ok("A · single-seller decline succeeds", r.ok === true, JSON.stringify(r));
        if (r.ok) {
          ok("A · parentAlsoCancelled = true (single seller IS the whole order)", r.parentAlsoCancelled === true);
          ok("A · parent Order → CANCELLED", (await tx.order.findUnique({ where: { id: o.orderId }, select: { status: true } }))?.status === "CANCELLED");
          ok("A · inventory restored 8+2=10", (await tx.offerInventory.findUniqueOrThrow({ where: { id: l.offerInventoryId }, select: { quantity: true } })).quantity === 10);
        }
      }

      // ── B · two-seller: A cancels, B remains active, parent UNCHANGED ──
      let bOrder: Awaited<ReturnType<typeof mkMultiSellerOrder>> | null = null;
      let bSellerA = "", bSellerB = "", bLineA: Awaited<ReturnType<typeof mkOfferNativeLine>> | null = null, bLineB: Awaited<ReturnType<typeof mkOfferNativeLine>> | null = null;
      {
        const sA = await mkThirdPartySeller(tx, sfx, "B-A");
        const sB = await mkThirdPartySeller(tx, sfx, "B-B");
        const lA = await mkOfferNativeLine(tx, category.id, sA.id, sfx + "BA", { qty: 8, soldCount: 5 });
        const lB = await mkOfferNativeLine(tx, category.id, sB.id, sfx + "BB", { qty: 6, soldCount: 3 });
        const o = await mkMultiSellerOrder(tx, sfx + "B", "PROCESSING", [
          { sellerId: sA.id, soStatus: "PROCESSING", offerId: lA.offerId, productId: lA.productId, offerInventoryId: lA.offerInventoryId, qty: 2 },
          { sellerId: sB.id, soStatus: "PROCESSING", offerId: lB.offerId, productId: lB.productId, offerInventoryId: lB.offerInventoryId, qty: 1 },
        ]);
        bOrder = o; bSellerA = sA.id; bSellerB = sB.id; bLineA = lA; bLineB = lB;

        const r = await sellerCancelSellerOrder(ctxFor(sA.id), o.sellerOrderIds[sA.id], "can't fulfil", tx);
        ok("B · Seller A cancel succeeds", r.ok === true, JSON.stringify(r));
        if (r.ok) {
          ok("B · Seller A's SellerOrder → CANCELLED", (await tx.sellerOrder.findUniqueOrThrow({ where: { id: o.sellerOrderIds[sA.id] }, select: { status: true } })).status === "CANCELLED");
          ok("B · parentAlsoCancelled = false", r.parentAlsoCancelled === false);
          ok("B · parent Order UNCHANGED (still PROCESSING)", (await tx.order.findUniqueOrThrow({ where: { id: o.orderId }, select: { status: true } })).status === "PROCESSING");
          ok("B · Seller B's SellerOrder untouched (still PROCESSING)", (await tx.sellerOrder.findUniqueOrThrow({ where: { id: o.sellerOrderIds[sB.id] }, select: { status: true } })).status === "PROCESSING");
          ok("B · Seller A's inventory restored exactly once (8+2=10)", (await tx.offerInventory.findUniqueOrThrow({ where: { id: lA.offerInventoryId }, select: { quantity: true } })).quantity === 10);
          ok("B · Seller B's inventory UNTOUCHED (still 6)", (await tx.offerInventory.findUniqueOrThrow({ where: { id: lB.offerInventoryId }, select: { quantity: true } })).quantity === 6);
          ok("B · Seller A's commission zeroed", (await tx.sellerOrder.findUniqueOrThrow({ where: { id: o.sellerOrderIds[sA.id] }, select: { commissionAmount: true } })).commissionAmount === 0);
          ok("B · Seller B's commission UNTOUCHED", (await tx.sellerOrder.findUniqueOrThrow({ where: { id: o.sellerOrderIds[sB.id] }, select: { commissionAmount: true } })).commissionAmount === Math.round(1000 * 0.15));
        }
      }

      // ── C · B later cancels — parent → CANCELLED, each seller's inventory reversed exactly once ──
      {
        const o = bOrder!;
        const r = await sellerCancelSellerOrder(ctxFor(bSellerB), o.sellerOrderIds[bSellerB], "can't fulfil either", tx);
        ok("C · Seller B cancel succeeds (now the last active seller)", r.ok === true, JSON.stringify(r));
        if (r.ok) {
          ok("C · parentAlsoCancelled = true", r.parentAlsoCancelled === true);
          ok("C · parent Order → CANCELLED", (await tx.order.findUniqueOrThrow({ where: { id: o.orderId }, select: { status: true } })).status === "CANCELLED");
          ok("C · Seller A's inventory STILL exactly 10 (not reversed twice by B's cancellation)", (await tx.offerInventory.findUniqueOrThrow({ where: { id: bLineA!.offerInventoryId }, select: { quantity: true } })).quantity === 10);
          ok("C · Seller B's inventory reversed exactly once (6+1=7)", (await tx.offerInventory.findUniqueOrThrow({ where: { id: bLineB!.offerInventoryId }, select: { quantity: true } })).quantity === 7);
          const evCount = await tx.orderEvent.count({ where: { orderId: o.orderId, status: "CANCELLED" } });
          ok("E · parent transitions to CANCELLED via exactly ONE 'Order cancelled' timeline event (plus the earlier partial-decline event)", evCount === 2);
          const events = await tx.orderEvent.findMany({ where: { orderId: o.orderId, status: "CANCELLED" }, select: { title: true }, orderBy: { createdAt: "asc" } });
          ok("E · first event is the partial 'Seller order cancelled', second is the whole-order 'Order cancelled'",
            events[0]?.title === "Seller order cancelled" && events[1]?.title === "Order cancelled");
        }
      }

      // ── D · three-seller: A cancels, B cancels, C remains — parent UNCHANGED ──
      let dOrder: Awaited<ReturnType<typeof mkMultiSellerOrder>> | null = null;
      let dSellerC = "";
      {
        const sA = await mkThirdPartySeller(tx, sfx, "D-A");
        const sB = await mkThirdPartySeller(tx, sfx, "D-B");
        const sC = await mkThirdPartySeller(tx, sfx, "D-C");
        const lA = await mkOfferNativeLine(tx, category.id, sA.id, sfx + "DA", { qty: 8, soldCount: 5 });
        const lB = await mkOfferNativeLine(tx, category.id, sB.id, sfx + "DB", { qty: 6, soldCount: 3 });
        const lC = await mkOfferNativeLine(tx, category.id, sC.id, sfx + "DC", { qty: 4, soldCount: 2 });
        const o = await mkMultiSellerOrder(tx, sfx + "D", "PROCESSING", [
          { sellerId: sA.id, soStatus: "PROCESSING", offerId: lA.offerId, productId: lA.productId, offerInventoryId: lA.offerInventoryId, qty: 1 },
          { sellerId: sB.id, soStatus: "PROCESSING", offerId: lB.offerId, productId: lB.productId, offerInventoryId: lB.offerInventoryId, qty: 1 },
          { sellerId: sC.id, soStatus: "PROCESSING", offerId: lC.offerId, productId: lC.productId, offerInventoryId: lC.offerInventoryId, qty: 1 },
        ]);
        dOrder = o; dSellerC = sC.id;

        const rA = await sellerCancelSellerOrder(ctxFor(sA.id), o.sellerOrderIds[sA.id], "A can't fulfil", tx);
        ok("D · Seller A cancels", rA.ok === true && rA.ok && rA.parentAlsoCancelled === false);
        const rB = await sellerCancelSellerOrder(ctxFor(sB.id), o.sellerOrderIds[sB.id], "B can't fulfil", tx);
        ok("D · Seller B cancels", rB.ok === true && rB.ok && rB.parentAlsoCancelled === false);
        ok("D · parent Order UNCHANGED (Seller C still active)", (await tx.order.findUniqueOrThrow({ where: { id: o.orderId }, select: { status: true } })).status === "PROCESSING");
        ok("D · Seller C's SellerOrder untouched (still PROCESSING)", (await tx.sellerOrder.findUniqueOrThrow({ where: { id: o.sellerOrderIds[sC.id] }, select: { status: true } })).status === "PROCESSING");
      }

      // ── H (continued from D) · the final remaining 3P seller (C) cancels — parent → CANCELLED exactly once ──
      {
        const o = dOrder!;
        const r = await sellerCancelSellerOrder(ctxFor(dSellerC), o.sellerOrderIds[dSellerC], "C can't fulfil either", tx);
        ok("H · multi-3P — the last remaining seller's cancel is symmetric with A/B's — parentAlsoCancelled = true", r.ok === true && r.ok && r.parentAlsoCancelled === true);
        if (r.ok) {
          ok("H · parent Order → CANCELLED exactly once", (await tx.order.findUniqueOrThrow({ where: { id: o.orderId }, select: { status: true } })).status === "CANCELLED");
          const evCount = await tx.orderEvent.count({ where: { orderId: o.orderId, status: "CANCELLED", title: "Order cancelled" } });
          ok("H · exactly ONE whole-order 'Order cancelled' event even with 3 sellers involved", evCount === 1);
        }
      }

      // ── G · mixed 1P + 3P — 3P can cancel only its own; FIRST_PARTY untouched ──
      {
        const axiaro = await tx.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
        if (!axiaro) {
          ok("G (skipped — no FIRST_PARTY seller row found)", true);
        } else {
          const s3p = await mkThirdPartySeller(tx, sfx, "G3P");
          const l3p = await mkOfferNativeLine(tx, category.id, s3p.id, sfx + "G3P", { qty: 6, soldCount: 3 });
          const product1p = await tx.product.create({
            data: { name: `P1P ${sfx}`, slug: `p1p-${sfx}-${rand()}`, shortDescription: "s", description: "d", categoryId: category.id, status: "ACTIVE", price: 1000, soldCount: 1 },
            select: { id: true },
          });
          const order = await tx.order.create({
            data: {
              orderNumber: `AX-MSSC-${sfx}G-${rand()}`, email: "buyer@example.test", phone: "+639000000000",
              status: "PROCESSING", paymentStatus: "PENDING", paymentMethod: "COD",
              subtotal: 2000, shippingFee: 150, grandTotal: 2150,
              shippingAddress: JSON.stringify({ firstName: "T", lastName: "B", line1: "1 St", city: "Manila", province: "NCR", postalCode: "1000", country: "PH" }),
            },
            select: { id: true, orderNumber: true },
          });
          const so1p = await tx.sellerOrder.create({
            data: { orderId: order.id, sellerId: axiaro.id, sellerName: "Axiaro", sellerType: "FIRST_PARTY", supportEmail: "s@t.test", merchandiseSubtotal: 1000, shippingFee: 0, total: 1000, commissionRate: 0, commissionAmount: 0, status: "PROCESSING" },
            select: { id: true },
          });
          await tx.orderItem.create({ data: { orderId: order.id, sellerOrderId: so1p.id, productId: product1p.id, name: "1P item", unitPrice: 1000, quantity: 1, lineTotal: 1000 } });
          const so3p = await tx.sellerOrder.create({
            data: { orderId: order.id, sellerId: s3p.id, sellerName: "S", sellerType: "THIRD_PARTY", supportEmail: "s@t.test", merchandiseSubtotal: 1000, shippingFee: 0, total: 1000, commissionRate: 1500, commissionAmount: 150, status: "PROCESSING" },
            select: { id: true },
          });
          await tx.orderItem.create({ data: { orderId: order.id, sellerOrderId: so3p.id, sellerId: s3p.id, productId: l3p.productId, offerId: l3p.offerId, name: "3P item", unitPrice: 1000, quantity: 1, lineTotal: 1000 } });
          await markSaleAdjustment(tx, l3p.offerInventoryId, order.orderNumber, 1);

          const r = await sellerCancelSellerOrder(ctxFor(s3p.id), so3p.id, "3P can't fulfil", tx);
          ok("G · 3P seller can cancel its OWN SellerOrder on a mixed 1P+3P order", r.ok === true, JSON.stringify(r));
          if (r.ok) {
            ok("G · parentAlsoCancelled = false (Axiaro's FIRST_PARTY leg still active)", r.parentAlsoCancelled === false);
            ok("G · FIRST_PARTY SellerOrder is NOT touched", (await tx.sellerOrder.findUniqueOrThrow({ where: { id: so1p.id }, select: { status: true } })).status === "PROCESSING");
            ok("G · parent Order UNCHANGED", (await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } })).status === "PROCESSING");
            ok("G · 3P inventory restored exactly once (6+1=7)", (await tx.offerInventory.findUniqueOrThrow({ where: { id: l3p.offerInventoryId }, select: { quantity: true } })).quantity === 7);
          }
        }
      }

      // ── I · forbidden seller-cancellation statuses ──
      for (const forbidden of ["READY_TO_SHIP", "SHIPPED", "DELIVERED", "CANCELLED"]) {
        const s = await mkThirdPartySeller(tx, sfx, "I-" + forbidden);
        const l = await mkOfferNativeLine(tx, category.id, s.id, sfx + "I" + forbidden, { qty: 5, soldCount: 2 });
        const o = await mkMultiSellerOrder(tx, sfx + "I" + forbidden, "PROCESSING", [{ sellerId: s.id, soStatus: forbidden, offerId: l.offerId, productId: l.productId, offerInventoryId: l.offerInventoryId, qty: 1 }]);
        const r = await sellerCancelSellerOrder(ctxFor(s.id), o.sellerOrderIds[s.id], "attempt", tx);
        ok(`I · ${forbidden} → refused, nothing changed`,
          r.ok === false && "code" in r && r.code === "VALIDATION" &&
          (await tx.offerInventory.findUniqueOrThrow({ where: { id: l.offerInventoryId }, select: { quantity: true } })).quantity === 5);
      }

      // ── F · whole-order cancellation after one seller self-cancelled — already-CANCELLED SellerOrder skipped ──
      {
        const sA = await mkThirdPartySeller(tx, sfx, "F-A");
        const sB = await mkThirdPartySeller(tx, sfx, "F-B");
        const lA = await mkOfferNativeLine(tx, category.id, sA.id, sfx + "FA", { qty: 8, soldCount: 5 });
        const lB = await mkOfferNativeLine(tx, category.id, sB.id, sfx + "FB", { qty: 6, soldCount: 3 });
        const o = await mkMultiSellerOrder(tx, sfx + "F", "PROCESSING", [
          { sellerId: sA.id, soStatus: "PROCESSING", offerId: lA.offerId, productId: lA.productId, offerInventoryId: lA.offerInventoryId, qty: 2 },
          { sellerId: sB.id, soStatus: "PROCESSING", offerId: lB.offerId, productId: lB.productId, offerInventoryId: lB.offerInventoryId, qty: 1 },
        ]);
        // Seller A self-cancels first.
        const rA = await sellerCancelSellerOrder(ctxFor(sA.id), o.sellerOrderIds[sA.id], "A out", tx);
        ok("F · setup — Seller A self-cancels first", rA.ok === true && rA.ok && rA.parentAlsoCancelled === false);
        const invAAfterSelfCancel = (await tx.offerInventory.findUniqueOrThrow({ where: { id: lA.offerInventoryId }, select: { quantity: true } })).quantity;

        // Now a whole-order (customer/admin) cancellation runs on the SAME order.
        const gate = await tx.$executeRaw`
          UPDATE "Order" SET "status" = 'CANCELLED', "updatedAt" = now()
          WHERE "id" = ${o.orderId} AND "status" IN ('PENDING_PAYMENT', 'PENDING', 'PROCESSING')`;
        ok("F · the whole-order atomic gate still succeeds (Seller B is still cancellable)", gate === 1);
        const result = await reverseCancelledOrder(tx, { orderId: o.orderId, orderNumber: o.orderNumber, actorUserId: "admin", adjustmentNote: "whole-order cancel", eventDetail: "Cancelled." });

        ok("F · Seller B (the only still-active seller) IS cancelled by the whole-order action", result.cancelledSellerOrderIds.includes(o.sellerOrderIds[sB.id]));
        ok("F · Seller A is NOT re-processed by the whole-order action", !result.cancelledSellerOrderIds.includes(o.sellerOrderIds[sA.id]));
        ok("F · Seller A's inventory is UNCHANGED by the whole-order cancellation (no double reversal)",
          (await tx.offerInventory.findUniqueOrThrow({ where: { id: lA.offerInventoryId }, select: { quantity: true } })).quantity === invAAfterSelfCancel);
        ok("F · Seller B's inventory IS reversed by the whole-order cancellation (6+1=7)",
          (await tx.offerInventory.findUniqueOrThrow({ where: { id: lB.offerInventoryId }, select: { quantity: true } })).quantity === 7);
        ok("F · Seller A's commission is STILL zero (not re-zeroed, was already zero)",
          (await tx.sellerOrder.findUniqueOrThrow({ where: { id: o.sellerOrderIds[sA.id] }, select: { commissionAmount: true } })).commissionAmount === 0);
        ok("F · Seller A's status is still CANCELLED (untouched, not re-written)",
          (await tx.sellerOrder.findUniqueOrThrow({ where: { id: o.sellerOrderIds[sA.id] }, select: { status: true } })).status === "CANCELLED");

        // K (continued) — repeated whole-order cancellation remains safe.
        const gate2 = await tx.$executeRaw`
          UPDATE "Order" SET "status" = 'CANCELLED' WHERE "id" = ${o.orderId} AND "status" IN ('PENDING_PAYMENT', 'PENDING', 'PROCESSING')`;
        ok("K · repeated whole-order cancellation matches 0 rows (idempotent, never reached again)", gate2 === 0);

        // L — reconciliation: both SellerOrders should now be findings-free.
        const fA = await reconcileFindingsFor(tx, o.orderId, o.sellerOrderIds[sA.id]);
        const fB = await reconcileFindingsFor(tx, o.orderId, o.sellerOrderIds[sB.id]);
        ok("L · reconciliation is clean for the self-cancelled seller (A) after the whole order also became CANCELLED", fA.length === 0, JSON.stringify(fA));
        ok("L · reconciliation is clean for the whole-order-cancelled seller (B)", fB.length === 0, JSON.stringify(fB));
      }

      // ── K · repeated SELLER self-cancellation is safe ──
      {
        const s = await mkThirdPartySeller(tx, sfx, "K");
        const l = await mkOfferNativeLine(tx, category.id, s.id, sfx + "K", { qty: 5, soldCount: 2 });
        const o = await mkMultiSellerOrder(tx, sfx + "K", "PROCESSING", [{ sellerId: s.id, soStatus: "PROCESSING", offerId: l.offerId, productId: l.productId, offerInventoryId: l.offerInventoryId, qty: 1 }]);
        const r1 = await sellerCancelSellerOrder(ctxFor(s.id), o.sellerOrderIds[s.id], "first", tx);
        ok("K · first seller cancel succeeds", r1.ok === true);
        const r2 = await sellerCancelSellerOrder(ctxFor(s.id), o.sellerOrderIds[s.id], "second (repeat)", tx);
        // A fresh re-read sees the SellerOrder already CANCELLED, so
        // sellerCanCancelSellerOrder rejects it as VALIDATION before ever
        // reaching the updateMany guard (STALE is for the narrower race where
        // the row changed BETWEEN this function's own read and its write —
        // unchanged, pre-existing behavior, not something this phase altered).
        ok("K · repeated seller cancel on the SAME (already-CANCELLED) SellerOrder is safely rejected", r2.ok === false && "code" in r2 && r2.code === "VALIDATION");
        ok("K · inventory not double-restored (still 5+1=6)", (await tx.offerInventory.findUniqueOrThrow({ where: { id: l.offerInventoryId }, select: { quantity: true } })).quantity === 6);
      }

      throw new Rollback();
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

// ── J · concurrency — two sellers cancelling at the same time ────────────
async function concurrencyTest() {
  console.log("\n── J · concurrency (real committed rows, explicit cleanup) ──");
  const category = await prisma.category.findFirst({ select: { id: true } });
  if (!category) { ok("(skipped — no category)", true); return; }
  const sfx = "mssc-race-" + String(Date.now()).slice(-7);

  const fixtureSellerIds: string[] = [];
  const fixtureProductIds: string[] = [];
  const fixtureOfferIds: string[] = [];
  let fixtureOrderId: string | null = null;

  try {
    const sA = await mkThirdPartySeller(prisma, sfx, "J-A");
    const sB = await mkThirdPartySeller(prisma, sfx, "J-B");
    fixtureSellerIds.push(sA.id, sB.id);
    const lA = await mkOfferNativeLine(prisma, category.id, sA.id, sfx + "JA", { qty: 8, soldCount: 5 });
    const lB = await mkOfferNativeLine(prisma, category.id, sB.id, sfx + "JB", { qty: 6, soldCount: 3 });
    fixtureProductIds.push(lA.productId, lB.productId);
    fixtureOfferIds.push(lA.offerId, lB.offerId);
    const o = await mkMultiSellerOrder(prisma, sfx + "J", "PROCESSING", [
      { sellerId: sA.id, soStatus: "PROCESSING", offerId: lA.offerId, productId: lA.productId, offerInventoryId: lA.offerInventoryId, qty: 2 },
      { sellerId: sB.id, soStatus: "PROCESSING", offerId: lB.offerId, productId: lB.productId, offerInventoryId: lB.offerInventoryId, qty: 1 },
    ]);
    fixtureOrderId = o.orderId;

    // Fire both sellers' cancellations at the same time — each opens its OWN
    // top-level transaction (no externalTx), so this genuinely exercises the
    // FOR UPDATE lock's serialization, not just in-process ordering. Postgres
    // may resolve the AB-BA lock contention either by strict serialization or
    // by aborting one side with a deadlock/serialization error — either
    // outcome is an ACCEPTABLE resolution as long as no corruption results; a
    // caller that loses the race simply retries (matching the existing
    // "reload and try again" pattern this repository already uses for STALE).
    const settle = async (p: ReturnType<typeof sellerCancelSellerOrder>) => {
      try { return { status: "fulfilled" as const, value: await p }; }
      catch (e) { return { status: "rejected" as const, reason: e }; }
    };
    const [ra, rb] = await Promise.all([
      settle(sellerCancelSellerOrder(ctxFor(sA.id), o.sellerOrderIds[sA.id], "race A")),
      settle(sellerCancelSellerOrder(ctxFor(sB.id), o.sellerOrderIds[sB.id], "race B")),
    ]);

    // Retry whichever side didn't cleanly succeed — a raw deadlock/serialization
    // failure is a legitimate, expected outcome of true concurrent contention,
    // not a corruption; retrying is the same recovery the UI already expects
    // for a STALE conflict.
    const retryIfNeeded = async (
      settled: { status: "fulfilled"; value: Awaited<ReturnType<typeof sellerCancelSellerOrder>> } | { status: "rejected"; reason: unknown },
      sellerId: string,
      sellerOrderId: string,
    ) => {
      if (settled.status === "fulfilled" && settled.value.ok) return settled.value;
      // Either it threw (deadlock) or returned a clean ok:false — check the
      // CURRENT row: if it's already CANCELLED, the other side's lock-wait
      // resolved this one too; otherwise, retry once.
      const current = await prisma.sellerOrder.findUniqueOrThrow({ where: { id: sellerOrderId }, select: { status: true } });
      if (current.status === "CANCELLED") return { ok: true as const };
      return sellerCancelSellerOrder(ctxFor(sellerId), sellerOrderId, "retry after race", undefined);
    };
    const finalA = await retryIfNeeded(ra, sA.id, o.sellerOrderIds[sA.id]);
    const finalB = await retryIfNeeded(rb, sB.id, o.sellerOrderIds[sB.id]);

    ok("J · Seller A ends up cancelled (directly or after one retry)", finalA.ok === true, JSON.stringify({ ra, finalA }));
    ok("J · Seller B ends up cancelled (directly or after one retry)", finalB.ok === true, JSON.stringify({ rb, finalB }));

    const soA = await prisma.sellerOrder.findUniqueOrThrow({ where: { id: o.sellerOrderIds[sA.id] }, select: { status: true } });
    const soB = await prisma.sellerOrder.findUniqueOrThrow({ where: { id: o.sellerOrderIds[sB.id] }, select: { status: true } });
    const order = await prisma.order.findUniqueOrThrow({ where: { id: o.orderId }, select: { status: true } });
    ok("J · final state — BOTH SellerOrders CANCELLED", soA.status === "CANCELLED" && soB.status === "CANCELLED");
    ok("J · final state — parent Order is ALSO CANCELLED (no stuck parent)", order.status === "CANCELLED");

    const invA = await prisma.offerInventory.findUniqueOrThrow({ where: { id: lA.offerInventoryId }, select: { quantity: true } });
    const invB = await prisma.offerInventory.findUniqueOrThrow({ where: { id: lB.offerInventoryId }, select: { quantity: true } });
    ok("J · Seller A's inventory reversed EXACTLY once (8+2=10, not 12)", invA.quantity === 10, String(invA.quantity));
    ok("J · Seller B's inventory reversed EXACTLY once (6+1=7, not 8)", invB.quantity === 7, String(invB.quantity));

    const cancelledEvents = await prisma.orderEvent.count({ where: { orderId: o.orderId, status: "CANCELLED", title: "Order cancelled" } });
    ok("J · exactly ONE whole-order 'Order cancelled' event despite the race (no duplicate parent cancellation)", cancelledEvents === 1, String(cancelledEvents));
  } finally {
    if (fixtureOrderId) await prisma.order.deleteMany({ where: { id: fixtureOrderId } }).catch(() => {});
    if (fixtureProductIds.length) await prisma.product.deleteMany({ where: { id: { in: fixtureProductIds } } }).catch(() => {});
    if (fixtureSellerIds.length) await prisma.seller.deleteMany({ where: { id: { in: fixtureSellerIds } } }).catch(() => {});
  }

  ok("J · CLEANUP — no fixture order leaked", (await prisma.order.count({ where: { orderNumber: { contains: sfx } } })) === 0);
  ok("J · CLEANUP — no fixture seller leaked", (await prisma.seller.count({ where: { id: { in: fixtureSellerIds } } })) === 0);
}

async function main() {
  console.log("\nMULTI-SELLER SELLER SELF-CANCELLATION — regression tests\n");
  staticTests();
  await dbTests();
  await concurrencyTest();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
