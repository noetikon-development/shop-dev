/**
 * PHASE 9F-30B — 3P seller order cancellation / rejection.
 *
 * The owning THIRD_PARTY seller can decline (SellerOrder PENDING_PAYMENT) or
 * cancel (SellerOrder PROCESSING) an order they can't fulfil. It reuses the
 * admin `cancelOrderAction` reversal architecture, in ONE transaction:
 *   - SellerOrder → CANCELLED, commissionAmount zeroed (status-guarded)
 *   - parent Order → CANCELLED (atomic one-shot gate = idempotency)
 *   - OfferInventory restored per OrderItem.offerId + OfferAdjustment(CANCELLATION)
 *   - Product.soldCount rolled back (never below 0)
 *   - settlement clawback IF already settled (never from PENDING_PAYMENT/PROCESSING)
 *   - one OrderEvent(CANCELLED)
 * The action layer then (post-commit) audits it, emails the CUSTOMER, and raises
 * an Ops signal. The seller is NOT emailed about their own cancellation.
 *
 * DB tests build fixtures inside ONE prisma.$transaction and roll back;
 * `sellerCancelSellerOrder` / `advanceSellerOrderStatus` take that tx as
 * `externalTx`. The ops email sender is only exercised on its SKIPPED
 * (FIRST_PARTY) path so nothing is actually sent; the THIRD_PARTY wiring is
 * asserted statically (same posture as test-9f24d P1-7).
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f30b.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient, Prisma } from "@prisma/client";
import {
  sellerCancelSellerOrder,
  advanceSellerOrderStatus,
} from "@/lib/marketplace/seller-order-repository";
import {
  SELLER_ORDER_CANCELLABLE_FROM,
  sellerCanCancelSellerOrder,
  sellerCancelLabels,
  SELLER_ORDER_STATUS_TRANSITIONS,
} from "@/lib/marketplace/seller-order-status";
import { sendSellerOrderCancelledOps } from "@/lib/email/notifications";
import type { SellerContext } from "@/lib/marketplace/types";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
class Rollback extends Error {}

const ctxFor = (sellerId: string, sellerName = "T"): SellerContext => ({
  sellerId,
  sellerName,
  sellerUserId: "su-" + sellerId,
  userId: "u-" + sellerId,
  role: "OWNER" as SellerContext["role"],
  permissions: new Set(["manage_seller_fulfillment"]),
});

// ── pure ────────────────────────────────────────────────────────────────
function pureTests() {
  console.log("\n── pure — cancellable predicate + labels ──");
  ok("SELLER_ORDER_CANCELLABLE_FROM = [PENDING_PAYMENT, PROCESSING]",
    JSON.stringify(SELLER_ORDER_CANCELLABLE_FROM) === JSON.stringify(["PENDING_PAYMENT", "PROCESSING"]));
  ok("sellerCanCancelSellerOrder true for PENDING_PAYMENT / PROCESSING",
    sellerCanCancelSellerOrder("PENDING_PAYMENT") && sellerCanCancelSellerOrder("PROCESSING"));
  ok("sellerCanCancelSellerOrder false for READY_TO_SHIP / SHIPPED / DELIVERED / CANCELLED",
    !["READY_TO_SHIP", "SHIPPED", "DELIVERED", "CANCELLED"].some(sellerCanCancelSellerOrder));
  ok("labels · PENDING_PAYMENT → Decline order / declined",
    sellerCancelLabels("PENDING_PAYMENT").button === "Decline order" && sellerCancelLabels("PENDING_PAYMENT").done === "declined");
  ok("labels · PROCESSING → Cancel order / cancelled",
    sellerCancelLabels("PROCESSING").button === "Cancel order" && sellerCancelLabels("PROCESSING").done === "cancelled");
  ok("fulfilment transition map UNCHANGED — no CANCELLED target added",
    JSON.stringify(SELLER_ORDER_STATUS_TRANSITIONS.PENDING_PAYMENT) === JSON.stringify(["PROCESSING"]) &&
    JSON.stringify(SELLER_ORDER_STATUS_TRANSITIONS.PROCESSING) === JSON.stringify(["READY_TO_SHIP"]) &&
    JSON.stringify(SELLER_ORDER_STATUS_TRANSITIONS.CANCELLED) === JSON.stringify([]));
}

// ── static wiring ───────────────────────────────────────────────────────
function staticTests() {
  console.log("\n── static wiring ──");
  const repo = read("src/lib/marketplace/seller-order-repository.ts");
  const actions = read("src/lib/seller/order-actions.ts");
  const status = read("src/lib/marketplace/seller-order-status.ts");
  const send = read("src/lib/email/send.ts");
  const notif = read("src/lib/email/notifications.ts");
  const ops = read("src/lib/email/templates/ops-notifications.ts");
  const readModel = read("src/lib/seller/orders.ts");
  const page = read("src/app/seller/(portal)/orders/[id]/page.tsx");
  const panel = read("src/components/seller/seller-order-cancel-panel.tsx");

  // repo
  const fn = repo.slice(repo.indexOf("export async function sellerCancelSellerOrder"), repo.indexOf("export type ShipmentInput"));
  ok("repo · SellerOrder write is status-guarded (0 rows ⇒ STALE) and zeroes commissionAmount",
    /updateMany\(\{\s*where: \{ id: sellerOrderId, sellerId: ctx\.sellerId, status: so\.status \},\s*data: \{ status: "CANCELLED", commissionAmount: 0/.test(fn));
  ok("repo · parent Order cancelled by the SAME atomic one-shot gate as cancelOrderAction (status IN cancellable)",
    /UPDATE "Order" SET "status" = 'CANCELLED'[\s\S]{0,120}status" IN \('PENDING_PAYMENT', 'PENDING', 'PROCESSING'\)/.test(fn) &&
    /if \(cancelledOrder === 0\) throw new ParentOrderMovedError\(\)/.test(fn));
  ok("repo · restores OfferInventory per OrderItem.offerId with restoreOfferStock reason CANCELLATION",
    /restoreOfferStock\(\s*\{\s*offerId: it\.offerId,\s*units: it\.quantity,\s*reason: "CANCELLATION"/.test(fn));
  ok("repo · rolls Product.soldCount back, never below zero",
    /UPDATE "Product" SET "soldCount" = GREATEST\(0, "soldCount" - \$\{qty\}\)/.test(fn));
  ok("repo · single-seller only — a multi-seller parent is refused",
    /if \(so\.order\.sellerOrders\.length !== 1\)/.test(fn));
  ok("repo · never touches payments / paymentStatus / Inventory / returns",
    !/paymentStatus|paymentMethod|\.inventory\.|inventoryAdjustment|returnRequest|paymentRefund/.test(fn));
  ok("repo · settlement clawback branch is symmetric with cancelOrderAction (only if already settled)",
    /if \(so\.settlementId !== null\) \{[\s\S]{0,400}settlementStatus: "CLAWED_BACK"/.test(fn));
  ok("repo · one OrderEvent(CANCELLED) written inside the tx",
    /orderEvent\.create\(\{\s*data: \{\s*orderId: so\.order\.id,\s*status: "CANCELLED",\s*title: "Order cancelled"/.test(fn));

  // action
  ok("action · uses manage_seller_fulfillment permission",
    /requireSellerSessionPermission\("manage_seller_fulfillment"\)/.test(actions.slice(actions.indexOf("sellerCancelOrderAction"))));
  ok("action · a reason is required (zod min 1)",
    /reason: z\.string\(\)\.trim\(\)\.min\(1, "Add a reason\."\)\.max\(300\)/.test(actions));
  ok("action · writes the seller_order.cancelled audit (the Ops signal) and captures its id",
    /const auditId = await writeAudit\(\{[\s\S]{0,120}action: "seller_order\.cancelled"/.test(actions));
  ok("action · emails the CUSTOMER with the existing sendOrderCancelled",
    /scheduleEmail\(\(\) => sendOrderCancelled\(res\.orderId, parsed\.data\.reason\)\)/.test(actions));
  ok("action · raises the Ops notice sendSellerOrderCancelledOps anchored on the audit id",
    /if \(auditId\) \{\s*\n\s*scheduleEmail\(\(\) => sendSellerOrderCancelledOps\(parsed\.data\.sellerOrderId, auditId\)\)/.test(actions));
  ok("action · the SELLER is NOT emailed about their own cancellation (no sendSellerOrderCancelled call)",
    !/\bsendSellerOrderCancelled\(/.test(actions));
  ok("action · revalidates products (availability + bestseller changed)",
    /revalidateTag\("products", "max"\)/.test(actions.slice(actions.indexOf("sellerCancelOrderAction"))));

  // email plumbing
  ok("send.ts · new EmailType seller_order_cancelled_ops added",
    /\| "seller_order_cancelled_ops"/.test(send));
  ok("notifications · sender guards FIRST_PARTY → SKIPPED, sends to the support inbox from ORDERS_FROM",
    /if \(so\.seller\.type !== "THIRD_PARTY"\) return \{ ok: true, skipped: true, status: "SKIPPED" \};/.test(notif) &&
    /type: "seller_order_cancelled_ops",\s*\n\s*to,\s*\n\s*from: ORDERS_FROM/.test(notif));
  ok("notifications · idempotency key is audit-row-anchored (never SellerOrder.updatedAt)",
    /const idempotencyKey = `SELLER_ORDER_CANCELLED_OPS:\$\{sellerOrderId\}:\$\{auditLogId\}`/.test(notif));
  ok("notifications · action / reason / previousParentStatus re-read off the audit meta (retry-safe)",
    /JSON\.parse\(audit\?\.meta \?\? "\{\}"\)/.test(notif));
  ok("notifications · retry switch case parses both ids back out of the key",
    /case "seller_order_cancelled_ops": \{[\s\S]{0,400}sendSellerOrderCancelledOps\(sellerOrderId, auditLogId, \{ retry: true, client: tx \}\)/.test(notif));
  ok("ops template · renderSellerOrderCancelledOps carries no customer PII (name/email/phone/address)",
    /export function renderSellerOrderCancelledOps/.test(ops) &&
    !/customerEmail|customerName|\bphone\b|shippingAddress/.test(ops.slice(ops.indexOf("renderSellerOrderCancelledOps"), ops.indexOf("renderSellerOrderCancelledOps") + 1800)));

  // read model + UI
  ok("read model · canCancel = cancellable SellerOrder status ∧ cancellable parent ∧ single-seller",
    /canCancel:\s*\n\s*sellerCanCancelSellerOrder\(so\.status\) &&\s*\n\s*\(CANCELLABLE_STATUSES as readonly string\[\]\)\.includes\(so\.order\.status\) &&\s*\n\s*so\.order\._count\.sellerOrders === 1/.test(readModel));
  ok("page · cancel card renders on canCancel ∧ canFulfil, independent of the parentFulfillable branch",
    /\{order\.canCancel && canFulfil && \(\s*\n\s*<Card>/.test(page) &&
    page.indexOf("order.canCancel && canFulfil") > page.indexOf("!order.parentFulfillable"));
  ok("panel · reason textarea is required and the consequence is spelled out before confirm",
    /required/.test(panel) && /cancels the customer’s entire order/i.test(panel) && /can’t be undone/i.test(panel));

  // scope — untouched
  ok("scope · admin cancelOrderAction NOT modified by this phase",
    !/9F-30B/.test(read("src/lib/admin/order-actions.ts")));
  ok("scope · admin 1P fulfilment NOT modified",
    !/9F-30B/.test(read("src/lib/admin/fulfillment-actions.ts")));
  ok("scope · checkout NOT modified",
    !/9F-30B/.test(read("src/lib/checkout.ts")));
  ok("scope · returns / settlements NOT modified",
    !/9F-30B/.test(read("src/lib/admin/returns-actions.ts")) &&
    !/9F-30B/.test(read("src/lib/seller/return-actions.ts")) &&
    !/9F-30B/.test(read("src/lib/admin/settlement-actions.ts")));
  ok("scope · no schema change", !/9F-30B/.test(read("prisma/schema.prisma")));
  ok("scope · seed-rbac.ts untouched", !/9F-30B/.test(read("scripts/seed-rbac.ts")));
}

// ── DB behaviour (rolled-back fixtures) ─────────────────────────────────
async function dbTests() {
  console.log("\n── sellerCancelSellerOrder (fixtures rolled back) ──");
  const category = await prisma.category.findFirst({ select: { id: true } });
  if (!category) { ok("(skipped — no category)", true); return; }
  const sfx = "9f30b-" + String(Date.now()).slice(-7);

  const orderEventsBefore = await prisma.orderEvent.count();
  const offerAdjBefore = await prisma.offerAdjustment.count();
  const emailBefore = await prisma.emailLog.count();

  async function seedSeller(tx: Prisma.TransactionClient, type = "THIRD_PARTY", n = "S") {
    return tx.seller.create({
      data: { type, status: "APPROVED", displayName: `${n} ${sfx}`, slug: `${n.toLowerCase()}-${sfx}-${Math.random().toString(36).slice(2, 7)}`, supportEmail: "s@t.test" },
      select: { id: true, displayName: true },
    });
  }
  async function seedOfferForProduct(tx: Prisma.TransactionClient, sellerId: string, opts: { soldCount?: number; qty?: number } = {}) {
    const product = await tx.product.create({
      data: { name: `P ${sfx}`, slug: `p-${sfx}-${Math.random().toString(36).slice(2, 7)}`, shortDescription: "s", description: "d", categoryId: category!.id, status: "ACTIVE", price: 1000, soldCount: opts.soldCount ?? 0 },
      select: { id: true },
    });
    const variant = await tx.variant.create({
      data: { productId: product.id, sku: `v-${sfx}-${Math.random().toString(36).slice(2, 7)}`, price: 1000, status: "ACTIVE", stock: 0 },
      select: { id: true },
    });
    const offer = await tx.offer.create({
      data: { sellerId, variantId: variant.id, price: 1000, condition: "NEW", status: "ACTIVE", sellerSku: `os-${sfx}-${Math.random().toString(36).slice(2, 7)}` },
      select: { id: true },
    });
    await tx.offerInventory.create({ data: { offerId: offer.id, sellerSku: null, quantity: opts.qty ?? 8, reserved: 0, reorderPoint: 3 } });
    return { productId: product.id, offerId: offer.id };
  }
  async function seedOrder(
    tx: Prisma.TransactionClient,
    spec: {
      parentStatus: string;
      sellerId: string;
      soStatus: string;
      offerId: string;
      productId: string;
      qty?: number;
      commissionAmount?: number;
      extraSeller?: string;
    },
  ) {
    const order = await tx.order.create({
      data: {
        orderNumber: `AX-T30B-${sfx}-${Math.random().toString(36).slice(2, 5)}`,
        email: "buyer@example.test",
        phone: "+639000000000",
        status: spec.parentStatus,
        paymentStatus: "PENDING",
        paymentMethod: "COD",
        subtotal: 1000,
        grandTotal: 1150,
        shippingFee: 150,
        shippingAddress: JSON.stringify({ firstName: "T", lastName: "B", line1: "1 St", city: "Manila", province: "NCR", postalCode: "1000", country: "PH" }),
      },
      select: { id: true, orderNumber: true },
    });
    const so = await tx.sellerOrder.create({
      data: {
        orderId: order.id, sellerId: spec.sellerId, sellerName: "S", sellerType: "THIRD_PARTY", supportEmail: "s@t.test",
        merchandiseSubtotal: 1000, shippingFee: 150, total: 1150, commissionRate: 1500,
        commissionAmount: spec.commissionAmount ?? 150, status: spec.soStatus,
      },
      select: { id: true },
    });
    await tx.orderItem.create({
      data: { orderId: order.id, sellerOrderId: so.id, sellerId: spec.sellerId, productId: spec.productId, offerId: spec.offerId, name: "Item", unitPrice: 1000, quantity: spec.qty ?? 2, lineTotal: (spec.qty ?? 2) * 1000 },
    });
    if (spec.extraSeller) {
      const so2 = await tx.sellerOrder.create({
        data: { orderId: order.id, sellerId: spec.extraSeller, sellerName: "S2", sellerType: "THIRD_PARTY", supportEmail: "s2@t.test", merchandiseSubtotal: 500, shippingFee: 0, total: 500, status: "PENDING_PAYMENT" },
        select: { id: true },
      });
      await tx.orderItem.create({
        data: { orderId: order.id, sellerOrderId: so2.id, sellerId: spec.extraSeller, productId: spec.productId, name: "Item2", unitPrice: 500, quantity: 1, lineTotal: 500 },
      });
    }
    return { orderId: order.id, orderNumber: order.orderNumber, sellerOrderId: so.id };
  }

  try {
    await prisma.$transaction(async (tx) => {
      const S1 = await seedSeller(tx, "THIRD_PARTY", "S1");
      const S2 = await seedSeller(tx, "THIRD_PARTY", "S2");
      const c1 = ctxFor(S1.id, S1.displayName);
      const c2 = ctxFor(S2.id, S2.displayName);

      // ── 1. PENDING_PAYMENT → CANCELLED (decline) ─────────────────────────
      {
        const of = await seedOfferForProduct(tx, S1.id, { soldCount: 5, qty: 8 });
        const o = await seedOrder(tx, { parentStatus: "PENDING_PAYMENT", sellerId: S1.id, soStatus: "PENDING_PAYMENT", offerId: of.offerId, productId: of.productId, qty: 2, commissionAmount: 150 });
        const r = await sellerCancelSellerOrder(c1, o.sellerOrderId, "Out of stock at our warehouse", tx);
        ok("1 · decline (PENDING_PAYMENT) succeeds", r.ok === true, JSON.stringify(r));
        ok("1 · result.from = PENDING_PAYMENT, previousParentStatus = PENDING_PAYMENT",
          r.ok && r.from === "PENDING_PAYMENT" && r.previousParentStatus === "PENDING_PAYMENT");
        const so = await tx.sellerOrder.findUnique({ where: { id: o.sellerOrderId }, select: { status: true, commissionAmount: true } });
        ok("1 · SellerOrder → CANCELLED, commissionAmount zeroed", so?.status === "CANCELLED" && so?.commissionAmount === 0);
        const ord = await tx.order.findUnique({ where: { id: o.orderId }, select: { status: true, paymentStatus: true } });
        ok("5 · parent Order → CANCELLED", ord?.status === "CANCELLED");
        ok("1 · parent Order.paymentStatus untouched (still PENDING)", ord?.paymentStatus === "PENDING");
        const inv = await tx.offerInventory.findFirst({ where: { offerId: of.offerId }, select: { id: true, quantity: true } });
        ok("6 · OfferInventory restored 8 → 10 (exactly the 2 units)", inv?.quantity === 10);
        const adj = await tx.offerAdjustment.findMany({ where: { offerInventoryId: inv!.id, reason: "CANCELLATION" }, select: { delta: true } });
        ok("7 · exactly ONE OfferAdjustment(CANCELLATION), delta +2", adj.length === 1 && adj[0].delta === 2);
        const prod = await tx.product.findUnique({ where: { id: of.productId }, select: { soldCount: true } });
        ok("8 · Product.soldCount rolled back 5 → 3", prod?.soldCount === 3);
        const ev = await tx.orderEvent.findMany({ where: { orderId: o.orderId, status: "CANCELLED" }, select: { title: true, detail: true } });
        ok("· exactly ONE OrderEvent(CANCELLED) with the reason in the detail",
          ev.length === 1 && ev[0].title === "Order cancelled" && /Out of stock at our warehouse/.test(ev[0].detail ?? ""));

        // ── 7/idempotency: repeat cancellation ────────────────────────────
        const again = await sellerCancelSellerOrder(c1, o.sellerOrderId, "again", tx);
        ok("idem · a second cancellation is rejected (SellerOrder already CANCELLED)", again.ok === false);
        ok("idem · OfferInventory NOT restored twice (still 10)",
          (await tx.offerInventory.findFirst({ where: { offerId: of.offerId }, select: { quantity: true } }))?.quantity === 10);
        ok("idem · still exactly one OfferAdjustment(CANCELLATION)",
          (await tx.offerAdjustment.count({ where: { offerInventoryId: inv!.id, reason: "CANCELLATION" } })) === 1);
        ok("idem · still exactly one OrderEvent(CANCELLED)",
          (await tx.orderEvent.count({ where: { orderId: o.orderId, status: "CANCELLED" } })) === 1);
        ok("idem · Product.soldCount still 3 (not rolled back twice)",
          (await tx.product.findUnique({ where: { id: of.productId }, select: { soldCount: true } }))?.soldCount === 3);
      }

      // ── 2. PROCESSING → CANCELLED (cancel) ───────────────────────────────
      {
        const of = await seedOfferForProduct(tx, S1.id, { soldCount: 3, qty: 5 });
        const o = await seedOrder(tx, { parentStatus: "PROCESSING", sellerId: S1.id, soStatus: "PROCESSING", offerId: of.offerId, productId: of.productId, qty: 1 });
        const r = await sellerCancelSellerOrder(c1, o.sellerOrderId, "Damaged in handling", tx);
        ok("2 · cancel (PROCESSING) succeeds, from = PROCESSING", r.ok === true && r.ok && r.from === "PROCESSING");
        ok("2 · parent Order → CANCELLED",
          (await tx.order.findUnique({ where: { id: o.orderId }, select: { status: true } }))?.status === "CANCELLED");
        ok("2 · OfferInventory restored 5 → 6",
          (await tx.offerInventory.findFirst({ where: { offerId: of.offerId }, select: { quantity: true } }))?.quantity === 6);
      }

      // ── 3. reason required ──────────────────────────────────────────────
      {
        const of = await seedOfferForProduct(tx, S1.id);
        const o = await seedOrder(tx, { parentStatus: "PROCESSING", sellerId: S1.id, soStatus: "PROCESSING", offerId: of.offerId, productId: of.productId });
        const r = await sellerCancelSellerOrder(c1, o.sellerOrderId, "   ", tx);
        ok("3 · blank reason → VALIDATION, nothing changed",
          r.ok === false && "code" in r && r.code === "VALIDATION" &&
          (await tx.order.findUnique({ where: { id: o.orderId }, select: { status: true } }))?.status === "PROCESSING");
      }

      // ── 4. wrong seller blocked ─────────────────────────────────────────
      {
        const of = await seedOfferForProduct(tx, S1.id);
        const o = await seedOrder(tx, { parentStatus: "PROCESSING", sellerId: S1.id, soStatus: "PROCESSING", offerId: of.offerId, productId: of.productId });
        const r = await sellerCancelSellerOrder(c2, o.sellerOrderId, "not mine", tx);
        ok("4 · another seller cannot cancel this order → NOT_FOUND",
          r.ok === false && "code" in r && r.code === "NOT_FOUND" &&
          (await tx.order.findUnique({ where: { id: o.orderId }, select: { status: true } }))?.status === "PROCESSING");
      }

      // ── 5. parent already moved on (SHIPPED) ────────────────────────────
      {
        const of = await seedOfferForProduct(tx, S1.id);
        const o = await seedOrder(tx, { parentStatus: "SHIPPED", sellerId: S1.id, soStatus: "PROCESSING", offerId: of.offerId, productId: of.productId });
        const r = await sellerCancelSellerOrder(c1, o.sellerOrderId, "too late", tx);
        ok("5 · parent Order past cancellable (SHIPPED) → CONFLICT, no restore",
          r.ok === false && "code" in r && r.code === "CONFLICT" &&
          (await tx.offerInventory.findFirst({ where: { offerId: of.offerId }, select: { quantity: true } }))?.quantity === 8);
      }

      // ── 6. multi-seller parent refused ─────────────────────────────────
      {
        const of = await seedOfferForProduct(tx, S1.id);
        const o = await seedOrder(tx, { parentStatus: "PROCESSING", sellerId: S1.id, soStatus: "PROCESSING", offerId: of.offerId, productId: of.productId, extraSeller: S2.id });
        const r = await sellerCancelSellerOrder(c1, o.sellerOrderId, "multi", tx);
        ok("6 · multi-seller parent → VALIDATION (contact Axiaro), nothing changed",
          r.ok === false && "code" in r && r.code === "VALIDATION" &&
          (await tx.order.findUnique({ where: { id: o.orderId }, select: { status: true } }))?.status === "PROCESSING");
      }

      // ── 7. existing 3P happy path unchanged (accept still works) ─────────
      {
        const of = await seedOfferForProduct(tx, S1.id);
        const o = await seedOrder(tx, { parentStatus: "PROCESSING", sellerId: S1.id, soStatus: "PENDING_PAYMENT", offerId: of.offerId, productId: of.productId });
        const r = await advanceSellerOrderStatus(c1, o.sellerOrderId, "PROCESSING", tx);
        ok("7 · advanceSellerOrderStatus PENDING_PAYMENT → PROCESSING still works (accept)", r.ok === true, JSON.stringify(r));
      }

      // ── 8. commission already zero → still fine (no negative) ───────────
      {
        const of = await seedOfferForProduct(tx, S1.id);
        const o = await seedOrder(tx, { parentStatus: "PROCESSING", sellerId: S1.id, soStatus: "PROCESSING", offerId: of.offerId, productId: of.productId, commissionAmount: 0 });
        const r = await sellerCancelSellerOrder(c1, o.sellerOrderId, "already zero", tx);
        ok("9 · commission handling — zeroed, no clawback (never settled)",
          r.ok === true && r.ok && r.clawbackEvents.length === 0 &&
          (await tx.sellerOrder.findUnique({ where: { id: o.sellerOrderId }, select: { commissionAmount: true, settlementStatus: true } }))?.commissionAmount === 0);
      }

      // ── 10. Ops sender SKIPPED for a FIRST_PARTY seller order ───────────
      {
        const fp = await tx.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
        if (fp) {
          const order = await tx.order.create({
            data: { orderNumber: `AX-T30B-FP-${sfx}`, email: "b@e.test", phone: "+630", status: "CANCELLED", paymentStatus: "PENDING", paymentMethod: "COD", subtotal: 100, grandTotal: 100, shippingFee: 0, shippingAddress: "{}" },
            select: { id: true },
          });
          const so = await tx.sellerOrder.create({
            data: { orderId: order.id, sellerId: fp.id, sellerName: "Axiaro", sellerType: "FIRST_PARTY", supportEmail: "o@t.test", merchandiseSubtotal: 100, total: 100, status: "CANCELLED" },
            select: { id: true },
          });
          const audit = await tx.adminAuditLog.create({ data: { action: "seller_order.cancelled", targetId: order.id, meta: JSON.stringify({ from: "PROCESSING", previousParentStatus: "PROCESSING", restockedUnits: 1, reason: "x" }) }, select: { id: true } });
          const r = await sendSellerOrderCancelledOps(so.id, audit.id, { client: tx });
          ok("11 · FIRST_PARTY seller order → ops cancel notice is SKIPPED (nothing sent)",
            r.status === "SKIPPED" && r.ok === true, JSON.stringify(r));
        } else {
          ok("11 · (skipped — no FIRST_PARTY seller)", true);
        }
      }

      throw new Rollback();
    }, { timeout: 120000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("ROLLBACK · no OrderEvent leaked", (await prisma.orderEvent.count()) === orderEventsBefore);
  ok("ROLLBACK · no OfferAdjustment leaked", (await prisma.offerAdjustment.count()) === offerAdjBefore);
  ok("ROLLBACK · no EmailLog leaked", (await prisma.emailLog.count()) === emailBefore);
  ok("ROLLBACK · no fixture order leaked", (await prisma.order.count({ where: { orderNumber: { contains: sfx } } })) === 0);
  ok("ROLLBACK · no fixture seller leaked", (await prisma.seller.count({ where: { slug: { contains: sfx } } })) === 0);
}

async function main() {
  console.log("\nPHASE 9F-30B — 3P seller order cancellation / rejection\n");
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
