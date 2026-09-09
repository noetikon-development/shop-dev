/**
 * PHASE 9F-35B — admin fulfilment → SellerOrder cascade.
 *
 * When an Axiaro admin advances the customer-facing parent Order, the seller
 * plane must follow so a THIRD_PARTY order can never sit at SHIPPED / DELIVERED
 * with its SellerOrder still PENDING_PAYMENT / PROCESSING (9F-35A P1-5). The
 * cascade is forward-only + status-guarded and does NOT route through the seller
 * forward machine. It touches only SellerOrder + its Shipment — never Order,
 * inventory, the customer plane, or settlement.
 *
 * DB tests run inside ONE rolled-back `prisma.$transaction`; the cascade is
 * called with that tx as `externalTx` (its audit write is skipped on that path,
 * exactly like 9F-12b — audit content is covered by the pure test).
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f35b.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  cascadeSellerOrderFromParent,
  adminCascadeAuditInput,
  type SellerOrderCascadeRow,
} from "../src/lib/marketplace/seller-order-repository";
import {
  sellerOrderTargetForParentStatus,
  sellerOrderStatusesBehind,
} from "../src/lib/marketplace/seller-order-status";
import { getSellerSettlementPreview } from "../src/lib/marketplace/settlement";
import { reverseCancelledOrder } from "../src/lib/orders/cancellation";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
class Rollback extends Error {}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

async function mkOrder(
  tx: Tx,
  opts: {
    sellerType?: string;
    /** Reuse an existing seller instead of creating one (required for FIRST_PARTY — a partial unique index allows only one). */
    sellerId?: string;
    soStatus?: string;
    parentStatus?: string;
    withShipment?: boolean;
    shipmentStatus?: string;
    deliveredDaysAgo?: number;
    total?: number;
    commissionAmount?: number;
    paymentStatus?: string;
    suffix: string;
  },
) {
  const sellerType = opts.sellerType ?? "THIRD_PARTY";
  const seller = opts.sellerId
    ? { id: opts.sellerId }
    : await tx.seller.create({
        data: {
          type: sellerType,
          status: "APPROVED",
          displayName: `S ${opts.suffix}`,
          slug: `s-${opts.suffix}-${Math.random().toString(36).slice(2, 7)}`,
          supportEmail: "s@t.test",
          commissionRate: 1500,
        },
        select: { id: true },
      });
  const placedAt = new Date(Date.now() - (opts.deliveredDaysAgo ?? 0) * 86400_000);
  const order = await tx.order.create({
    data: {
      orderNumber: `AX-T35B-${opts.suffix}-${Math.random().toString(36).slice(2, 6)}`,
      email: "buyer@example.test",
      phone: "+639000000000",
      status: opts.parentStatus ?? "PROCESSING",
      // 9F-42B — settlement eligibility now needs paymentStatus PAID.
      paymentStatus: opts.paymentStatus ?? "UNPAID",
      subtotal: 1000,
      grandTotal: 1150,
      shippingFee: 150,
      placedAt,
      deliveredAt: opts.deliveredDaysAgo ? placedAt : null,
      shippingAddress: JSON.stringify({ firstName: "T", lastName: "B", line1: "1 St", city: "Manila", province: "NCR", postalCode: "1000", country: "PH" }),
    },
    select: { id: true, orderNumber: true },
  });
  const total = opts.total ?? 1150;
  const so = await tx.sellerOrder.create({
    data: {
      orderId: order.id,
      sellerId: seller.id,
      sellerName: "S",
      sellerType,
      supportEmail: "s@t.test",
      commissionRate: 1500,
      // CHECK sellerorder_total_reconciles: total = merchandiseSubtotal - discountAllocated + shippingFee
      merchandiseSubtotal: total - 150,
      discountAllocated: 0,
      shippingFee: 150,
      total,
      commissionAmount: opts.commissionAmount ?? 150,
      status: opts.soStatus ?? "PENDING_PAYMENT",
    },
    select: { id: true },
  });
  await tx.orderItem.create({
    data: { orderId: order.id, sellerOrderId: so.id, sellerId: seller.id, productId: "p", name: "Item", unitPrice: 1000, quantity: 1, lineTotal: 1000 },
  });
  let shipmentId: string | null = null;
  if (opts.withShipment) {
    const sh = await tx.shipment.create({
      data: {
        sellerOrderId: so.id,
        carrier: "OTHER",
        carrierName: "Seller Courier",
        trackingNumber: `SLR-${opts.suffix}`,
        trackingUrl: "https://track.example/slr",
        status: opts.shipmentStatus ?? "PENDING",
      },
      select: { id: true },
    });
    shipmentId = sh.id;
  }
  return { sellerId: seller.id, orderId: order.id, orderNumber: order.orderNumber, sellerOrderId: so.id, shipmentId };
}

