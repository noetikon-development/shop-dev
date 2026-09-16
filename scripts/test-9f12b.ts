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
  sellerCancelSellerOrder,
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
  sellers: { id: string; soStatus: string; withShipment: boolean; sellerType?: string }[],
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
        sellerType: s.sellerType ?? "THIRD_PARTY",
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

/**
 * 9F-44E — CANCELLED SellerOrders are non-blocking for the child→parent rollup.
 *
 * A cancelled seller previously froze `rollUpParentOrder`'s "every SellerOrder"
 * check forever (a CANCELLED row satisfies neither "shipped or beyond" nor
 * "= DELIVERED"), so a multi-seller order with one cancelled seller could never
 * auto-roll to SHIPPED/DELIVERED even once every remaining ACTIVE seller
 * finished. The fix scopes both `every()` checks to `active` (non-CANCELLED)
 * SellerOrders, with an explicit empty-`active` guard so an all-cancelled order
 * is never rolled here — that transition belongs to the EXISTING cancellation
 * cascade (`sellerCancelSellerOrder`'s last-active-seller lock), exercised
 * directly (not re-implemented) in scenario E below.
 *
 * Same rolled-back-transaction discipline as `dbTests()` — nothing persists.
 */
async function cancelledAwareRollupTests() {
  const suffix = "e" + String(Date.now()).slice(-6);

  try {
    await prisma.$transaction(async (tx) => {
      const S1 = await tx.seller.create({ data: { type: "THIRD_PARTY", status: "APPROVED", displayName: "S1", slug: `s1-9f44e-${suffix}`, supportEmail: "s1@t.test" } });
      const S2 = await tx.seller.create({ data: { type: "THIRD_PARTY", status: "APPROVED", displayName: "S2", slug: `s2-9f44e-${suffix}`, supportEmail: "s2@t.test" } });
      // A third THIRD_PARTY seller for the plain three-seller scenarios (G/H/I).
      const S3 = await tx.seller.create({ data: { type: "THIRD_PARTY", status: "APPROVED", displayName: "S3", slug: `s3-9f44e-${suffix}`, supportEmail: "s3@t.test" } });
      // `Seller.type` has a partial-unique index — the database allows only ONE
      // FIRST_PARTY row (the real Axiaro seller). Read it (read-only; never
      // created/updated/deleted here) for the dedicated mixed-1P+3P scenario
      // below, instead of trying to create a second FIRST_PARTY row.
      const axiaro = await tx.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
      const c1 = ctxFor(S1.id);
      const c2 = ctxFor(S2.id);
      const c3 = ctxFor(S3.id);

      // ── A · CANCELLED + PROCESSING → parent remains PROCESSING ───────────
      // (B hasn't shipped/delivered yet — nothing to roll regardless of A.)
      {
        const o = await makeOrderWithSellerOrders(
          tx,
          [
            { id: S1.id, soStatus: "CANCELLED", withShipment: false },
            { id: S2.id, soStatus: "PROCESSING", withShipment: false },
          ],
          "PROCESSING",
          suffix + "A",
        );
        const status = (await tx.order.findUnique({ where: { id: o.orderId }, select: { status: true } }))?.status;
        ok("A · CANCELLED + PROCESSING → parent stays PROCESSING (nothing to roll)", status === "PROCESSING");
      }

      // ── B · CANCELLED + SHIPPED → parent rolls to SHIPPED ─────────────────
      {
        const o = await makeOrderWithSellerOrders(
          tx,
          [
            { id: S1.id, soStatus: "CANCELLED", withShipment: false },
            { id: S2.id, soStatus: "READY_TO_SHIP", withShipment: true },
          ],
          "PROCESSING",
          suffix + "B",
        );
        const r = await advanceSellerOrderStatus(c2, o.sellerOrders[1], "SHIPPED", tx);
        ok("B · advancing the active seller to SHIPPED succeeds despite a CANCELLED sibling", r.ok === true, JSON.stringify(r));
        ok("B · parent rolls to SHIPPED — the CANCELLED sibling did not block it", r.ok === true && r.parentOrder?.rolledTo === "SHIPPED");
        const status = (await tx.order.findUnique({ where: { id: o.orderId }, select: { status: true } }))?.status;
        ok("B · parent Order.status = SHIPPED", status === "SHIPPED");
      }

      // ── C · CANCELLED + DELIVERED → parent rolls to DELIVERED ─────────────
      {
        const o = await makeOrderWithSellerOrders(
          tx,
          [
            { id: S1.id, soStatus: "CANCELLED", withShipment: false },
            { id: S2.id, soStatus: "READY_TO_SHIP", withShipment: true },
          ],
          "PROCESSING",
          suffix + "C",
        );
        const rShip = await advanceSellerOrderStatus(c2, o.sellerOrders[1], "SHIPPED", tx);
        ok("C · active seller ships first (parent → SHIPPED)", rShip.ok === true && rShip.ok && rShip.parentOrder?.rolledTo === "SHIPPED");
        const rDel = await advanceSellerOrderStatus(c2, o.sellerOrders[1], "DELIVERED", tx);
        ok("C · active seller then delivers despite the CANCELLED sibling", rDel.ok === true, JSON.stringify(rDel));
        ok("C · parent rolls to DELIVERED — the CANCELLED sibling did not block it", rDel.ok === true && rDel.ok && rDel.parentOrder?.rolledTo === "DELIVERED");
        const row = await tx.order.findUnique({ where: { id: o.orderId }, select: { status: true, deliveredAt: true } });
        ok("C · parent Order.status = DELIVERED, deliveredAt populated", row?.status === "DELIVERED" && !!row?.deliveredAt);
      }

      // ── D · DELIVERED + CANCELLED → parent DELIVERED (order reversed from C) ─
      {
        const o = await makeOrderWithSellerOrders(
          tx,
          [
            { id: S1.id, soStatus: "READY_TO_SHIP", withShipment: true },
            { id: S2.id, soStatus: "CANCELLED", withShipment: false },
          ],
          "PROCESSING",
          suffix + "D",
        );
        await advanceSellerOrderStatus(c1, o.sellerOrders[0], "SHIPPED", tx);
        const rDel = await advanceSellerOrderStatus(c1, o.sellerOrders[0], "DELIVERED", tx);
        ok("D · the already-cancelled sibling never blocks the surviving seller's DELIVERED rollup", rDel.ok === true && rDel.ok && rDel.parentOrder?.rolledTo === "DELIVERED");
        const status = (await tx.order.findUnique({ where: { id: o.orderId }, select: { status: true } }))?.status;
        ok("D · parent Order.status = DELIVERED", status === "DELIVERED");
      }

      // ── E · both CANCELLED → parent CANCELLED, via the EXISTING cancellation
      //      cascade (sellerCancelSellerOrder) — NOT via rollUpParentOrder,
      //      which must never fire on an all-CANCELLED order. ─────────────────
      {
        const o = await makeOrderWithSellerOrders(
          tx,
          [
            { id: S1.id, soStatus: "PROCESSING", withShipment: false },
            { id: S2.id, soStatus: "PROCESSING", withShipment: false },
          ],
          "PROCESSING",
          suffix + "E",
        );
        const r1 = await sellerCancelSellerOrder(c1, o.sellerOrders[0], "Out of stock", tx);
        ok("E · first seller cancels ok", r1.ok === true, JSON.stringify(r1));
        ok("E · first cancel does NOT cancel the parent — a sibling is still active", r1.ok === true && r1.ok && r1.parentAlsoCancelled === false);
        const midStatus = (await tx.order.findUnique({ where: { id: o.orderId }, select: { status: true } }))?.status;
        ok("E · parent still PROCESSING after only one of two sellers cancelled", midStatus === "PROCESSING");

        const r2 = await sellerCancelSellerOrder(c2, o.sellerOrders[1], "Out of stock", tx);
        ok("E · second (last active) seller cancels ok", r2.ok === true, JSON.stringify(r2));
        ok("E · second cancel DOES cancel the parent — no sibling left active", r2.ok === true && r2.ok && r2.parentAlsoCancelled === true);
        const finalStatus = (await tx.order.findUnique({ where: { id: o.orderId }, select: { status: true } }))?.status;
        ok("E · both CANCELLED → parent Order.status = CANCELLED", finalStatus === "CANCELLED");
      }

      // ── F · existing all-active behaviour is unchanged (regression) ──────
      {
        const pp = await makeOrderWithSellerOrders(tx, [
          { id: S1.id, soStatus: "PROCESSING", withShipment: false },
          { id: S2.id, soStatus: "PROCESSING", withShipment: false },
        ], "PROCESSING", suffix + "F1");
        const rpp = await advanceSellerOrderStatus(c1, pp.sellerOrders[0], "READY_TO_SHIP", tx);
        ok("F · PROCESSING+PROCESSING: one seller moving to READY_TO_SHIP still doesn't roll the parent", rpp.ok === true && rpp.ok && rpp.parentOrder === undefined);

        const ss = await makeOrderWithSellerOrders(tx, [
          { id: S1.id, soStatus: "SHIPPED", withShipment: true },
          { id: S2.id, soStatus: "READY_TO_SHIP", withShipment: true },
        ], "PROCESSING", suffix + "F2");
        const rss = await advanceSellerOrderStatus(c2, ss.sellerOrders[1], "SHIPPED", tx);
        ok("F · SHIPPED+SHIPPED (both active, no cancellation involved): parent rolls to SHIPPED exactly as before", rss.ok === true && rss.ok && rss.parentOrder?.rolledTo === "SHIPPED");

        const dd = await makeOrderWithSellerOrders(tx, [
          { id: S1.id, soStatus: "DELIVERED", withShipment: true },
          { id: S2.id, soStatus: "SHIPPED", withShipment: true },
        ], "SHIPPED", suffix + "F3");
        const rdd = await advanceSellerOrderStatus(c2, dd.sellerOrders[1], "DELIVERED", tx);
        ok("F · DELIVERED+DELIVERED (both active, no cancellation involved): parent rolls to DELIVERED exactly as before", rdd.ok === true && rdd.ok && rdd.parentOrder?.rolledTo === "DELIVERED");
      }

      // ── G · three-seller: CANCELLED + PROCESSING + DELIVERED → PROCESSING ──
      {
        const o = await makeOrderWithSellerOrders(
          tx,
          [
            { id: S1.id, soStatus: "CANCELLED", withShipment: false },
            { id: S2.id, soStatus: "PROCESSING", withShipment: false },
            { id: S3.id, soStatus: "READY_TO_SHIP", withShipment: true },
          ],
          "PROCESSING",
          suffix + "G",
        );
        // S3 delivers (via SHIPPED first) while S2 is still only PROCESSING —
        // the active set {PROCESSING, DELIVERED} is not "all shipped-or-beyond",
        // so neither branch fires; the CANCELLED sibling is irrelevant either way.
        await advanceSellerOrderStatus(c3, o.sellerOrders[2], "SHIPPED", tx);
        const rDel = await advanceSellerOrderStatus(c3, o.sellerOrders[2], "DELIVERED", tx);
        ok("G · third seller's own advance succeeds even though the order can't roll yet", rDel.ok === true);
        ok("G · no rollup fires — S2 (active) is still only PROCESSING", rDel.ok === true && rDel.ok && rDel.parentOrder === undefined);
        const status = (await tx.order.findUnique({ where: { id: o.orderId }, select: { status: true } }))?.status;
        ok("G · CANCELLED + PROCESSING + DELIVERED → parent remains PROCESSING", status === "PROCESSING");
      }

      // ── H · three-seller: CANCELLED + SHIPPED + DELIVERED → SHIPPED ───────
      {
        const o = await makeOrderWithSellerOrders(
          tx,
          [
            { id: S1.id, soStatus: "CANCELLED", withShipment: false },
            { id: S2.id, soStatus: "READY_TO_SHIP", withShipment: true },
            { id: S3.id, soStatus: "READY_TO_SHIP", withShipment: true },
          ],
          "PROCESSING",
          suffix + "H",
        );
        // S3 ships and delivers first — no rollup yet (S2 not shipped/beyond).
        await advanceSellerOrderStatus(c3, o.sellerOrders[2], "SHIPPED", tx);
        const rDelEarly = await advanceSellerOrderStatus(c3, o.sellerOrders[2], "DELIVERED", tx);
        ok("H · S3 alone reaching DELIVERED does not roll the parent (S2 still READY_TO_SHIP)", rDelEarly.ok === true && rDelEarly.ok && rDelEarly.parentOrder === undefined);
        // S2 (the last active, non-delivered seller) ships — active = {SHIPPED, DELIVERED}, both shipped-or-beyond.
        const rShip = await advanceSellerOrderStatus(c2, o.sellerOrders[1], "SHIPPED", tx);
        ok("H · S2 shipping completes the active set (SHIPPED, DELIVERED) → parent rolls to SHIPPED", rShip.ok === true && rShip.ok && rShip.parentOrder?.rolledTo === "SHIPPED");
        const status = (await tx.order.findUnique({ where: { id: o.orderId }, select: { status: true } }))?.status;
        ok("H · CANCELLED + SHIPPED + DELIVERED → parent = SHIPPED", status === "SHIPPED");
      }

      // ── I · three-seller: CANCELLED + CANCELLED + DELIVERED → DELIVERED ────
      // (extending the letter sequence: two cancelled siblings must be exactly
      // as non-blocking as one — the `active` filter has no cardinality
      // assumption baked in.)
      {
        const o = await makeOrderWithSellerOrders(
          tx,
          [
            { id: S1.id, soStatus: "CANCELLED", withShipment: false },
            { id: S2.id, soStatus: "CANCELLED", withShipment: false },
            { id: S3.id, soStatus: "READY_TO_SHIP", withShipment: true },
          ],
          "PROCESSING",
          suffix + "I",
        );
        await advanceSellerOrderStatus(c3, o.sellerOrders[2], "SHIPPED", tx);
        const rDel = await advanceSellerOrderStatus(c3, o.sellerOrders[2], "DELIVERED", tx);
        ok("I · the sole active seller's DELIVERED rolls the parent even with TWO cancelled siblings", rDel.ok === true && rDel.ok && rDel.parentOrder?.rolledTo === "DELIVERED");
        const status = (await tx.order.findUnique({ where: { id: o.orderId }, select: { status: true } }))?.status;
        ok("I · CANCELLED + CANCELLED + DELIVERED → parent = DELIVERED", status === "DELIVERED");
      }

      // ── mixed FIRST_PARTY + THIRD_PARTY: sellerType plays no part ─────────
      if (axiaro) {
        const cAxiaro = ctxFor(axiaro.id);
        const o = await makeOrderWithSellerOrders(
          tx,
          [
            { id: S1.id, soStatus: "CANCELLED", withShipment: false, sellerType: "THIRD_PARTY" },
            { id: axiaro.id, soStatus: "READY_TO_SHIP", withShipment: true, sellerType: "FIRST_PARTY" },
          ],
          "PROCESSING",
          suffix + "MIX",
        );
        const r = await advanceSellerOrderStatus(cAxiaro, o.sellerOrders[1], "SHIPPED", tx);
        ok("mixed 1P+3P · a cancelled THIRD_PARTY sibling does not block the FIRST_PARTY (Axiaro) seller's rollup", r.ok === true && r.ok && r.parentOrder?.rolledTo === "SHIPPED", JSON.stringify(r));
      } else {
        ok("mixed 1P+3P · skipped (no FIRST_PARTY seller row found) — not a failure of the fix", true);
      }

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

function staticTests() {
  console.log("\n── static wiring ──");
  const repo = read("src/lib/marketplace/seller-order-repository.ts");
  const actions = read("src/lib/seller/order-actions.ts");
  const send = read("src/lib/email/send.ts");

  const rollupFn = repo.slice(repo.indexOf("async function rollUpParentOrder"), repo.indexOf("export async function advanceSellerOrderStatus"));
  ok("repo · rollUpParentOrder only advances the parent from the expected state (status-guarded updateMany)", /where: \{ id: order\.id, status: "PROCESSING" \}/.test(rollupFn) && /where: \{ id: order\.id, status: \{ in: \["SHIPPED", "OUT_FOR_DELIVERY"\] \} \}/.test(rollupFn));
  // 9F-44E: CANCELLED SellerOrders are excluded from the "every" check on both
  // branches (a cancelled seller never blocks a sibling's rollup), via a single
  // shared `active` filter computed once, with an explicit empty-`active` guard
  // so an all-CANCELLED order can never be rolled to SHIPPED/DELIVERED here.
  ok("repo · CANCELLED SellerOrders are filtered into a single shared `active` set before either branch",
    /const active = order\.sellerOrders\.filter\(\(s\) => s\.status !== "CANCELLED"\);/.test(rollupFn));
  ok("repo · an all-CANCELLED order (empty `active`) is refused before either branch runs",
    /if \(active\.length === 0\) return null;/.test(rollupFn));
  ok("repo · SHIPPED rollup requires ALL ACTIVE (non-CANCELLED) SellerOrders shipped-or-beyond",
    /active\.every\(\(s\) => SHIPPED_OR_BEYOND\.has\(s\.status\)\)/.test(rollupFn));
  ok("repo · DELIVERED rollup requires ALL ACTIVE (non-CANCELLED) SellerOrders DELIVERED",
    /active\.every\(\(s\) => s\.status === "DELIVERED"\)/.test(rollupFn));
  ok("repo · the old CANCELLED-blocking predicate (every SellerOrder, unfiltered) is gone from both branches",
    !/order\.sellerOrders\.every\(\(s\) => SHIPPED_OR_BEYOND\.has\(s\.status\)\)/.test(rollupFn) &&
      !/order\.sellerOrders\.every\(\(s\) => s\.status === "DELIVERED"\)/.test(rollupFn));
  ok("repo · sellerType plays no part in the rollup predicate (FIRST_PARTY/THIRD_PARTY unaffected)",
    !/sellerType/.test(rollupFn));
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
  console.log("\n── 9F-44E — CANCELLED siblings are non-blocking for the rollup ──");
  await cancelledAwareRollupTests();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
