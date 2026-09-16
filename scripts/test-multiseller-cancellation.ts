/**
 * MULTI-SELLER CANCELLATION SAFETY FIX — regression tests.
 *
 * Fixes the confirmed gap from the multi-seller cancellation audit: a
 * whole-order cancellation (`admin/order-actions.ts` `cancelOrderAction` and
 * the shared `orders/cancellation.ts` `reverseCancelledOrder` used by customer
 * self-service) used to cascade every non-CANCELLED SellerOrder on an Order to
 * CANCELLED regardless of that SellerOrder's OWN status. In a multi-seller
 * order this is unsafe: the 9F-12b / 9F-35B rollup only advances the parent
 * `Order.status` once EVERY SellerOrder reaches a given milestone, so one
 * seller can legitimately reach SHIPPED or DELIVERED while `Order.status` is
 * still PROCESSING (another seller hasn't caught up yet). Before this fix,
 * cancelling the whole order in that window would pull the already-dispatched
 * SellerOrder backwards to CANCELLED — wrongly restoring inventory that had
 * already left and zeroing commission that was legitimately earned.
 *
 * The fix (both `reverseCancelledOrder` and admin's own inline reversal):
 * fetch every live SellerOrder BEFORE any reversal write and refuse the ENTIRE
 * cancellation — throwing `SellerOrderNotCancellableError`, nothing written —
 * the moment any of them is outside `sellerCanCancelSellerOrder` (the existing
 * canonical PENDING_PAYMENT / PROCESSING gate from `seller-order-status.ts`,
 * reused as-is — no new status ranking invented). There is no partial
 * cancellation: either every SellerOrder on the order is still cancellable and
 * the whole order (and every SellerOrder on it) is cancelled exactly as
 * before, or nothing at all is touched.
 *
 * DB tests build fixtures inside ONE outer prisma.$transaction and roll back.
 * A "blocked cancellation must leave everything untouched" assertion needs its
 * own SAVEPOINT (the established test-9e3d1.ts / test-multiseller-checkout.ts
 * idiom) so the throw's rollback can be observed without discarding the rest
 * of the fixture work in the same outer transaction.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-multiseller-cancellation.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient, Prisma } from "@prisma/client";
import { reverseCancelledOrder, SellerOrderNotCancellableError } from "@/lib/orders/cancellation";
import { sellerCanCancelSellerOrder } from "@/lib/marketplace/seller-order-status";
import {
  evaluateSellerOrder,
  type ReconcileOrder,
  type ReconcileSellerOrder,
} from "@/lib/marketplace/state-reconcile";

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

// ── pure — the canonical gate this fix reuses ──────────────────────────
function pureTests() {
  console.log("\n── pure — sellerCanCancelSellerOrder (the reused canonical gate) ──");
  ok("sellerCanCancelSellerOrder(PENDING_PAYMENT) = true", sellerCanCancelSellerOrder("PENDING_PAYMENT") === true);
  ok("sellerCanCancelSellerOrder(PROCESSING) = true", sellerCanCancelSellerOrder("PROCESSING") === true);
  ok("sellerCanCancelSellerOrder(READY_TO_SHIP) = false", sellerCanCancelSellerOrder("READY_TO_SHIP") === false);
  ok("sellerCanCancelSellerOrder(SHIPPED) = false", sellerCanCancelSellerOrder("SHIPPED") === false);
  ok("sellerCanCancelSellerOrder(DELIVERED) = false", sellerCanCancelSellerOrder("DELIVERED") === false);
  ok("sellerCanCancelSellerOrder(CANCELLED) = false (irrelevant — already excluded upstream by status:{not:CANCELLED})", sellerCanCancelSellerOrder("CANCELLED") === false);
}

// ── static wiring ───────────────────────────────────────────────────────
function staticTests() {
  console.log("\n── static wiring ──");
  const cancellation = read("src/lib/orders/cancellation.ts");
  const adminActions = read("src/lib/admin/order-actions.ts");
  const seedRbac = read("scripts/seed-rbac.ts");
  const schema = read("prisma/schema.prisma");

  ok("cancellation.ts exports SellerOrderNotCancellableError",
    /export class SellerOrderNotCancellableError extends Error/.test(cancellation));
  ok("cancellation.ts reuses the CANONICAL sellerCanCancelSellerOrder helper (no duplicated status ranking)",
    /import \{ sellerCanCancelSellerOrder \} from "@\/lib\/marketplace\/seller-order-status"/.test(cancellation) &&
      /filter\(\(so\) => !sellerCanCancelSellerOrder\(so\.status\)\)/.test(cancellation));
  ok("cancellation.ts gate runs BEFORE any inventory reversal write (no restoreOfferStock/adjustStock text before the throw)",
    (() => {
      const gateIdx = cancellation.indexOf("throw new SellerOrderNotCancellableError");
      const restoreIdx = cancellation.indexOf("restoreOfferStock(");
      const adjustIdx = cancellation.indexOf("adjustStock(");
      return gateIdx > -1 && restoreIdx > gateIdx && adjustIdx > gateIdx;
    })());
  ok("admin/order-actions.ts imports the SAME SellerOrderNotCancellableError + sellerCanCancelSellerOrder (identical rule, not a divergent copy)",
    /import \{ SellerOrderNotCancellableError \} from "@\/lib\/orders\/cancellation"/.test(adminActions) &&
      /import \{ sellerCanCancelSellerOrder \} from "@\/lib\/marketplace\/seller-order-status"/.test(adminActions));
  ok("admin/order-actions.ts gate runs BEFORE any inventory reversal write, right after the atomic Order gate",
    (() => {
      const gateExecIdx = adminActions.indexOf("if (cancelled === 0) throw new StaleOrderError();");
      const throwIdx = adminActions.indexOf("throw new SellerOrderNotCancellableError");
      const restoreIdx = adminActions.indexOf("restoreOfferStock(");
      return gateExecIdx > -1 && throwIdx > gateExecIdx && restoreIdx > throwIdx;
    })());
  ok("no PARTIALLY_CANCELLED / new status value introduced anywhere",
    !/PARTIALLY_CANCELLED/.test(cancellation) && !/PARTIALLY_CANCELLED/.test(adminActions));
  ok("no schema change", !/SellerOrderNotCancellable/.test(schema));
  ok("seed-rbac.ts untouched", !/SellerOrderNotCancellable|sellerCanCancelSellerOrder/.test(seedRbac));
  ok("checkout.ts (payment/coupon/shipping path) does not reference the new gate — scope stayed to cancellation",
    !/SellerOrderNotCancellable/.test(read("src/lib/checkout.ts")));
  ok("seller self-cancel (9F-30B) NOT modified by this fix",
    !/SellerOrderNotCancellable/.test(read("src/lib/marketplace/seller-order-repository.ts")));
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
  settlementId?: string | null;
};

async function mkMultiSellerOrder(tx: Prisma.TransactionClient, sfx: string, parentStatus: string, sellers: SellerLineSpec[]) {
  const shippingFee = 150;
  const subtotal = sellers.reduce((n, s) => n + s.qty * 1000, 0);
  const order = await tx.order.create({
    data: {
      orderNumber: `AX-MSC-${sfx}-${rand()}`,
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
    const commissionAmount = Math.round(merch * 0.15);
    const so = await tx.sellerOrder.create({
      data: {
        orderId: order.id,
        sellerId: s.sellerId,
        sellerName: "S",
        sellerType: s.sellerType ?? "THIRD_PARTY",
        supportEmail: "s@t.test",
        merchandiseSubtotal: merch,
        shippingFee: 0,
        total: merch,
        commissionRate: 1500,
        commissionAmount,
        status: s.soStatus,
        settlementId: s.settlementId ?? null,
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

type CancelAttempt =
  | { ok: true; result: Awaited<ReturnType<typeof reverseCancelledOrder>> }
  | { ok: false; blocked: true; error: SellerOrderNotCancellableError }
  | { ok: false; blocked: false; staleGate: true };

let spCounter = 0;

/** Mirrors the real caller sequence: atomic Order gate, then reverseCancelledOrder.
 *  On SellerOrderNotCancellableError, rolls back to a SAVEPOINT taken before the
 *  gate ran — proving the atomic UPDATE itself is undone, not just the reversal. */
