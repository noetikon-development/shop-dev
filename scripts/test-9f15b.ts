/**
 * PHASE 9F-15B — auto-confirm THIRD_PARTY COD orders at checkout.
 *
 * A new THIRD_PARTY pay-on-delivery order is created with
 * `Order.status = PROCESSING` (not PENDING_PAYMENT) + the same "Preparing your
 * order" OrderEvent + `order.confirmed` audit the admin "Confirm order" action
 * writes — so the seller can Accept it immediately. FIRST_PARTY / paid orders
 * are untouched. Payment stays COD (NONE / PENDING), no Payment row.
 *
 * DB tests reproduce checkout's Order/SellerOrder create with the same
 * `shouldAutoConfirmAtCheckout` gate, inside ONE rolled-back transaction.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f15b.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { shouldAutoConfirmAtCheckout, canTransition } from "../src/lib/orders/status";
import {
  allowedSellerOrderMoves,
  isParentOrderFulfillable,
  sellerAdvanceLabels,
} from "../src/lib/marketplace/seller-order-status";
import { ORDER_STATUS_META } from "../src/lib/constants";

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

function pureTests() {
  console.log("\n── pure — shouldAutoConfirmAtCheckout ──");
  ok("THIRD_PARTY + NONE (COD) → auto-confirm", shouldAutoConfirmAtCheckout({ sellerType: "THIRD_PARTY", paymentMethod: "NONE" }) === true);
  ok("THIRD_PARTY + COD → auto-confirm", shouldAutoConfirmAtCheckout({ sellerType: "THIRD_PARTY", paymentMethod: "COD" }) === true);
  ok("FIRST_PARTY + NONE (COD) → NOT auto-confirmed", shouldAutoConfirmAtCheckout({ sellerType: "FIRST_PARTY", paymentMethod: "NONE" }) === false);
  ok("THIRD_PARTY + CARD (paid) → NOT auto-confirmed", shouldAutoConfirmAtCheckout({ sellerType: "THIRD_PARTY", paymentMethod: "CARD" }) === false);
  ok("THIRD_PARTY + GCASH (paid) → NOT auto-confirmed", shouldAutoConfirmAtCheckout({ sellerType: "THIRD_PARTY", paymentMethod: "GCASH" }) === false);
  ok("FIRST_PARTY + CARD → NOT auto-confirmed", shouldAutoConfirmAtCheckout({ sellerType: "FIRST_PARTY", paymentMethod: "CARD" }) === false);

  console.log("\n── pure — the transition uses the same codConfirm relaxation ──");
  ok("canTransition PENDING_PAYMENT → PROCESSING with codConfirm", canTransition("PENDING_PAYMENT", "PROCESSING", { codConfirm: true }) === true);
  ok("canTransition PENDING_PAYMENT → PROCESSING WITHOUT the flag is still forbidden", canTransition("PENDING_PAYMENT", "PROCESSING") === false);

  console.log("\n── pure — seller sees 'Accept order' once the parent is PROCESSING ──");
  ok("parent PROCESSING is fulfillable", isParentOrderFulfillable("PROCESSING") === true);
  ok("SellerOrder PENDING_PAYMENT + parent PROCESSING → allowedMoves [PROCESSING]", JSON.stringify(allowedSellerOrderMoves("PENDING_PAYMENT", { parentOrderStatus: "PROCESSING" })) === '["PROCESSING"]');
  ok("that move's button label is 'Accept order' (primary)", (() => { const l = sellerAdvanceLabels("PENDING_PAYMENT", "PROCESSING"); return l.button === "Accept order" && l.primary === true; })());
  ok("parent PENDING_PAYMENT → NO moves (panel hidden — the 1P case)", JSON.stringify(allowedSellerOrderMoves("PENDING_PAYMENT", { parentOrderStatus: "PENDING_PAYMENT" })) === "[]");
}

function staticTests() {
  console.log("\n── static wiring ──");
  const checkout = read("src/lib/checkout.ts");
  const orderActions = read("src/lib/admin/order-actions.ts");

  ok("checkout imports the pure gate from orders/status", /import \{ shouldAutoConfirmAtCheckout \} from "@\/lib\/orders\/status";/.test(checkout));
  ok("autoConfirmParent gated on THIRD_PARTY + COD (paymentMethod NONE)", /const autoConfirmParent = shouldAutoConfirmAtCheckout\(\{\s*\n?\s*sellerType: soSeller\.type,\s*\n?\s*paymentMethod: "NONE",\s*\n?\s*\}\);/.test(checkout));
  ok("Order.status is conditional on autoConfirmParent", /status: autoConfirmParent \? "PROCESSING" : "PENDING_PAYMENT",/.test(checkout));
  ok("paymentMethod / paymentStatus are UNCHANGED (still NONE / PENDING literals)", /paymentMethod: "NONE",\s*\n\s*paymentStatus: "PENDING",/.test(checkout));
  ok("a PROCESSING OrderEvent is added only when autoConfirmParent", /\.\.\.\(autoConfirmParent\s*\n?\s*\? \[\s*\n?\s*\{\s*\n?\s*status: "PROCESSING",\s*\n?\s*title: "Preparing your order",\s*\n?\s*detail: ORDER_STATUS_META\.PROCESSING\?\.description \?\? null,/.test(checkout));
  ok("post-commit audit: order.confirmed, system actor, trigger tag", /if \(autoConfirmParent\) \{[\s\S]{0,400}writeAudit\(\{\s*\n?\s*actorUserId: null,\s*\n?\s*action: "order\.confirmed",[\s\S]{0,400}trigger: "checkout_3p_cod_autoconfirm"/.test(checkout));
  ok("post-commit: existing 'preparing your order' email, guarded, key-deduped", /if \(autoConfirmParent\) \{[\s\S]{0,700}scheduleEmail\(\(\) => sendOrderProcessing\(created\.id\)\)/.test(checkout));
  ok("no Payment row / PayMongo / OfferInventory touched by the auto-confirm block", !/tx\.payment\.|prisma\.payment\.|PAYMONGO_|checkout-session|paymentRefund/i.test(checkout.slice(checkout.indexOf("autoConfirmParent"), checkout.indexOf("autoConfirmParent") + 4000)));

  // parity with the admin confirm flow
  ok("event title matches confirmOrderAction ('Preparing your order')", /PROCESSING: "Preparing your order"/.test(orderActions) && /title: "Preparing your order",/.test(checkout));
  ok("event detail source matches confirmOrderAction (ORDER_STATUS_META.PROCESSING)", /ORDER_STATUS_META\.PROCESSING\?\.description/.test(orderActions) && /ORDER_STATUS_META\.PROCESSING\?\.description/.test(checkout));
  ok("audit action matches confirmOrderAction ('order.confirmed')", /action: "order\.confirmed",/.test(orderActions) && /action: "order\.confirmed",/.test(checkout));
  ok("confirmOrderAction itself is unchanged (still rejects a non-PENDING_PAYMENT order)", /if \(order\.status !== "PENDING_PAYMENT"\)/.test(orderActions));

  // guardrails
  ok("no new EmailType (sendOrderProcessing already exists)", /export async function sendOrderProcessing\(/.test(read("src/lib/email/notifications.ts")) && !/9F-15B/.test(read("src/lib/email/send.ts")));
  ok("9F-12b rollup untouched", !/9F-15B/.test(read("src/lib/marketplace/seller-order-repository.ts")));
  ok("admin fulfilment actions untouched", !/9F-15B/.test(read("src/lib/admin/fulfillment-actions.ts")));
  ok("settlement / returns / cancellation untouched", !/9F-15B/.test(read("src/lib/marketplace/settlement.ts")) && !/9F-15B/.test(read("src/lib/admin/returns-actions.ts")));
  ok("scope · seed-rbac.ts untouched", !/9F-15B/.test(read("scripts/seed-rbac.ts")));
  ok("scope · no schema change", !/9F-15B/.test(read("prisma/schema.prisma")));
}

/** Reproduce checkout's Order + SellerOrder + events create for one seller type. */
async function makeCheckoutOrder(tx: Tx, sellerType: string, t: string) {
  // `Seller.type` is DB-unique for FIRST_PARTY — reuse the real Axiaro row for
  // that case; create a throwaway THIRD_PARTY seller otherwise.
  const seller =
    sellerType === "FIRST_PARTY"
      ? await tx.seller.findFirstOrThrow({ where: { type: "FIRST_PARTY" }, select: { id: true, type: true, displayName: true, supportEmail: true, commissionRate: true } })
      : await tx.seller.create({
          data: {
            type: "THIRD_PARTY",
            status: "APPROVED",
            displayName: `S9f15b ${t}`,
            slug: `s9f15b-tp-${t}`,
            supportEmail: `s-${t}@t.test`,
            contentStatus: "DRAFT",
          },
          select: { id: true, type: true, displayName: true, supportEmail: true, commissionRate: true },
        });

  const autoConfirm = shouldAutoConfirmAtCheckout({ sellerType: seller.type, paymentMethod: "NONE" });
  const order = await tx.order.create({
    data: {
      orderNumber: `AX-T9F15B-${t}-${Math.random().toString(36).slice(2, 5)}`,
      email: "buyer@example.test",
      phone: "+639000000000",
      status: autoConfirm ? "PROCESSING" : "PENDING_PAYMENT",
      paymentMethod: "NONE",
      paymentStatus: "PENDING",
      subtotal: 119900,
      shippingFee: 15000,
      discountTotal: 0,
      grandTotal: 134900,
      shippingAddress: "{}",
      events: {
        create: [
          { status: "PENDING_PAYMENT", title: "Order placed", detail: "We’ve received your order. Payment is arranged on delivery." },
          ...(autoConfirm ? [{ status: "PROCESSING", title: "Preparing your order", detail: ORDER_STATUS_META.PROCESSING?.description ?? null }] : []),
        ],
      },
    },
    select: { id: true, orderNumber: true },
  });
  const so = await tx.sellerOrder.create({
    data: {
      orderId: order.id,
      sellerId: seller.id,
      sellerName: seller.displayName,
      sellerType: seller.type,
      supportEmail: seller.supportEmail,
      commissionRate: seller.commissionRate,
      merchandiseSubtotal: 119900,
      shippingFee: 15000,
      total: 134900,
      status: "PENDING_PAYMENT",
      settlementStatus: "PENDING_CAPTURE",
    },
    select: { id: true },
  });
  await tx.orderItem.create({
    data: { orderId: order.id, sellerOrderId: so.id, sellerId: seller.id, productId: "p", name: "Item", unitPrice: 119900, quantity: 1, lineTotal: 119900 },
  });
  return { orderId: order.id, sellerOrderId: so.id, autoConfirm };
}