const ADMIN_COURIER = { courier: "JT_EXPRESS", courierName: "J&T Express", trackingNumber: "JT-ADMIN-123", trackingUrl: "https://track.example/jt" };

function pureTests() {
  console.log("\n── pure ──");
  ok("map · Order PROCESSING → SellerOrder PROCESSING", sellerOrderTargetForParentStatus("PROCESSING") === "PROCESSING");
  ok("map · Order SHIPPED → SellerOrder SHIPPED", sellerOrderTargetForParentStatus("SHIPPED") === "SHIPPED");
  ok("map · Order DELIVERED → SellerOrder DELIVERED", sellerOrderTargetForParentStatus("DELIVERED") === "DELIVERED");
  ok("map · Order OUT_FOR_DELIVERY → null (no seller-plane status)", sellerOrderTargetForParentStatus("OUT_FOR_DELIVERY") === null);
  ok("map · PENDING_PAYMENT / PENDING / PAID / CANCELLED → null", ["PENDING_PAYMENT", "PENDING", "PAID", "CANCELLED"].every((s) => sellerOrderTargetForParentStatus(s) === null));

  ok("behind · PROCESSING → only PENDING_PAYMENT", JSON.stringify(sellerOrderStatusesBehind("PROCESSING")) === JSON.stringify(["PENDING_PAYMENT"]));
  ok("behind · SHIPPED → PENDING_PAYMENT, PROCESSING, READY_TO_SHIP", JSON.stringify(sellerOrderStatusesBehind("SHIPPED")) === JSON.stringify(["PENDING_PAYMENT", "PROCESSING", "READY_TO_SHIP"]));
  ok("behind · DELIVERED → everything below (never DELIVERED / CANCELLED)", JSON.stringify(sellerOrderStatusesBehind("DELIVERED")) === JSON.stringify(["PENDING_PAYMENT", "PROCESSING", "READY_TO_SHIP", "SHIPPED"]));
  ok("behind · never includes CANCELLED (off the forward line)", !sellerOrderStatusesBehind("DELIVERED").includes("CANCELLED" as never));

  const row: SellerOrderCascadeRow = { sellerOrderId: "so1", sellerId: "sel1", sellerType: "THIRD_PARTY", from: "PENDING_PAYMENT", to: "SHIPPED", shipment: "created" };
  const a = adminCascadeAuditInput({ actorUserId: "admin1", orderId: "ord1", orderNumber: "AX-1", parentStatus: "SHIPPED" }, row);
  ok("audit · action seller_order.status_changed, targets the seller_order", a.action === "seller_order.status_changed" && a.targetType === "seller_order" && a.targetId === "so1");
  ok("audit · meta.trigger = admin_fulfillment_cascade + parent ref + from/to", (a.meta as Record<string, unknown>).trigger === "admin_fulfillment_cascade" && (a.meta as Record<string, unknown>).orderNumber === "AX-1" && (a.meta as Record<string, unknown>).from === "PENDING_PAYMENT" && (a.meta as Record<string, unknown>).to === "SHIPPED");
  ok("audit · actor is the admin user", a.actorUserId === "admin1");
}