async function attemptCancel(tx: Prisma.TransactionClient, orderId: string, orderNumber: string): Promise<CancelAttempt> {
  const sp = `sp_msc_${++spCounter}`;
  await tx.$queryRawUnsafe(`SAVEPOINT ${sp}`);
  try {
    const gate = await tx.$executeRaw`
      UPDATE "Order" SET "status" = 'CANCELLED', "updatedAt" = now()
      WHERE "id" = ${orderId} AND "status" IN ('PENDING_PAYMENT', 'PENDING', 'PROCESSING')`;
    if (gate === 0) return { ok: false, blocked: false, staleGate: true };
    const result = await reverseCancelledOrder(tx, {
      orderId, orderNumber, actorUserId: "admin",
      adjustmentNote: `Order ${orderNumber} cancelled`, eventDetail: "Cancelled.",
    });
    return { ok: true, result };
  } catch (e) {
    await tx.$queryRawUnsafe(`ROLLBACK TO SAVEPOINT ${sp}`);
    if (e instanceof SellerOrderNotCancellableError) return { ok: false, blocked: true, error: e };
    throw e;
  }
}

type Snapshot = {
  orderStatus: string;
  soStatus: Record<string, string>;
  soCommission: Record<string, number>;
  invQty: Record<string, number>;
  productSoldCount: Record<string, number>;
  eventCount: number;
};

