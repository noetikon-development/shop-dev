/**
 * PHASE 9F-30D — customer self-service order cancellation.
 *
 * An authenticated customer can cancel their OWN order while it is
 * PENDING_PAYMENT / PENDING / PROCESSING. The reversal reuses the exact
 * architecture the admin `cancelOrderAction` runs, lifted into the shared
 * `reverseCancelledOrder(tx, …)` helper: OfferInventory / Inventory restore +
 * `OfferAdjustment(CANCELLATION)` + `Product.soldCount` rollback + SellerOrder
 * cascade (commission zeroed, clawback where settled) + one `OrderEvent`. The
 * action wraps it with `getCurrentUser` + ownership-by-(orderNumber,userId) + an
 * atomic `UPDATE "Order" … WHERE status IN (cancellable)` idempotency gate, then
 * post-commit audits it, emails the customer (`sendOrderCancelled`) and every 3P
 * seller whose SellerOrder cascaded (`sendSellerOrderCancelled`).
 *
 * DB tests build fixtures inside ONE prisma.$transaction and roll back;
 * `reverseCancelledOrder` takes that tx directly. The action itself is
 * cookie-gated (`getCurrentUser`) so it is asserted statically — same posture as
 * test-9f30b for `sellerCancelOrderAction`.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f30d.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient, Prisma } from "@prisma/client";
import { reverseCancelledOrder } from "@/lib/orders/cancellation";
import { CANCELLABLE_STATUSES, isCancellable, canTransition } from "@/lib/orders/status";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
class Rollback extends Error {}

// ── pure ────────────────────────────────────────────────────────────────
function pureTests() {
  console.log("\n── pure — cancellable set ──");
  ok("CANCELLABLE_STATUSES = [PENDING_PAYMENT, PENDING, PROCESSING]",
    JSON.stringify(CANCELLABLE_STATUSES) === JSON.stringify(["PENDING_PAYMENT", "PENDING", "PROCESSING"]));
  ok("isCancellable true for the three pre-shipment statuses",
    ["PENDING_PAYMENT", "PENDING", "PROCESSING"].every(isCancellable));
  ok("isCancellable false once shipped / terminal",
    !["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED", "PAID"].some(isCancellable));
  ok("PAID is NOT cancellable (an online-paid order can't be self-cancelled — implies a refund)",
    !isCancellable("PAID") && !canTransition("PAID", "CANCELLED"));
}

// ── static wiring ───────────────────────────────────────────────────────
function staticTests() {
  console.log("\n── static wiring ──");
  const helper = read("src/lib/orders/cancellation.ts");
  const action = read("src/lib/account/order-actions.ts");
  const adminActions = read("src/lib/admin/order-actions.ts");
  const sellerRepo = read("src/lib/marketplace/seller-order-repository.ts");
  const page = read("src/app/(shop)/account/orders/[orderNumber]/page.tsx");
  const panel = read("src/components/order/customer-cancel-order.tsx");
  const schema = read("prisma/schema.prisma");

  // helper — faithful lift, no payment / returns touch
  ok("helper · restores OfferInventory per OrderItem.offerId with restoreOfferStock reason CANCELLATION",
    /restoreOfferStock\(\s*\{\s*offerId: it\.offerId,\s*units: it\.quantity,\s*reason: "CANCELLATION"/.test(helper));
  ok("helper · keeps the LEGACY InventoryAdjustment fallback (adjustStock, reason CANCELLATION)",
    /reason: "SALE", note: `Order \$\{orderNumber\}` \}[\s\S]{0,600}adjustStock\(\s*\{[\s\S]{0,200}reason: "CANCELLATION"/.test(helper));
  ok("helper · rolls Product.soldCount back, never below zero",
    /UPDATE "Product" SET "soldCount" = GREATEST\(0, "soldCount" - \$\{qty\}\)/.test(helper));
  ok("helper · SellerOrder cascade zeroes commission in the same guarded write (9F-8c shape)",
    /data: \{ status: "CANCELLED", updatedAt: new Date\(\), commissionAmount: 0 \}/.test(helper));
  ok("helper · settled SellerOrder → clawback (9F-8e shape, symmetric with admin)",
    /if \(so\.settlementId === null\) continue;\s*\n\s*const delta = Math\.max\(0, so\.total - so\.commissionAmount\);[\s\S]{0,400}settlementStatus: "CLAWED_BACK",\s*\n?\s*settlementClawbackAmount: \{ increment: delta \}/.test(helper));
  ok("helper · one OrderEvent(CANCELLED) with the caller-supplied detail",
    /orderEvent\.create\(\{\s*\n\s*data: \{\s*\n\s*orderId,\s*\n\s*status: "CANCELLED",\s*\n\s*title: "Order cancelled",\s*\n\s*detail: args\.eventDetail/.test(helper));
  ok("helper · never touches payments / paymentStatus / returns / refunds (code, not comments)",
    !/paymentStatus|paymentMethod|\.payment\b|paymentRefund|returnRequest|returnItem/i.test(
      helper.split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/*")).join("\n"),
    ));

  // action — auth + ownership + gate + reuse
  ok("action · resolves the user server-side (getCurrentUser), client never sends a userId",
    /const user = await getCurrentUser\(\);/.test(action) && !/formData\.get\(["']userId/.test(action));
  ok("action · ownership is by (orderNumber, userId) — never order number alone",
    /prisma\.order\.findFirst\(\{\s*\n\s*where: \{ orderNumber, userId: user\.id \}/.test(action));
  ok("action · re-checks isCancellable before doing anything",
    /if \(!isCancellable\(order\.status\)\)/.test(action));
  ok("action · the idempotency gate is the atomic status-IN UPDATE, 0 rows → StaleOrderError",
    /UPDATE "Order" SET "status" = 'CANCELLED"?[\s\S]{0,140}"status" IN \('PENDING_PAYMENT', 'PENDING', 'PROCESSING'\)/.test(action) &&
    /if \(cancelled === 0\) throw new StaleOrderError\(\)/.test(action));
  ok("action · runs the shared reverseCancelledOrder inside that same transaction",
    /reverseCancelledOrder\(tx, \{/.test(action));
  ok("action · emails the customer with the existing sendOrderCancelled (keyed per order)",
    /scheduleEmail\(\(\) => sendOrderCancelled\(order\.id, reason\)\)/.test(action));
  ok("action · emails every cascaded 3P seller (customer cancelled → seller IS told)",
    /for \(const sellerOrderId of result\.cancelledSellerOrderIds\) \{\s*\n\s*scheduleEmail\(\(\) => sendSellerOrderCancelled\(sellerOrderId\)\)/.test(action));
  ok("action · audit trigger names the customer self-service path",
    /action: "order\.cancelled"[\s\S]{0,400}trigger: "customer_self_service"/.test(action));
  ok("action · never writes paymentStatus / paymentMethod / touches checkout / returns / settlements",
    !/paymentStatus|paymentMethod|checkout|returnRequest|sellerSettlement/i.test(action));
  ok("action · rate-limited per user",
    /hitRateLimit\(`cancel:user:\$\{user\.id\}`/.test(action));

  // scope — siblings untouched
  ok("scope · admin cancelOrderAction NOT modified (still its own inline reversal)",
    !/9F-30D/.test(adminActions) &&
    /const toCancel = await tx\.sellerOrder\.findMany/.test(adminActions) &&
    /scheduleEmail\(\(\) => sendOrderCancelled\(orderId, reason \?\? null\)\)/.test(adminActions));
  ok("scope · seller sellerCancelSellerOrder (9F-30B) NOT modified",
    !/9F-30D/.test(sellerRepo));
  ok("scope · checkout NOT modified", !/9F-30D/.test(read("src/lib/checkout.ts")));
  ok("scope · returns / settlements NOT modified",
    !/9F-30D/.test(read("src/lib/returns-actions.ts")) &&
    !/9F-30D/.test(read("src/lib/admin/returns-actions.ts")) &&
    !/9F-30D/.test(read("src/lib/admin/settlement-actions.ts")));
  ok("scope · no schema change", !/9F-30D/.test(schema));
  ok("scope · seed-rbac.ts untouched", !/9F-30D/.test(read("scripts/seed-rbac.ts")));
  ok("scope · no bare src/lib/order-actions.ts introduced",
    (() => { try { read("src/lib/order-actions.ts"); return false; } catch { return true; } })());

  // UI
  ok("page · CustomerCancelOrder rendered only when isCancellable(order.status)",
    /\{isCancellable\(order\.status\) && <CustomerCancelOrder orderNumber=\{order\.orderNumber\} \/>\}/.test(page));
  ok("panel · confirmation dialog (role=dialog, aria-modal) explains it can't be undone",
    /role="dialog"/.test(panel) && /aria-modal="true"/.test(panel) && /can&apos;t be undone/i.test(panel));
  ok("panel · reason is OPTIONAL (no required attribute, labelled optional)",
    /\(optional\)/.test(panel) && !/<textarea[^>]*\brequired\b/.test(panel));
  ok("panel · calls customerCancelOrderAction and refreshes on success",
    /customerCancelOrderAction\(\{ orderNumber, reason: reason\.trim\(\) \}\)/.test(panel) && /router\.refresh\(\)/.test(panel));
}

// ── DB behaviour (rolled-back fixtures) ─────────────────────────────────
async function dbTests() {
  console.log("\n── reverseCancelledOrder + the action's gate (fixtures rolled back) ──");
  const category = await prisma.category.findFirst({ select: { id: true } });
  if (!category) { ok("(skipped — no category)", true); return; }
  const sfx = "9f30d-" + String(Date.now()).slice(-7);

  const orderEventsBefore = await prisma.orderEvent.count();
  const offerAdjBefore = await prisma.offerAdjustment.count();
  const invAdjBefore = await prisma.inventoryAdjustment.count();

  async function seed3pOffer(tx: Prisma.TransactionClient, sellerId: string, o: { soldCount?: number; qty?: number } = {}) {
    const product = await tx.product.create({
      data: { name: `P ${sfx}`, slug: `p-${sfx}-${Math.random().toString(36).slice(2, 7)}`, shortDescription: "s", description: "d", categoryId: category!.id, status: "ACTIVE", price: 1000, soldCount: o.soldCount ?? 0 },
      select: { id: true },
    });
    const variant = await tx.variant.create({
      data: { productId: product.id, sku: `v-${sfx}-${Math.random().toString(36).slice(2, 7)}`, price: 1000, status: "ACTIVE", stock: 0 },
      select: { id: true, sku: true },
    });
    const offer = await tx.offer.create({
      data: { sellerId, variantId: variant.id, price: 1000, condition: "NEW", status: "ACTIVE", sellerSku: `os-${sfx}-${Math.random().toString(36).slice(2, 7)}` },
      select: { id: true },
    });
    const inv = await tx.offerInventory.create({ data: { offerId: offer.id, sellerSku: null, quantity: o.qty ?? 8, reserved: 0, reorderPoint: 3 }, select: { id: true } });
    return { productId: product.id, variantId: variant.id, sku: variant.sku, offerId: offer.id, offerInventoryId: inv.id };
  }

  async function seedOrder(
    tx: Prisma.TransactionClient,
    spec: { userId: string | null; parentStatus: string; sellerId: string; sellerType?: string; soStatus?: string; settlementId?: string | null; commissionAmount?: number; lines: { offerId?: string; productId: string; qty: number }[] },
  ) {
    const order = await tx.order.create({
      data: {
        orderNumber: `AX-T30D-${sfx}-${Math.random().toString(36).slice(2, 5)}`,
        userId: spec.userId, email: "buyer@example.test", phone: "+639000000000",
        status: spec.parentStatus, paymentStatus: "PENDING", paymentMethod: "COD",
        subtotal: 1000, grandTotal: 1150, shippingFee: 150,
        shippingAddress: JSON.stringify({ firstName: "T", lastName: "B", line1: "1 St", city: "Manila", province: "NCR", postalCode: "1000", country: "PH" }),
      },
      select: { id: true, orderNumber: true },
    });
    const so = await tx.sellerOrder.create({
      data: {
        orderId: order.id, sellerId: spec.sellerId, sellerName: "S", sellerType: spec.sellerType ?? "THIRD_PARTY", supportEmail: "s@t.test",
        merchandiseSubtotal: 1000, shippingFee: 150, total: 1150, commissionRate: 1500,
        commissionAmount: spec.commissionAmount ?? 150, status: spec.soStatus ?? "PROCESSING",
        settlementId: spec.settlementId ?? null,
      },
      select: { id: true },
    });
    for (const ln of spec.lines) {
      await tx.orderItem.create({
        data: { orderId: order.id, sellerOrderId: so.id, sellerId: spec.sellerId, productId: ln.productId, offerId: ln.offerId ?? null, name: "Item", unitPrice: 1000, quantity: ln.qty, lineTotal: ln.qty * 1000 },
      });
    }
    return { orderId: order.id, orderNumber: order.orderNumber, sellerOrderId: so.id };
  }

  /** Record the SALE OfferAdjustment checkout would have written, so the helper detects offer-native. */
  async function markOfferNativeSale(tx: Prisma.TransactionClient, offerInventoryId: string, orderNumber: string, units: number) {
    const invRow = await tx.offerInventory.findUniqueOrThrow({ where: { id: offerInventoryId }, select: { quantity: true } });
    await tx.offerAdjustment.create({
      data: { offerInventoryId, previousQuantity: invRow.quantity + units, delta: -units, newQuantity: invRow.quantity, reason: "SALE", note: `Order ${orderNumber}` },
    });
  }

  try {
    await prisma.$transaction(async (tx) => {
      const S1 = await tx.seller.create({ data: { type: "THIRD_PARTY", status: "APPROVED", displayName: `S1 ${sfx}`, slug: `s1-${sfx}`, supportEmail: "s1@t.test" }, select: { id: true } });
      const userA = await tx.user.create({ data: { email: `a-${sfx}@t.test`, name: "A" }, select: { id: true } });
      const userB = await tx.user.create({ data: { email: `b-${sfx}@t.test`, name: "B" }, select: { id: true } });

      // ── ownership: findFirst by (orderNumber, userId) — the action's exact query ──
      {
        const of = await seed3pOffer(tx, S1.id);
        const o = await seedOrder(tx, { userId: userA.id, parentStatus: "PROCESSING", sellerId: S1.id, lines: [{ offerId: of.offerId, productId: of.productId, qty: 1 }] });
        const asOwner = await tx.order.findFirst({ where: { orderNumber: o.orderNumber, userId: userA.id }, select: { id: true } });
        const asOther = await tx.order.findFirst({ where: { orderNumber: o.orderNumber, userId: userB.id }, select: { id: true } });
        ok("AUTHZ · owner resolves the order by (orderNumber, userId)", asOwner?.id === o.orderId);
        ok("AUTHZ · a different customer gets NOTHING for the same order number", asOther === null);
      }

      // ── status gate: the action's atomic UPDATE succeeds only from the cancellable set ──
      for (const st of ["PENDING_PAYMENT", "PENDING", "PROCESSING"]) {
        const of = await seed3pOffer(tx, S1.id);
        const o = await seedOrder(tx, { userId: userA.id, parentStatus: st, sellerId: S1.id, lines: [{ offerId: of.offerId, productId: of.productId, qty: 1 }] });
        const n = await tx.$executeRaw`UPDATE "Order" SET "status" = 'CANCELLED' WHERE "id" = ${o.orderId} AND "status" IN ('PENDING_PAYMENT', 'PENDING', 'PROCESSING')`;
        ok(`${st} · atomic gate cancels (1 row)`, n === 1);
      }
      for (const st of ["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED"]) {
        const of = await seed3pOffer(tx, S1.id);
        const o = await seedOrder(tx, { userId: userA.id, parentStatus: st === "CANCELLED" ? "PROCESSING" : st, sellerId: S1.id, lines: [{ offerId: of.offerId, productId: of.productId, qty: 1 }] });
        if (st === "CANCELLED") await tx.$executeRaw`UPDATE "Order" SET "status" = 'CANCELLED' WHERE "id" = ${o.orderId}`;
        const n = await tx.$executeRaw`UPDATE "Order" SET "status" = 'CANCELLED' WHERE "id" = ${o.orderId} AND "status" IN ('PENDING_PAYMENT', 'PENDING', 'PROCESSING')`;
        ok(`${st} BLOCKED · atomic gate matches 0 rows`, n === 0);
      }

      // ── offer-native reversal + full flow ──
      {
        const of = await seed3pOffer(tx, S1.id, { soldCount: 5, qty: 8 });
        const o = await seedOrder(tx, { userId: userA.id, parentStatus: "PROCESSING", sellerId: S1.id, commissionAmount: 150, lines: [{ offerId: of.offerId, productId: of.productId, qty: 2 }] });
        await markOfferNativeSale(tx, of.offerInventoryId, o.orderNumber, 2);

        // simulate the action: atomic gate, then the shared helper
        const gate = await tx.$executeRaw`UPDATE "Order" SET "status" = 'CANCELLED' WHERE "id" = ${o.orderId} AND "status" IN ('PENDING_PAYMENT', 'PENDING', 'PROCESSING')`;
        ok("flow · gate cancelled the order", gate === 1);
        const r = await reverseCancelledOrder(tx, { orderId: o.orderId, orderNumber: o.orderNumber, actorUserId: userA.id, adjustmentNote: `Order ${o.orderNumber} cancelled by the customer`, eventDetail: "Cancelled by the customer." });

        ok("INVENTORY · reversalPath = offer-native", r.reversalPath === "offer-native");
        ok("INVENTORY · OfferInventory restored 8 → 10", (await tx.offerInventory.findUnique({ where: { id: of.offerInventoryId }, select: { quantity: true } }))?.quantity === 10);
        const cxl = await tx.offerAdjustment.findMany({ where: { offerInventoryId: of.offerInventoryId, reason: "CANCELLATION" }, select: { delta: true } });
        ok("INVENTORY · exactly ONE OfferAdjustment(CANCELLATION), delta +2", cxl.length === 1 && cxl[0].delta === 2);
        ok("SOLDCOUNT · Product.soldCount 5 → 3", (await tx.product.findUnique({ where: { id: of.productId }, select: { soldCount: true } }))?.soldCount === 3);
        const so = await tx.sellerOrder.findUnique({ where: { id: o.sellerOrderId }, select: { status: true, commissionAmount: true } });
        ok("CASCADE · SellerOrder → CANCELLED, commission zeroed", so?.status === "CANCELLED" && so?.commissionAmount === 0);
        ok("CASCADE · result names the cascaded SellerOrder for seller notification", r.cancelledSellerOrderIds.includes(o.sellerOrderId));
        ok("CASCADE · no clawback (unsettled)", r.clawbackEvents.length === 0);
        const ev = await tx.orderEvent.findMany({ where: { orderId: o.orderId, status: "CANCELLED" }, select: { title: true } });
        ok("EVENT · exactly ONE OrderEvent(CANCELLED)", ev.length === 1 && ev[0].title === "Order cancelled");
        const ord = await tx.order.findUnique({ where: { id: o.orderId }, select: { status: true, paymentStatus: true, paymentMethod: true } });
        ok("PAYMENT · paymentStatus / paymentMethod untouched (COD stays PENDING/COD)", ord?.paymentStatus === "PENDING" && ord?.paymentMethod === "COD");

        // ── IDEMPOTENCY: re-run the gate → 0 rows, helper not reached ──
        const gate2 = await tx.$executeRaw`UPDATE "Order" SET "status" = 'CANCELLED' WHERE "id" = ${o.orderId} AND "status" IN ('PENDING_PAYMENT', 'PENDING', 'PROCESSING')`;
        ok("IDEMPOTENCY · second gate matches 0 rows (status already CANCELLED)", gate2 === 0);
        ok("IDEMPOTENCY · OfferInventory still 10 (no double restore)", (await tx.offerInventory.findUnique({ where: { id: of.offerInventoryId }, select: { quantity: true } }))?.quantity === 10);
        ok("IDEMPOTENCY · still one CANCELLATION adjustment, one OrderEvent",
          (await tx.offerAdjustment.count({ where: { offerInventoryId: of.offerInventoryId, reason: "CANCELLATION" } })) === 1 &&
          (await tx.orderEvent.count({ where: { orderId: o.orderId, status: "CANCELLED" } })) === 1);
      }

      // ── legacy (InventoryAdjustment) reversal path ──
      {
        const product = await tx.product.create({ data: { name: `PL ${sfx}`, slug: `pl-${sfx}-${Math.random().toString(36).slice(2, 7)}`, shortDescription: "s", description: "d", categoryId: category!.id, status: "ACTIVE", price: 1000, soldCount: 4 }, select: { id: true } });
        const variant = await tx.variant.create({ data: { productId: product.id, sku: `vl-${sfx}`, price: 1000, status: "ACTIVE", stock: 6 }, select: { id: true } });
        const invRow = await tx.inventory.create({ data: { variantId: variant.id, sku: `vl-${sfx}`, quantity: 6, reserved: 0, reorderPoint: 3 }, select: { id: true } });
        const order = await tx.order.create({ data: { orderNumber: `AX-T30D-LEG-${sfx}`, userId: userA.id, email: "b@e.test", phone: "+630", status: "PROCESSING", paymentStatus: "PENDING", paymentMethod: "COD", subtotal: 3000, grandTotal: 3000, shippingFee: 0, shippingAddress: "{}" }, select: { id: true, orderNumber: true } });
        await tx.orderItem.create({ data: { orderId: order.id, productId: product.id, name: "Legacy", unitPrice: 1000, quantity: 3, lineTotal: 3000 } });
        await tx.inventoryAdjustment.create({ data: { inventoryId: invRow.id, previousQuantity: 9, delta: -3, newQuantity: 6, reason: "SALE", note: `Order ${order.orderNumber}` } });

        await tx.$executeRaw`UPDATE "Order" SET "status" = 'CANCELLED' WHERE "id" = ${order.id} AND "status" IN ('PENDING_PAYMENT', 'PENDING', 'PROCESSING')`;
        const r = await reverseCancelledOrder(tx, { orderId: order.id, orderNumber: order.orderNumber, actorUserId: userA.id, adjustmentNote: `Order ${order.orderNumber} cancelled by the customer`, eventDetail: "Cancelled by the customer." });
        ok("LEGACY · reversalPath = legacy", r.reversalPath === "legacy");
        ok("LEGACY · Inventory restored 6 → 9 via adjustStock", (await tx.inventory.findUnique({ where: { id: invRow.id }, select: { quantity: true } }))?.quantity === 9);
        ok("LEGACY · one CANCELLATION InventoryAdjustment", (await tx.inventoryAdjustment.count({ where: { inventoryId: invRow.id, reason: "CANCELLATION" } })) === 1);
        ok("LEGACY · soldCount 4 → 1", (await tx.product.findUnique({ where: { id: product.id }, select: { soldCount: true } }))?.soldCount === 1);
      }

      // ── settled SellerOrder → clawback ──
      {
        const settlement = await tx.sellerSettlement.create({
          data: { sellerId: S1.id, sellerName: "S1", status: "PAID", grossReceivable: 1150, commissionAmount: 150, clawbackAmount: 0, netAmount: 1000, orderCount: 1, paidAt: new Date() },
          select: { id: true },
        });
        const of = await seed3pOffer(tx, S1.id, { soldCount: 2, qty: 5 });
        const o = await seedOrder(tx, { userId: userA.id, parentStatus: "PROCESSING", sellerId: S1.id, settlementId: settlement.id, commissionAmount: 150, lines: [{ offerId: of.offerId, productId: of.productId, qty: 1 }] });
        await markOfferNativeSale(tx, of.offerInventoryId, o.orderNumber, 1);
        await tx.$executeRaw`UPDATE "Order" SET "status" = 'CANCELLED' WHERE "id" = ${o.orderId} AND "status" IN ('PENDING_PAYMENT', 'PENDING', 'PROCESSING')`;
        const r = await reverseCancelledOrder(tx, { orderId: o.orderId, orderNumber: o.orderNumber, actorUserId: userA.id, adjustmentNote: "x", eventDetail: "Cancelled by the customer." });
        ok("CLAWBACK · settled SellerOrder accrues a clawback event", r.clawbackEvents.length === 1 && r.clawbackEvents[0].sellerOrderId === o.sellerOrderId);
        const so = await tx.sellerOrder.findUnique({ where: { id: o.sellerOrderId }, select: { settlementStatus: true, settlementClawbackAmount: true, commissionAmount: true } });
        ok("CLAWBACK · SellerOrder CLAWED_BACK, delta = total - commission = 1000, commission zeroed",
          so?.settlementStatus === "CLAWED_BACK" && so?.settlementClawbackAmount === 1000 && so?.commissionAmount === 0);
      }

      throw new Rollback();
    }, { timeout: 120000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("ROLLBACK · no OrderEvent leaked", (await prisma.orderEvent.count()) === orderEventsBefore);
  ok("ROLLBACK · no OfferAdjustment leaked", (await prisma.offerAdjustment.count()) === offerAdjBefore);
  ok("ROLLBACK · no InventoryAdjustment leaked", (await prisma.inventoryAdjustment.count()) === invAdjBefore);
  ok("ROLLBACK · no fixture order leaked", (await prisma.order.count({ where: { orderNumber: { contains: sfx } } })) === 0);
}

async function main() {
  console.log("\nPHASE 9F-30D — customer self-service order cancellation\n");
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