async function dbTests() {
  const sfx = String(Date.now()).slice(-7);
  const fpSeller = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
  if (!fpSeller) { console.error("STOP — no FIRST_PARTY seller"); process.exit(1); }
  const orderEventsBefore = await prisma.orderEvent.count();
  const auditBefore = await prisma.adminAuditLog.count();
  const offerAdjBefore = await prisma.offerAdjustment.count();
  const shipmentsBefore = await prisma.shipment.count();

  try {
    await prisma.$transaction(async (tx) => {
      // ── A · 3P admin confirm: Order PROCESSING → SellerOrder PROCESSING ──
      const A = await mkOrder(tx, { soStatus: "PENDING_PAYMENT", parentStatus: "PROCESSING", suffix: sfx + "A" });
      const rA = await cascadeSellerOrderFromParent({ orderId: A.orderId, orderNumber: A.orderNumber, parentStatus: "PROCESSING", actorUserId: "admin" }, tx);
      ok("A · cascade ok, target PROCESSING, 1 row", rA.ok && rA.target === "PROCESSING" && rA.cascaded.length === 1);
      ok("A · SellerOrder now PROCESSING", (await tx.sellerOrder.findUnique({ where: { id: A.sellerOrderId }, select: { status: true } }))?.status === "PROCESSING");
      ok("A · parent Order untouched by the cascade (still PROCESSING, no event)", (await tx.order.findUnique({ where: { id: A.orderId }, select: { status: true } }))?.status === "PROCESSING" && (await tx.orderEvent.count({ where: { orderId: A.orderId } })) === 0);
      ok("A · no shipment created on a PROCESSING cascade", (await tx.shipment.count({ where: { sellerOrderId: A.sellerOrderId } })) === 0);

      // ── B · 3P admin ship: Order SHIPPED → SellerOrder SHIPPED + Shipment ──
      const B = await mkOrder(tx, { soStatus: "PROCESSING", parentStatus: "SHIPPED", suffix: sfx + "B" });
      const rB = await cascadeSellerOrderFromParent({ orderId: B.orderId, orderNumber: B.orderNumber, parentStatus: "SHIPPED", actorUserId: "admin", courier: ADMIN_COURIER }, tx);
      ok("B · cascade ok, 1 row, shipment created", rB.ok && rB.cascaded.length === 1 && rB.cascaded[0].shipment === "created");
      ok("B · SellerOrder now SHIPPED", (await tx.sellerOrder.findUnique({ where: { id: B.sellerOrderId }, select: { status: true } }))?.status === "SHIPPED");
      const shipB = await tx.shipment.findMany({ where: { sellerOrderId: B.sellerOrderId } });
      ok("B · exactly ONE Shipment, status SHIPPED, shippedAt set", shipB.length === 1 && shipB[0].status === "SHIPPED" && !!shipB[0].shippedAt);
      ok("B · Shipment carries the admin courier + tracking", shipB[0].carrier === "JT_EXPRESS" && shipB[0].carrierName === "J&T Express" && shipB[0].trackingNumber === "JT-ADMIN-123" && shipB[0].trackingUrl === "https://track.example/jt");

      // ── C · 3P admin out-for-delivery: SellerOrder stays SHIPPED ──
      const C = await mkOrder(tx, { soStatus: "SHIPPED", parentStatus: "OUT_FOR_DELIVERY", withShipment: true, shipmentStatus: "SHIPPED", suffix: sfx + "C" });
      const rC = await cascadeSellerOrderFromParent({ orderId: C.orderId, orderNumber: C.orderNumber, parentStatus: "OUT_FOR_DELIVERY", actorUserId: "admin" }, tx);
      ok("C · cascade is a no-op (target null, nothing cascaded)", rC.ok && rC.target === null && rC.cascaded.length === 0);
      ok("C · SellerOrder remains SHIPPED", (await tx.sellerOrder.findUnique({ where: { id: C.sellerOrderId }, select: { status: true } }))?.status === "SHIPPED");

      // ── D · 3P admin deliver: Order DELIVERED → SellerOrder DELIVERED + Shipment.deliveredAt ──
      const D = await mkOrder(tx, { soStatus: "SHIPPED", parentStatus: "DELIVERED", withShipment: true, shipmentStatus: "SHIPPED", suffix: sfx + "D" });
      const rD = await cascadeSellerOrderFromParent({ orderId: D.orderId, orderNumber: D.orderNumber, parentStatus: "DELIVERED", actorUserId: "admin" }, tx);
      ok("D · cascade ok, 1 row, shipment stamped", rD.ok && rD.cascaded.length === 1 && rD.cascaded[0].shipment === "stamped");
      ok("D · SellerOrder now DELIVERED", (await tx.sellerOrder.findUnique({ where: { id: D.sellerOrderId }, select: { status: true } }))?.status === "DELIVERED");
      const shipD = await tx.shipment.findFirst({ where: { sellerOrderId: D.sellerOrderId } });
      ok("D · Shipment DELIVERED + deliveredAt populated", shipD?.status === "DELIVERED" && !!shipD?.deliveredAt);
      ok("D · still exactly ONE Shipment (no duplicate)", (await tx.shipment.count({ where: { sellerOrderId: D.sellerOrderId } })) === 1);

      // ── D2 · deliver from PENDING_PAYMENT with NO shipment (store-pickup-like) ──
      const D2 = await mkOrder(tx, { soStatus: "PENDING_PAYMENT", parentStatus: "DELIVERED", suffix: sfx + "D2" });
      const rD2 = await cascadeSellerOrderFromParent({ orderId: D2.orderId, orderNumber: D2.orderNumber, parentStatus: "DELIVERED", actorUserId: "admin" }, tx);
      ok("D2 · SellerOrder → DELIVERED even with no Shipment; shipment 'none', none fabricated", rD2.cascaded[0].shipment === "none" && (await tx.shipment.count({ where: { sellerOrderId: D2.sellerOrderId } })) === 0);

      // ── E · seller already advanced → admin never moves it backwards ──
      const E1 = await mkOrder(tx, { soStatus: "SHIPPED", parentStatus: "SHIPPED", withShipment: true, shipmentStatus: "SHIPPED", suffix: sfx + "E1" });
      const rE1 = await cascadeSellerOrderFromParent({ orderId: E1.orderId, orderNumber: E1.orderNumber, parentStatus: "SHIPPED", actorUserId: "admin", courier: ADMIN_COURIER }, tx);
      ok("E1 · SellerOrder already SHIPPED → admin ship is a no-op (0 cascaded)", rE1.cascaded.length === 0 && (await tx.sellerOrder.findUnique({ where: { id: E1.sellerOrderId }, select: { status: true } }))?.status === "SHIPPED");
      ok("E1 · seller's own Shipment untouched (carrier still OTHER, not overwritten)", (await tx.shipment.findFirst({ where: { sellerOrderId: E1.sellerOrderId }, select: { carrier: true } }))?.carrier === "OTHER");

      const E2 = await mkOrder(tx, { soStatus: "DELIVERED", parentStatus: "DELIVERED", withShipment: true, shipmentStatus: "DELIVERED", suffix: sfx + "E2" });
      const rE2 = await cascadeSellerOrderFromParent({ orderId: E2.orderId, orderNumber: E2.orderNumber, parentStatus: "DELIVERED", actorUserId: "admin" }, tx);
      ok("E2 · SellerOrder already DELIVERED → admin deliver is a no-op", rE2.cascaded.length === 0 && (await tx.sellerOrder.findUnique({ where: { id: E2.sellerOrderId }, select: { status: true } }))?.status === "DELIVERED");

      const E3 = await mkOrder(tx, { soStatus: "PROCESSING", parentStatus: "PROCESSING", suffix: sfx + "E3" });
      const rE3 = await cascadeSellerOrderFromParent({ orderId: E3.orderId, orderNumber: E3.orderNumber, parentStatus: "PROCESSING", actorUserId: "admin" }, tx);
      ok("E3 · SellerOrder already PROCESSING → admin confirm is a no-op", rE3.cascaded.length === 0 && (await tx.sellerOrder.findUnique({ where: { id: E3.sellerOrderId }, select: { status: true } }))?.status === "PROCESSING");

      const E4 = await mkOrder(tx, { soStatus: "READY_TO_SHIP", parentStatus: "SHIPPED", withShipment: true, suffix: sfx + "E4" });
      const rE4 = await cascadeSellerOrderFromParent({ orderId: E4.orderId, orderNumber: E4.orderNumber, parentStatus: "SHIPPED", actorUserId: "admin", courier: ADMIN_COURIER }, tx);
      ok("E4 · SellerOrder READY_TO_SHIP → admin ship advances it to SHIPPED (forward, allowed)", rE4.cascaded.length === 1 && rE4.cascaded[0].from === "READY_TO_SHIP" && rE4.cascaded[0].to === "SHIPPED");
      ok("E4 · seller's pre-existing Shipment stamped, not duplicated", (await tx.shipment.count({ where: { sellerOrderId: E4.sellerOrderId } })) === 1 && rE4.cascaded[0].shipment === "stamped");

      // ── E5 · CANCELLED SellerOrder is never touched ──
      const E5 = await mkOrder(tx, { soStatus: "CANCELLED", parentStatus: "DELIVERED", suffix: sfx + "E5" });
      const rE5 = await cascadeSellerOrderFromParent({ orderId: E5.orderId, orderNumber: E5.orderNumber, parentStatus: "DELIVERED", actorUserId: "admin" }, tx);
      ok("E5 · CANCELLED SellerOrder stays CANCELLED (cascade skips it)", rE5.cascaded.length === 0 && (await tx.sellerOrder.findUnique({ where: { id: E5.sellerOrderId }, select: { status: true } }))?.status === "CANCELLED");

      // ── G · 1P shadow SellerOrder tracks along, no Shipment fabricated ──
      const G = await mkOrder(tx, { sellerType: "FIRST_PARTY", sellerId: fpSeller.id, soStatus: "PENDING_PAYMENT", parentStatus: "SHIPPED", suffix: sfx + "G" });
      const rG = await cascadeSellerOrderFromParent({ orderId: G.orderId, orderNumber: G.orderNumber, parentStatus: "SHIPPED", actorUserId: "admin", courier: ADMIN_COURIER }, tx);
      ok("G · 1P shadow SellerOrder advanced to SHIPPED", rG.cascaded.length === 1 && (await tx.sellerOrder.findUnique({ where: { id: G.sellerOrderId }, select: { status: true } }))?.status === "SHIPPED");
      ok("G · NO Shipment row fabricated for a 1P order", rG.cascaded[0].shipment === "none" && (await tx.shipment.count({ where: { sellerOrderId: G.sellerOrderId } })) === 0);

      // ── F · parent roll-up coexistence — cascade never writes Order / OrderEvent ──
      const eventsMid = await tx.orderEvent.count();
      const F = await mkOrder(tx, { soStatus: "PROCESSING", parentStatus: "DELIVERED", withShipment: true, shipmentStatus: "SHIPPED", suffix: sfx + "F" });
      await cascadeSellerOrderFromParent({ orderId: F.orderId, orderNumber: F.orderNumber, parentStatus: "DELIVERED", actorUserId: "admin" }, tx);
      ok("F · the cascade created NO OrderEvent (parent plane is the admin action's job — no dup notifications)", (await tx.orderEvent.count()) === eventsMid);
      ok("F · parent Order.status still exactly what the admin set (cascade never writes Order)", (await tx.order.findUnique({ where: { id: F.orderId }, select: { status: true } }))?.status === "DELIVERED");

      // ── I · settlement eligibility recognised once both planes DELIVERED ──
      const I = await mkOrder(tx, { soStatus: "SHIPPED", parentStatus: "DELIVERED", withShipment: true, shipmentStatus: "SHIPPED", deliveredDaysAgo: 60, total: 2000, commissionAmount: 300, paymentStatus: "PAID", suffix: sfx + "I" });
      const preI = await getSellerSettlementPreview(I.sellerId, tx);
      ok("I · BEFORE cascade — SellerOrder SHIPPED ⇒ NOT settlement-eligible", preI.eligibleOrders.length === 0);
      await cascadeSellerOrderFromParent({ orderId: I.orderId, orderNumber: I.orderNumber, parentStatus: "DELIVERED", actorUserId: "admin" }, tx);
      const postI = await getSellerSettlementPreview(I.sellerId, tx);
      ok("I · AFTER cascade — both planes DELIVERED ⇒ order now eligible (receivable = total − commission)", postI.eligibleOrders.length === 1 && postI.eligibleOrders[0].orderNumber === I.orderNumber && postI.eligibleOrders[0].receivable === 1700);
      ok("I · no real SellerSettlement was created by the preview", (await tx.sellerSettlement.count()) === 0);

      // ── H · cancellation cascade regression — reverseCancelledOrder still cascades to CANCELLED ──
      const H = await mkOrder(tx, { soStatus: "PROCESSING", parentStatus: "PROCESSING", suffix: sfx + "H" });
      await tx.$executeRaw`UPDATE "Order" SET "status" = 'CANCELLED' WHERE "id" = ${H.orderId}`;
      const rH = await reverseCancelledOrder(tx, { orderId: H.orderId, orderNumber: H.orderNumber, actorUserId: "admin", adjustmentNote: `Order ${H.orderNumber} cancelled`, eventDetail: "Cancelled." });
      ok("H · reverseCancelledOrder still cascades the SellerOrder → CANCELLED, commission 0", rH.cancelledSellerOrderIds.includes(H.sellerOrderId) && (await tx.sellerOrder.findUnique({ where: { id: H.sellerOrderId }, select: { status: true, commissionAmount: true } }))?.status === "CANCELLED");

      // ── J · re-running the same cascade creates no duplicate Shipment ──
      const J = await mkOrder(tx, { soStatus: "PROCESSING", parentStatus: "SHIPPED", suffix: sfx + "J" });
      await cascadeSellerOrderFromParent({ orderId: J.orderId, orderNumber: J.orderNumber, parentStatus: "SHIPPED", actorUserId: "admin", courier: ADMIN_COURIER }, tx);
      const again = await cascadeSellerOrderFromParent({ orderId: J.orderId, orderNumber: J.orderNumber, parentStatus: "SHIPPED", actorUserId: "admin", courier: ADMIN_COURIER }, tx);
      ok("J · second identical cascade is a no-op (SellerOrder already SHIPPED)", again.cascaded.length === 0);
      ok("J · still exactly ONE Shipment after re-run", (await tx.shipment.count({ where: { sellerOrderId: J.sellerOrderId } })) === 1);

      // ── cascade touched no inventory / offer ledger ──
      ok("cascade created no OfferAdjustment", (await tx.offerAdjustment.count()) === offerAdjBefore);

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("rolled back cleanly — no OrderEvent persisted", (await prisma.orderEvent.count()) === orderEventsBefore);
  ok("rolled back cleanly — no adminAuditLog persisted (externalTx path writes none)", (await prisma.adminAuditLog.count()) === auditBefore);
  ok("rolled back cleanly — no Shipment persisted", (await prisma.shipment.count()) === shipmentsBefore);
}

function staticTests() {
  console.log("\n── static wiring ──");
  const repo = read("src/lib/marketplace/seller-order-repository.ts");
  const status = read("src/lib/marketplace/seller-order-status.ts");
  const fulfil = read("src/lib/admin/fulfillment-actions.ts");
  const orderActions = read("src/lib/admin/order-actions.ts");

  // helper slice
  const fn = repo.slice(repo.indexOf("export async function cascadeSellerOrderFromParent"));
  ok("helper · never writes the parent Order / OrderEvent (parent plane stays with the admin action)",
    !/\.order\.update|\.order\.updateMany|orderEvent\.create|\$executeRaw/.test(fn));
  ok("helper · never touches inventory / offers / payments / settlement fields",
    !/inventory|inventoryAdjustment|offerInventory|offerAdjustment|paymentStatus|paymentMethod|paymentRefund|settlementStatus|settlementId|sellerSettlement/i.test(
      fn.split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n")));
  ok("helper · SellerOrder write is status-guarded (id + prior status ⇒ forward-only)",
    /updateMany\(\{\s*\n?\s*where: \{ id: so\.id, status: so\.status \}/.test(fn));
  ok("helper · only advances rows strictly BEHIND the target (sellerOrderStatusesBehind)",
    /status: \{ in: behind \}/.test(fn) && /const behind = sellerOrderStatusesBehind\(target\)/.test(fn));
  ok("helper · seeds a Shipment only when none exists and never for a 1P shadow",
    /so\.sellerType === "THIRD_PARTY"/.test(fn) && /if \(so\.shipments\.length === 0\)/.test(fn) && /shipment\.create\(/.test(fn));
  ok("helper · existing Shipment is stamped, never a second one created",
    /else \{\s*\n\s*await tx\.shipment\.updateMany\(/.test(fn));
  ok("helper · best-effort — resolves { ok: true } even on failure, audit only on the non-externalTx path",
    /catch \(err\) \{[\s\S]{0,220}return \{ ok: true, target, cascaded: \[\] \}/.test(fn) && /if \(!externalTx\) \{[\s\S]{0,160}writeAudit\(adminCascadeAuditInput/.test(fn));

  ok("status · sellerOrderTargetForParentStatus + sellerOrderStatusesBehind exported, still no import from orders/status",
    /export function sellerOrderTargetForParentStatus/.test(status) && /export function sellerOrderStatusesBehind/.test(status) && !/from "@\/lib\/orders\/status"/.test(status));
  ok("status · OUT_FOR_DELIVERY / CANCELLED map to null (default branch)",
    /case "DELIVERED":\s*\n\s*return "DELIVERED";\s*\n\s*default:\s*\n\s*return null;/.test(status));

  // admin action wiring
  ok("fulfil · markShippedAction cascades to SHIPPED with the resolved courier bundle",
    /parentStatus: "SHIPPED",\s*\n\s*actorUserId: admin\.user\.id,\s*\n\s*courier: \{\s*\n\s*courier: resolved\.data\.courier/.test(fulfil));
  ok("fulfil · markOutForDeliveryAction calls the cascade with OUT_FOR_DELIVERY (helper no-ops)",
    /parentStatus: "OUT_FOR_DELIVERY",/.test(fulfil));
  ok("fulfil · markDeliveredAction cascades to DELIVERED",
    /parentStatus: "DELIVERED",/.test(fulfil));
  ok("fulfil · all cascade call-sites run AFTER the guarded applyTransition (post-commit)",
    fulfil.indexOf("cascadeSellerOrderFromParent({") > fulfil.indexOf("async function applyTransition") &&
    (fulfil.match(/cascadeSellerOrderFromParent\(\{/g) ?? []).length === 3);
  ok("order-actions · updateOrderStatusAction + confirmOrderAction cascade PROCESSING (assisted acceptance)",
    (orderActions.match(/cascadeSellerOrderFromParent\(\{/g) ?? []).length === 2 && (orderActions.match(/parentStatus: "PROCESSING"/g) ?? []).length === 2);
  ok("order-actions · cancelOrderAction's own SellerOrder cascade is untouched (still findMany not-CANCELLED → updateMany unsettledIds)",
    /tx\.sellerOrder\.findMany\(\{\s*\n?\s*where: \{ orderId, status: \{ not: "CANCELLED" \} \}/.test(orderActions) && /where: \{ id: \{ in: unsettledIds \} \}/.test(orderActions));

  ok("scope · no schema change", !/9F-35B/.test(read("prisma/schema.prisma")));
  ok("scope · seed-rbac.ts untouched marker", !/9F-35B/.test(read("scripts/seed-rbac.ts")));
  ok("scope · settlement.ts unchanged by this phase", !/9F-35B/.test(read("src/lib/marketplace/settlement.ts")));
  ok("scope · SLA job unchanged by this phase", !/9F-35B/.test(read("src/lib/marketplace/seller-order-sla-job.ts")));
}

async function main() {
  console.log("\nPHASE 9F-35B — admin fulfilment → SellerOrder cascade\n");
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