async function snapshot(
  tx: Prisma.TransactionClient,
  orderId: string,
  sellerOrderIds: Record<string, string>,
  offerInventoryIds: Record<string, string>,
  productIds: Record<string, string>,
): Promise<Snapshot> {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });
  const soStatus: Record<string, string> = {};
  const soCommission: Record<string, number> = {};
  for (const [key, id] of Object.entries(sellerOrderIds)) {
    const so = await tx.sellerOrder.findUniqueOrThrow({ where: { id }, select: { status: true, commissionAmount: true } });
    soStatus[key] = so.status;
    soCommission[key] = so.commissionAmount;
  }
  const invQty: Record<string, number> = {};
  for (const [key, id] of Object.entries(offerInventoryIds)) {
    invQty[key] = (await tx.offerInventory.findUniqueOrThrow({ where: { id }, select: { quantity: true } })).quantity;
  }
  const productSoldCount: Record<string, number> = {};
  for (const [key, id] of Object.entries(productIds)) {
    productSoldCount[key] = (await tx.product.findUniqueOrThrow({ where: { id }, select: { soldCount: true } })).soldCount;
  }
  const eventCount = await tx.orderEvent.count({ where: { orderId, status: "CANCELLED" } });
  return { orderStatus: order.status, soStatus, soCommission, invQty, productSoldCount, eventCount };
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

async function reconcileFindingsFor(tx: Prisma.TransactionClient, orderId: string, sellerOrderId: string, soleSellerOnOrder: boolean) {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });
  const so = await tx.sellerOrder.findUniqueOrThrow({
    where: { id: sellerOrderId },
    select: { id: true, sellerType: true, status: true, commissionRate: true, commissionAmount: true, merchandiseSubtotal: true, total: true },
  });
  return evaluateSellerOrder(toReconcileOrder(order.status), toReconcileSellerOrder(so), 0, soleSellerOnOrder);
}

