/**
 * PHASE 9F-33A — 3P parent-PENDING_PAYMENT dead-end.
 *
 * ROOT CAUSE (audit): a THIRD_PARTY COD order created BEFORE 9F-15B was made at
 * `Order.status = PENDING_PAYMENT` (like a 1P COD order) and relied on an admin
 * clicking "Confirm order". If nobody did, the seller could not Accept it
 * (`canTransitionSellerOrder` needs `isParentOrderFulfillable`) — a dead-end.
 * The live example `AX-260907-100358` (placed 2026-09-07T10:13Z, ~8h before the
 * 9F-15B commit) is exactly this. Its sibling `AX-260907-100348` (also pre-15B)
 * was rescued by the admin "Confirm order" button and fully fulfilled.
 *
 * FIX: current checkout ALREADY cannot recreate the state — every 3P COD order
 * goes through `shouldAutoConfirmAtCheckout({THIRD_PARTY, NONE}) === true` and is
 * created directly at PROCESSING in one atomic transaction. 9F-33A adds a
 * belt-and-braces pre-write invariant in `createOrderFromCart` so a regression
 * in that gate can never produce the dead-end, plus this regression suite.
 *
 * DB tests use rolled-back fixtures; nothing touches AX-260907-100358.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f33a.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient, Prisma } from "@prisma/client";
import { shouldAutoConfirmAtCheckout, canTransition, isCancellable } from "@/lib/orders/status";
import {
  canTransitionSellerOrder,
  isParentOrderFulfillable,
  sellerCanCancelSellerOrder,
} from "@/lib/marketplace/seller-order-status";
import { CANCELLABLE_STATUSES } from "@/lib/orders/status";
import {
  advanceSellerOrderStatus,
  sellerCancelSellerOrder,
} from "@/lib/marketplace/seller-order-repository";
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
  sellerId, sellerName,
  sellerUserId: "su-" + sellerId, userId: "u-" + sellerId,
  role: "OWNER" as SellerContext["role"], permissions: new Set(["manage_seller_fulfillment"]),
});

// ── pure — the invariant + the recovery predicates ──────────────────────
function pureTests() {
  console.log("\n── pure ──");
  // current checkout: 3P COD ALWAYS auto-confirms → never PENDING_PAYMENT
  ok("shouldAutoConfirmAtCheckout THIRD_PARTY + NONE → true (checkout hard-codes paymentMethod NONE)",
    shouldAutoConfirmAtCheckout({ sellerType: "THIRD_PARTY", paymentMethod: "NONE" }) === true);
  ok("shouldAutoConfirmAtCheckout THIRD_PARTY + COD → true",
    shouldAutoConfirmAtCheckout({ sellerType: "THIRD_PARTY", paymentMethod: "COD" }) === true);
  ok("shouldAutoConfirmAtCheckout FIRST_PARTY + NONE → false (1P keeps the admin Confirm-order flow)",
    shouldAutoConfirmAtCheckout({ sellerType: "FIRST_PARTY", paymentMethod: "NONE" }) === false);
  ok("shouldAutoConfirmAtCheckout THIRD_PARTY + CARD → false (future paid-online 3P confirms via webhook, not a dead-end)",
    shouldAutoConfirmAtCheckout({ sellerType: "THIRD_PARTY", paymentMethod: "CARD" }) === false);

  // seller-accept guard: a 3P SellerOrder cannot advance while the parent isn't fulfillable
  ok("isParentOrderFulfillable(PENDING_PAYMENT) → false", isParentOrderFulfillable("PENDING_PAYMENT") === false);
  ok("isParentOrderFulfillable(PROCESSING) → true", isParentOrderFulfillable("PROCESSING") === true);
  ok("canTransitionSellerOrder PENDING_PAYMENT→PROCESSING blocked while parent PENDING_PAYMENT",
    canTransitionSellerOrder("PENDING_PAYMENT", "PROCESSING", { parentOrderStatus: "PENDING_PAYMENT" }) === false);
  ok("canTransitionSellerOrder PENDING_PAYMENT→PROCESSING allowed once parent PROCESSING",
    canTransitionSellerOrder("PENDING_PAYMENT", "PROCESSING", { parentOrderStatus: "PROCESSING" }) === true);

  // recovery paths that EXIST today for a stuck parent-PENDING_PAYMENT order
  ok("admin recovery · canTransition(PENDING_PAYMENT→PROCESSING, {codConfirm}) → true",
    canTransition("PENDING_PAYMENT", "PROCESSING", { codConfirm: true }) === true);
  ok("admin recovery · canTransition(PENDING_PAYMENT→PROCESSING) without codConfirm → false (never a silent confirm)",
    canTransition("PENDING_PAYMENT", "PROCESSING") === false);
  ok("seller-decline recovery · sellerCanCancelSellerOrder(PENDING_PAYMENT) + parent PENDING_PAYMENT ∈ CANCELLABLE_STATUSES",
    sellerCanCancelSellerOrder("PENDING_PAYMENT") && (CANCELLABLE_STATUSES as string[]).includes("PENDING_PAYMENT"));
  ok("customer-cancel recovery · isCancellable(PENDING_PAYMENT) → true", isCancellable("PENDING_PAYMENT") === true);
}

// ── static wiring ──────────────────────────────────────────────────────
function staticTests() {
  console.log("\n── static wiring ──");
  const checkout = read("src/lib/checkout.ts");
  const status = read("src/lib/orders/status.ts");
  const adminOrderActions = read("src/lib/admin/order-actions.ts");
  const adminOrderPage = read("src/app/admin/(shell)/orders/[id]/page.tsx");
  const sellerOrderStatus = read("src/lib/marketplace/seller-order-status.ts");

  ok("checkout · Order.status = autoConfirmParent ? PROCESSING : PENDING_PAYMENT (false branch is 1P-only)",
    /status: autoConfirmParent \? "PROCESSING" : "PENDING_PAYMENT",/.test(checkout));
  ok("checkout · COD invariants untouched — paymentMethod NONE, paymentStatus PENDING",
    /paymentMethod: "NONE",\s*\n\s*paymentStatus: "PENDING",/.test(checkout));
  ok("checkout · 9F-33A pre-write invariant: a THIRD_PARTY order that would NOT auto-confirm is refused",
    /if \(soSeller\.type === "THIRD_PARTY" && !autoConfirmParent\) \{[\s\S]{0,400}return \{\s*\n\s*ok: false,\s*\n\s*code: "VALIDATION",/.test(checkout));
  ok("checkout · that invariant fires BEFORE prisma.$transaction (a violation writes nothing)",
    checkout.indexOf('soSeller.type === "THIRD_PARTY" && !autoConfirmParent') < checkout.indexOf("await prisma.$transaction"));
  ok("checkout · shouldAutoConfirmAtCheckout call unchanged (still THIRD_PARTY + paymentMethod NONE)",
    /const autoConfirmParent = shouldAutoConfirmAtCheckout\(\{\s*\n\s*sellerType: soSeller\.type,\s*\n\s*paymentMethod: "NONE",\s*\n\s*\}\);/.test(checkout));
  ok("orders/status · shouldAutoConfirmAtCheckout unchanged (THIRD_PARTY ∧ COD)",
    /return opts\.sellerType === "THIRD_PARTY" && cod;/.test(status));

  // admin recovery path exists and is seller-type-agnostic
  ok("admin · confirmOrderAction confirms any PENDING_PAYMENT order with no online payment (seller-type-agnostic)",
    /if \(order\.status !== "PENDING_PAYMENT"\)/.test(adminOrderActions) &&
    /if \(order\.payments\.length > 0\)/.test(adminOrderActions) &&
    /canTransition\(order\.status, "PROCESSING", \{ codConfirm: true \}\)/.test(adminOrderActions) &&
    !/sellerType|THIRD_PARTY|FIRST_PARTY/.test(adminOrderActions.slice(adminOrderActions.indexOf("export async function confirmOrderAction"), adminOrderActions.indexOf("export async function confirmOrderAction") + 1800)));
  ok("admin · order detail page shows Confirm order for any PENDING_PAYMENT + no online payment (seller-agnostic)",
    /const canConfirm = canManage && order\.status === "PENDING_PAYMENT" && !order\.hasOnlinePayment;/.test(adminOrderPage) &&
    !/canConfirm[\s\S]{0,80}(sellerType|THIRD_PARTY|FIRST_PARTY)/.test(adminOrderPage));

  // seller-accept guard
  ok("seller · canTransitionSellerOrder requires isParentOrderFulfillable (blocks accept while parent PENDING_PAYMENT)",
    /if \(!isParentOrderFulfillable\(opts\.parentOrderStatus\)\) return false;/.test(sellerOrderStatus));

  // scope
  ok("scope · no new customer email / SLA / returns / settlements / offer change",
    !/9F-33A/.test(read("src/lib/email/notifications.ts")) &&
    !/9F-33A/.test(read("src/lib/marketplace/seller-order-sla-job.ts")) &&
    !/9F-33A/.test(read("src/lib/admin/returns-actions.ts")) &&
    !/9F-33A/.test(read("src/lib/admin/settlement-actions.ts")));
  ok("scope · seller cancellation (9F-30B) + customer cancellation (9F-30D) code untouched",
    !/9F-33A/.test(read("src/lib/marketplace/seller-order-repository.ts")) &&
    !/9F-33A/.test(read("src/lib/account/order-actions.ts")));
  ok("scope · no schema change", !/9F-33A/.test(read("prisma/schema.prisma")));
  ok("scope · seed-rbac.ts untouched", !/9F-33A/.test(read("scripts/seed-rbac.ts")));
}

// ── DB behaviour (rolled-back) ─────────────────────────────────────────
async function dbTests() {
  console.log("\n── DB (rolled-back fixtures; AX-260907-100358 never touched) ──");
  const category = await prisma.category.findFirst({ select: { id: true } });
  if (!category) { ok("(skipped — no category)", true); return; }
  const sfx = "9f33a-" + String(Date.now()).slice(-7);
  const eventsBefore = await prisma.orderEvent.count();

  async function seed(tx: Prisma.TransactionClient, parentStatus: string) {
    const seller = await tx.seller.create({ data: { type: "THIRD_PARTY", status: "APPROVED", displayName: `S ${sfx}`, slug: `s-${sfx}-${Math.random().toString(36).slice(2, 6)}`, supportEmail: "s@t.test" }, select: { id: true, displayName: true } });
    const product = await tx.product.create({ data: { name: `P ${sfx}`, slug: `p-${sfx}-${Math.random().toString(36).slice(2, 7)}`, shortDescription: "s", description: "d", categoryId: category!.id, status: "ACTIVE", price: 1000 }, select: { id: true } });
    const variant = await tx.variant.create({ data: { productId: product.id, sku: `v-${sfx}-${Math.random().toString(36).slice(2, 7)}`, price: 1000, status: "ACTIVE", stock: 0 }, select: { id: true } });
    const offer = await tx.offer.create({ data: { sellerId: seller.id, variantId: variant.id, price: 1000, condition: "NEW", status: "ACTIVE", sellerSku: `os-${sfx}-${Math.random().toString(36).slice(2, 6)}` }, select: { id: true } });
    await tx.offerInventory.create({ data: { offerId: offer.id, sellerSku: null, quantity: 10, reserved: 0, reorderPoint: 3 } });
    const order = await tx.order.create({
      // exactly what checkout writes for a 3P COD order when autoConfirmParent is (parentStatus === "PROCESSING")
      data: { orderNumber: `AX-T33A-${sfx}-${Math.random().toString(36).slice(2, 5)}`, email: "b@e.test", phone: "+630", status: parentStatus, paymentStatus: "PENDING", paymentMethod: "NONE", subtotal: 1000, grandTotal: 1150, shippingFee: 150, shippingAddress: "{}" },
      select: { id: true, orderNumber: true },
    });
    const so = await tx.sellerOrder.create({ data: { orderId: order.id, sellerId: seller.id, sellerName: "S", sellerType: "THIRD_PARTY", supportEmail: "s@t.test", merchandiseSubtotal: 1000, shippingFee: 150, total: 1150, status: "PENDING_PAYMENT" }, select: { id: true } });
    await tx.orderItem.create({ data: { orderId: order.id, sellerOrderId: so.id, sellerId: seller.id, productId: product.id, offerId: offer.id, name: "Item", unitPrice: 1000, quantity: 1, lineTotal: 1000 } });
    return { sellerId: seller.id, sellerName: seller.displayName, orderId: order.id, orderNumber: order.orderNumber, sellerOrderId: so.id };
  }

  try {
    await prisma.$transaction(async (tx) => {
      // ── NEW 3P COD order (checkout auto-confirms → parent PROCESSING) ──
      {
        const f = await seed(tx, "PROCESSING");
        const ord = await tx.order.findUniqueOrThrow({ where: { id: f.orderId }, select: { status: true, paymentStatus: true, paymentMethod: true } });
        const so = await tx.sellerOrder.findUniqueOrThrow({ where: { id: f.sellerOrderId }, select: { status: true } });
        ok("NEW · parent Order = PROCESSING, SellerOrder = PENDING_PAYMENT (the intended 3P COD shape)",
          ord.status === "PROCESSING" && so.status === "PENDING_PAYMENT");
        ok("NEW · paymentStatus = PENDING, paymentMethod = NONE (COD, untouched)",
          ord.paymentStatus === "PENDING" && ord.paymentMethod === "NONE");
        const acc = await advanceSellerOrderStatus(ctxFor(f.sellerId, f.sellerName), f.sellerOrderId, "PROCESSING", tx);
        ok("NEW · seller CAN Accept (PENDING_PAYMENT → PROCESSING)", acc.ok === true, JSON.stringify(acc));
      }
      // ── NEW 3P COD order — seller Declines instead ──
      {
        const f = await seed(tx, "PROCESSING");
        const dec = await sellerCancelSellerOrder(ctxFor(f.sellerId, f.sellerName), f.sellerOrderId, "cannot fulfil", tx);
        ok("NEW · seller CAN Decline (9F-30B)", dec.ok === true, JSON.stringify(dec));
      }

      // ── LEGACY-shaped order (parent + SellerOrder both PENDING_PAYMENT) ──
      {
        const f = await seed(tx, "PENDING_PAYMENT");
        const acc = await advanceSellerOrderStatus(ctxFor(f.sellerId, f.sellerName), f.sellerOrderId, "PROCESSING", tx);
        ok("LEGACY · seller CANNOT Accept while parent is PENDING_PAYMENT (guarded)",
          acc.ok === false && "code" in acc && acc.code === "VALIDATION");

        // recovery A — admin "Confirm order" (the atomic gate confirmOrderAction uses)
        const confirmed = await tx.$executeRaw`UPDATE "Order" SET "status" = 'PROCESSING', "updatedAt" = now() WHERE "id" = ${f.orderId} AND "status" = 'PENDING_PAYMENT'`;
        ok("LEGACY · admin Confirm-order atomic gate moves parent PENDING_PAYMENT → PROCESSING (1 row)", confirmed === 1);
        const acc2 = await advanceSellerOrderStatus(ctxFor(f.sellerId, f.sellerName), f.sellerOrderId, "PROCESSING", tx);
        ok("LEGACY · after admin confirm, the seller CAN Accept → full recovery", acc2.ok === true, JSON.stringify(acc2));
      }
      {
        // recovery B — seller Decline works straight from parent PENDING_PAYMENT
        const f = await seed(tx, "PENDING_PAYMENT");
        const dec = await sellerCancelSellerOrder(ctxFor(f.sellerId, f.sellerName), f.sellerOrderId, "cannot fulfil", tx);
        ok("LEGACY · seller Decline recovers a parent-PENDING_PAYMENT order (parent PENDING_PAYMENT ∈ CANCELLABLE_STATUSES)",
          dec.ok === true, JSON.stringify(dec));
        ok("LEGACY · after decline, parent Order = CANCELLED",
          (await tx.order.findUniqueOrThrow({ where: { id: f.orderId }, select: { status: true } })).status === "CANCELLED");
      }

      throw new Rollback();
    }, { timeout: 120000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("ROLLBACK · no OrderEvent leaked", (await prisma.orderEvent.count()) === eventsBefore);
  ok("ROLLBACK · no fixture order leaked", (await prisma.order.count({ where: { orderNumber: { contains: sfx } } })) === 0);

  // ── PRODUCTION read-only: prove no NEW invalid combo + locate the one legacy straggler ──
  console.log("\n── production read-only ──");
  const stuck = await prisma.sellerOrder.findMany({
    where: { sellerType: "THIRD_PARTY", status: "PENDING_PAYMENT", order: { is: { status: "PENDING_PAYMENT" } } },
    select: { order: { select: { orderNumber: true, placedAt: true } } },
  });
  console.log("  3P orders at parent PENDING_PAYMENT + SellerOrder PENDING_PAYMENT:", JSON.stringify(stuck.map((s) => [s.order.orderNumber, s.order.placedAt?.toISOString()])));
  ok("prod · at most ONE such order, and it is the known pre-9F-15B legacy AX-260907-100358",
    stuck.length <= 1 && (stuck.length === 0 || stuck[0].order.orderNumber === "AX-260907-100358"));
  const anomalies = await prisma.sellerOrder.findMany({
    where: { sellerType: "THIRD_PARTY", status: "PENDING_PAYMENT", order: { is: { status: { notIn: ["PENDING_PAYMENT", "PROCESSING"] } } } },
    select: { order: { select: { orderNumber: true, status: true } } },
  });
  ok("prod · NO 3P SellerOrder PENDING_PAYMENT on an already-shipped/delivered/cancelled parent (no drift)",
    anomalies.length === 0, JSON.stringify(anomalies.map((a) => [a.order.orderNumber, a.order.status])));
  const legacyPlaced = stuck[0]?.order.placedAt;
  ok("prod · the straggler predates the 9F-15B commit (2026-09-07T18:31:09Z) → confirmed legacy, not a current-checkout product",
    !legacyPlaced || legacyPlaced < new Date("2026-09-07T18:31:09Z"), legacyPlaced?.toISOString());
}

async function main() {
  console.log("\nPHASE 9F-33A — 3P parent-PENDING_PAYMENT dead-end\n");
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