async function dbTests() {
  console.log("\n── db (rolled back) ──");
  try {
    await prisma.$transaction(async (tx) => {
      const t = String(Date.now()).slice(-7);

      // ── A. THIRD_PARTY + COD ──────────────────────────────────────────────
      const tp = await makeCheckoutOrder(tx, "THIRD_PARTY", t + "a");
      const oTp = await tx.order.findUnique({ where: { id: tp.orderId }, select: { status: true, paymentMethod: true, paymentStatus: true, events: { select: { status: true, title: true, detail: true }, orderBy: { createdAt: "asc" } }, payments: { select: { id: true } } } });
      ok("A · gate returned true for THIRD_PARTY COD", tp.autoConfirm === true);
      ok("A · parent Order.status = PROCESSING at creation", oTp?.status === "PROCESSING");
      ok("A · SellerOrder.status stays PENDING_PAYMENT", (await tx.sellerOrder.findUnique({ where: { id: tp.sellerOrderId }, select: { status: true } }))?.status === "PENDING_PAYMENT");
      ok("A · two OrderEvents: 'Order placed' then 'Preparing your order'", oTp?.events.length === 2 && oTp.events[0].status === "PENDING_PAYMENT" && oTp.events[1].status === "PROCESSING" && oTp.events[1].title === "Preparing your order" && oTp.events[1].detail === "Your order is being packed", JSON.stringify(oTp?.events));
      ok("A · seller now sees the 'Accept order' button", (() => {
        const moves = allowedSellerOrderMoves("PENDING_PAYMENT", { parentOrderStatus: oTp!.status });
        return moves.length === 1 && moves[0] === "PROCESSING" && sellerAdvanceLabels("PENDING_PAYMENT", moves[0]).button === "Accept order";
      })());

      // ── E. payment ───────────────────────────────────────────────────────
      ok("E · paymentMethod stays NONE, paymentStatus stays PENDING", oTp?.paymentMethod === "NONE" && oTp?.paymentStatus === "PENDING");
      ok("E · NO Payment row was created", oTp?.payments.length === 0);

      // ── B. FIRST_PARTY + COD — unchanged ─────────────────────────────────
      const fp = await makeCheckoutOrder(tx, "FIRST_PARTY", t + "b");
      const oFp = await tx.order.findUnique({ where: { id: fp.orderId }, select: { status: true, events: { select: { status: true } } } });
      ok("B · gate returned false for FIRST_PARTY", fp.autoConfirm === false);
      ok("B · parent Order.status stays PENDING_PAYMENT", oFp?.status === "PENDING_PAYMENT");
      ok("B · a single 'Order placed' OrderEvent (no PROCESSING event)", oFp?.events.length === 1 && oFp.events[0].status === "PENDING_PAYMENT");
      ok("B · seller panel stays hidden (no moves while parent PENDING_PAYMENT)", JSON.stringify(allowedSellerOrderMoves("PENDING_PAYMENT", { parentOrderStatus: oFp!.status })) === "[]");

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  // ── C. non-COD / paid — the gate is the only guard, already covered in pure ──
  console.log("\n── C (paid orders): gate returns false — see pure tests ──");
  ok("C · THIRD_PARTY paid order would NOT auto-confirm", shouldAutoConfirmAtCheckout({ sellerType: "THIRD_PARTY", paymentMethod: "CARD" }) === false);
}

async function main() {
  console.log("\nPHASE 9F-15B — auto-confirm THIRD_PARTY COD orders\n");
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