// ── DB behaviour (rolled-back fixtures) ─────────────────────────────────
async function dbTests() {
  console.log("\n── whole-order cancellation safety gate (fixtures rolled back) ──");
  const category = await prisma.category.findFirst({ select: { id: true } });
  if (!category) { ok("(skipped — no category)", true); return; }
  const sfx = "msc-" + String(Date.now()).slice(-7);

  const orderEventsBefore = await prisma.orderEvent.count();
  const offerAdjBefore = await prisma.offerAdjustment.count();
  const sellerOrderCountBefore = await prisma.sellerOrder.count();

  try {
    await prisma.$transaction(async (tx) => {
      // ── A · single-seller cancellable order — unchanged regression ──
      {
        const seller = await mkThirdPartySeller(tx, sfx, "A");
        const line = await mkOfferNativeLine(tx, category.id, seller.id, sfx + "A", { qty: 8, soldCount: 5 });
        const order = await mkMultiSellerOrder(tx, sfx + "A", "PROCESSING", [
          { sellerId: seller.id, soStatus: "PROCESSING", offerId: line.offerId, productId: line.productId, offerInventoryId: line.offerInventoryId, qty: 2 },
        ]);
        const r = await attemptCancel(tx, order.orderId, order.orderNumber);
        ok("A · single-seller cancellable order — cancellation still succeeds", r.ok === true);
        if (r.ok) {
          const so = await tx.sellerOrder.findUniqueOrThrow({ where: { id: order.sellerOrderIds[seller.id] }, select: { status: true, commissionAmount: true } });
          ok("A · SellerOrder → CANCELLED, commission zeroed", so.status === "CANCELLED" && so.commissionAmount === 0);
          const inv = await tx.offerInventory.findUniqueOrThrow({ where: { id: line.offerInventoryId }, select: { quantity: true } });
          ok("A · inventory restored 8 + 2 = 10", inv.quantity === 10);
          const prod = await tx.product.findUniqueOrThrow({ where: { id: line.productId }, select: { soldCount: true } });
          ok("A · soldCount rolled back 5 → 3", prod.soldCount === 3);
        }
      }

      // ── B · multi-seller order, ALL SellerOrders cancellable ──
      {
        const s1 = await mkThirdPartySeller(tx, sfx, "B1");
        const s2 = await mkThirdPartySeller(tx, sfx, "B2");
        const lineB1 = await mkOfferNativeLine(tx, category.id, s1.id, sfx + "B1", { qty: 8, soldCount: 5 });
        const lineB2 = await mkOfferNativeLine(tx, category.id, s2.id, sfx + "B2", { qty: 6, soldCount: 3 });
        const orderB = await mkMultiSellerOrder(tx, sfx + "B", "PROCESSING", [
          { sellerId: s1.id, soStatus: "PROCESSING", offerId: lineB1.offerId, productId: lineB1.productId, offerInventoryId: lineB1.offerInventoryId, qty: 2 },
          { sellerId: s2.id, soStatus: "PENDING_PAYMENT", offerId: lineB2.offerId, productId: lineB2.productId, offerInventoryId: lineB2.offerInventoryId, qty: 1 },
        ]);
        const r = await attemptCancel(tx, orderB.orderId, orderB.orderNumber);
        ok("B · multi-seller, all cancellable (PROCESSING + PENDING_PAYMENT) — whole-order cancel still succeeds", r.ok === true);
        if (r.ok) {
          ok("B · result names BOTH cascaded SellerOrders", r.result.cancelledSellerOrderIds.includes(orderB.sellerOrderIds[s1.id]) && r.result.cancelledSellerOrderIds.includes(orderB.sellerOrderIds[s2.id]));
          const so1 = await tx.sellerOrder.findUniqueOrThrow({ where: { id: orderB.sellerOrderIds[s1.id] }, select: { status: true, commissionAmount: true } });
          const so2 = await tx.sellerOrder.findUniqueOrThrow({ where: { id: orderB.sellerOrderIds[s2.id] }, select: { status: true, commissionAmount: true } });
          ok("B · BOTH SellerOrders → CANCELLED, commission zeroed", so1.status === "CANCELLED" && so1.commissionAmount === 0 && so2.status === "CANCELLED" && so2.commissionAmount === 0);
          const inv1 = await tx.offerInventory.findUniqueOrThrow({ where: { id: lineB1.offerInventoryId }, select: { quantity: true } });
          const inv2 = await tx.offerInventory.findUniqueOrThrow({ where: { id: lineB2.offerInventoryId }, select: { quantity: true } });
          ok("B · BOTH inventories restored (8+2=10, 6+1=7)", inv1.quantity === 10 && inv2.quantity === 7);
          const evCount = await tx.orderEvent.count({ where: { orderId: orderB.orderId, status: "CANCELLED" } });
          ok("B · exactly ONE OrderEvent(CANCELLED) for the whole order (not one per seller)", evCount === 1);

          // ── G (success case) — reconciliation is clean after a full cancel ──
          const f1 = await reconcileFindingsFor(tx, orderB.orderId, orderB.sellerOrderIds[s1.id], false);
          const f2 = await reconcileFindingsFor(tx, orderB.orderId, orderB.sellerOrderIds[s2.id], false);
          ok("G · reconciliation rule A/B clean for BOTH SellerOrders after a full multi-seller cancel", f1.length === 0 && f2.length === 0, JSON.stringify([f1, f2]));
        }
      }

      // ── C · multi-seller order with one SHIPPED SellerOrder — BLOCKED ──
      {
        const s1 = await mkThirdPartySeller(tx, sfx, "C1"); // will be SHIPPED
        const s2 = await mkThirdPartySeller(tx, sfx, "C2"); // still PROCESSING
        const l1 = await mkOfferNativeLine(tx, category.id, s1.id, sfx + "C1", { qty: 8, soldCount: 5 });
        const l2 = await mkOfferNativeLine(tx, category.id, s2.id, sfx + "C2", { qty: 6, soldCount: 3 });
        const order = await mkMultiSellerOrder(tx, sfx + "C", "PROCESSING", [
          { sellerId: s1.id, soStatus: "SHIPPED", offerId: l1.offerId, productId: l1.productId, offerInventoryId: l1.offerInventoryId, qty: 2 },
          { sellerId: s2.id, soStatus: "PROCESSING", offerId: l2.offerId, productId: l2.productId, offerInventoryId: l2.offerInventoryId, qty: 1 },
        ]);
        const invIds = { s1: l1.offerInventoryId, s2: l2.offerInventoryId };
        const prodIds = { s1: l1.productId, s2: l2.productId };
        const so1BeforeFindings = await reconcileFindingsFor(tx, order.orderId, order.sellerOrderIds[s1.id], false);
        const so2BeforeFindings = await reconcileFindingsFor(tx, order.orderId, order.sellerOrderIds[s2.id], false);
        const before = await snapshot(tx, order.orderId, order.sellerOrderIds, invIds, prodIds);

        const r = await attemptCancel(tx, order.orderId, order.orderNumber);
        ok("C · multi-seller with one SHIPPED — cancellation is BLOCKED", r.ok === false && r.blocked === true);
        if (!r.ok && r.blocked) {
          ok("C · error names the SHIPPED SellerOrder as blocking", r.error.blockedSellerOrderIds.includes(order.sellerOrderIds[s1.id]));
          ok("C · error does NOT name the still-PROCESSING SellerOrder", !r.error.blockedSellerOrderIds.includes(order.sellerOrderIds[s2.id]));
        }

        const after = await snapshot(tx, order.orderId, order.sellerOrderIds, invIds, prodIds);
        ok("C · parent Order.status UNCHANGED (still PROCESSING)", after.orderStatus === "PROCESSING" && after.orderStatus === before.orderStatus);
        ok("C · SHIPPED SellerOrder UNCHANGED (still SHIPPED, commission unchanged)", after.soStatus[s1.id] === "SHIPPED" && after.soCommission[s1.id] === before.soCommission[s1.id]);
        ok("C · other SellerOrder UNCHANGED (still PROCESSING, commission unchanged)", after.soStatus[s2.id] === "PROCESSING" && after.soCommission[s2.id] === before.soCommission[s2.id]);
        ok("C · inventory UNCHANGED for both sellers", after.invQty.s1 === before.invQty.s1 && after.invQty.s2 === before.invQty.s2);
        ok("C · Product.soldCount UNCHANGED for both sellers", after.productSoldCount.s1 === before.productSoldCount.s1 && after.productSoldCount.s2 === before.productSoldCount.s2);
        ok("C · no new OrderEvent(CANCELLED) was written", after.eventCount === before.eventCount);

        // F — repeated blocked attempt: identical result, no accumulating drift
        const r2 = await attemptCancel(tx, order.orderId, order.orderNumber);
        ok("F · repeating the SAME blocked attempt is still blocked, identically", r2.ok === false && r2.blocked === true);
        const after2 = await snapshot(tx, order.orderId, order.sellerOrderIds, invIds, prodIds);
        ok("F · repeated blocked attempt leaves state byte-identical to the first blocked attempt", JSON.stringify(after2) === JSON.stringify(after));

        // G (blocked case) — no NEW reconciliation findings introduced by the blocked attempt
        // (rule B may already flag a legitimate in-progress multi-seller "SellerOrder
        // ahead of parent" state pre-existing this fix — we assert no CHANGE, not zero).
        const so1AfterFindings = await reconcileFindingsFor(tx, order.orderId, order.sellerOrderIds[s1.id], false);
        const so2AfterFindings = await reconcileFindingsFor(tx, order.orderId, order.sellerOrderIds[s2.id], false);
        ok("G · reconciliation findings for the SHIPPED SellerOrder are UNCHANGED by the blocked attempt",
          JSON.stringify(so1AfterFindings) === JSON.stringify(so1BeforeFindings), JSON.stringify({ before: so1BeforeFindings, after: so1AfterFindings }));
        ok("G · reconciliation findings for the other SellerOrder are UNCHANGED by the blocked attempt",
          JSON.stringify(so2AfterFindings) === JSON.stringify(so2BeforeFindings), JSON.stringify({ before: so2BeforeFindings, after: so2AfterFindings }));
      }

      // ── D · multi-seller order with one DELIVERED SellerOrder — BLOCKED ──
      {
        const s1 = await mkThirdPartySeller(tx, sfx, "D1"); // will be DELIVERED
        const s2 = await mkThirdPartySeller(tx, sfx, "D2"); // still PENDING_PAYMENT
        const l1 = await mkOfferNativeLine(tx, category.id, s1.id, sfx + "D1", { qty: 4, soldCount: 2 });
        const l2 = await mkOfferNativeLine(tx, category.id, s2.id, sfx + "D2", { qty: 5, soldCount: 1 });
        const order = await mkMultiSellerOrder(tx, sfx + "D", "PROCESSING", [
          { sellerId: s1.id, soStatus: "DELIVERED", offerId: l1.offerId, productId: l1.productId, offerInventoryId: l1.offerInventoryId, qty: 1 },
          { sellerId: s2.id, soStatus: "PENDING_PAYMENT", offerId: l2.offerId, productId: l2.productId, offerInventoryId: l2.offerInventoryId, qty: 1 },
        ]);
        const invIds = { s1: l1.offerInventoryId, s2: l2.offerInventoryId };
        const prodIds = { s1: l1.productId, s2: l2.productId };
        const before = await snapshot(tx, order.orderId, order.sellerOrderIds, invIds, prodIds);

        const r = await attemptCancel(tx, order.orderId, order.orderNumber);
        ok("D · multi-seller with one DELIVERED — cancellation is BLOCKED", r.ok === false && r.blocked === true);
        if (!r.ok && r.blocked) {
          ok("D · error names the DELIVERED SellerOrder as blocking", r.error.blockedSellerOrderIds.includes(order.sellerOrderIds[s1.id]));
        }

        const after = await snapshot(tx, order.orderId, order.sellerOrderIds, invIds, prodIds);
        ok("D · parent Order.status UNCHANGED (still PROCESSING)", after.orderStatus === "PROCESSING");
        ok("D · DELIVERED SellerOrder UNCHANGED (still DELIVERED, commission unchanged — the core bug this fix closes)", after.soStatus[s1.id] === "DELIVERED" && after.soCommission[s1.id] === before.soCommission[s1.id]);
        ok("D · other SellerOrder UNCHANGED (still PENDING_PAYMENT)", after.soStatus[s2.id] === "PENDING_PAYMENT");
        ok("D · inventory UNCHANGED for the DELIVERED seller (would have been wrongly restored pre-fix)", after.invQty.s1 === before.invQty.s1);
        ok("D · Product.soldCount UNCHANGED for the DELIVERED seller", after.productSoldCount.s1 === before.productSoldCount.s1);
        ok("D · no new OrderEvent(CANCELLED) was written", after.eventCount === before.eventCount);
      }

      // ── E · mixed 1P + 3P, DELIVERED 3P leg — BLOCKED, no FIRST_PARTY bypass ──
      {
        const axiaro = await tx.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
        if (!axiaro) {
          ok("E (skipped — no FIRST_PARTY seller row found)", true);
        } else {
          const s3p = await mkThirdPartySeller(tx, sfx, "E3P"); // will be DELIVERED
          const l3p = await mkOfferNativeLine(tx, category.id, s3p.id, sfx + "E3P", { qty: 4, soldCount: 2 });
          const product1p = await tx.product.create({
            data: { name: `P1P ${sfx}`, slug: `p1p-${sfx}-${rand()}`, shortDescription: "s", description: "d", categoryId: category.id, status: "ACTIVE", price: 1000, soldCount: 1 },
            select: { id: true },
          });
          const order = await tx.order.create({
            data: {
              orderNumber: `AX-MSC-${sfx}E-${rand()}`, email: "buyer@example.test", phone: "+639000000000",
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
            data: { orderId: order.id, sellerId: s3p.id, sellerName: "S", sellerType: "THIRD_PARTY", supportEmail: "s@t.test", merchandiseSubtotal: 1000, shippingFee: 0, total: 1000, commissionRate: 1500, commissionAmount: 150, status: "DELIVERED" },
            select: { id: true },
          });
          await tx.orderItem.create({ data: { orderId: order.id, sellerOrderId: so3p.id, sellerId: s3p.id, productId: l3p.productId, offerId: l3p.offerId, name: "3P item", unitPrice: 1000, quantity: 1, lineTotal: 1000 } });
          await markSaleAdjustment(tx, l3p.offerInventoryId, order.orderNumber, 1);

          const sellerOrderIds = { [axiaro.id]: so1p.id, [s3p.id]: so3p.id };
          const invIds = { threeP: l3p.offerInventoryId };
          const prodIds = { oneP: product1p.id, threeP: l3p.productId };
          const before = await snapshot(tx, order.id, sellerOrderIds, invIds, prodIds);

          const r = await attemptCancel(tx, order.id, order.orderNumber);
          ok("E · mixed 1P+3P with the 3P leg DELIVERED — cancellation is BLOCKED", r.ok === false && r.blocked === true);
          if (!r.ok && r.blocked) {
            ok("E · error names the DELIVERED 3P SellerOrder", r.error.blockedSellerOrderIds.includes(so3p.id));
          }
          const after = await snapshot(tx, order.id, sellerOrderIds, invIds, prodIds);
          ok("E · parent Order.status UNCHANGED", after.orderStatus === "PROCESSING");
          ok("E · FIRST_PARTY SellerOrder UNCHANGED — no special bypass for Axiaro's own leg", after.soStatus[axiaro.id] === "PROCESSING" && after.soCommission[axiaro.id] === before.soCommission[axiaro.id]);
          ok("E · THIRD_PARTY (DELIVERED) SellerOrder UNCHANGED", after.soStatus[s3p.id] === "DELIVERED" && after.soCommission[s3p.id] === before.soCommission[s3p.id]);
          ok("E · 1P Product.soldCount UNCHANGED (no partial reversal of the unaffected leg)", after.productSoldCount.oneP === before.productSoldCount.oneP);
          ok("E · 3P inventory UNCHANGED", after.invQty.threeP === before.invQty.threeP);
        }
      }

      // ── F (continued) — the ORIGINAL idempotency guarantee is untouched ──
      {
        // Re-use order A's already-fully-cancelled state implicitly isn't possible
        // (block-scoped), so build a small dedicated fixture mirroring test-9f30d's
        // existing IDEMPOTENCY case: successful cancel, then the atomic gate alone
        // (no SellerOrderNotCancellableError involved) must match 0 rows.
        const seller = await mkThirdPartySeller(tx, sfx, "F");
        const line = await mkOfferNativeLine(tx, category.id, seller.id, sfx + "F", { qty: 5, soldCount: 2 });
        const order = await mkMultiSellerOrder(tx, sfx + "F", "PROCESSING", [
          { sellerId: seller.id, soStatus: "PROCESSING", offerId: line.offerId, productId: line.productId, offerInventoryId: line.offerInventoryId, qty: 1 },
        ]);
        const r = await attemptCancel(tx, order.orderId, order.orderNumber);
        ok("F · setup — first cancel succeeds", r.ok === true);
        const gate2 = await tx.$executeRaw`UPDATE "Order" SET "status" = 'CANCELLED' WHERE "id" = ${order.orderId} AND "status" IN ('PENDING_PAYMENT', 'PENDING', 'PROCESSING')`;
        ok("F · re-running the atomic gate matches 0 rows (idempotency gate itself unchanged by this fix)", gate2 === 0);
        const inv = await tx.offerInventory.findUniqueOrThrow({ where: { id: line.offerInventoryId }, select: { quantity: true } });
        ok("F · no double restore on the repeat attempt (5+1=6, not 7)", inv.quantity === 6);
      }

      throw new Rollback();
    }, { timeout: 120000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("ROLLBACK · no OrderEvent leaked", (await prisma.orderEvent.count()) === orderEventsBefore);
  ok("ROLLBACK · no OfferAdjustment leaked", (await prisma.offerAdjustment.count()) === offerAdjBefore);
  ok("ROLLBACK · no SellerOrder leaked", (await prisma.sellerOrder.count()) === sellerOrderCountBefore);
  ok("ROLLBACK · no fixture order leaked", (await prisma.order.count({ where: { orderNumber: { contains: sfx } } })) === 0);
}

async function main() {
  console.log("\nMULTI-SELLER CANCELLATION SAFETY FIX — regression tests\n");
  pureTests();
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
