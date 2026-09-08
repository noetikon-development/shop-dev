/**
 * PHASE 9F-28B — COD payment terminology F1 / F2.
 *
 * F1  `sendOrderConfirmation` (`notifications.ts`) now derives pay-on-delivery
 *     from the PAYMENT fields via `isPayOnDeliveryOrder(order)`, not from
 *     `Order.status === "PENDING_PAYMENT"` — so a 3P COD order that was
 *     auto-confirmed to PROCESSING (9F-15B) still gets the
 *     "Payment is arranged on delivery." line + the "pay on delivery" preview.
 *     A PAID CARD / GCASH order is unchanged (no pay-on-delivery wording).
 *
 * F2  admin order detail shows COD (`paymentMethod` "NONE") as
 *     "Cash on delivery", not "Not set".
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f28b.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { isPayOnDeliveryOrder } from "@/lib/email/notifications";
import { renderOrderConfirmation } from "@/lib/email/templates/order-confirmation";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const PAY_ON_DELIVERY_LINE = "Payment is arranged on delivery.";
const RECEIVED_ONLY_LINE = "Your order has been received.";

function confirmationBody(payOnDelivery: boolean) {
  const msg = renderOrderConfirmation({
    brand: "Axiaro",
    siteUrl: "https://axiaro.shop",
    orderUrl: "https://axiaro.shop/track",
    orderNumber: "AX-TEST-0001",
    placedAt: new Date("2026-09-09T00:00:00Z"),
    customerName: "Sam",
    items: [{ name: "Thing", variantLabel: null, quantity: 1, unitPrice: 1000, lineTotal: 1000 }],
    subtotal: 1000,
    discountTotal: 0,
    couponCode: null,
    shippingMethodName: "Standard",
    shippingFee: 0,
    grandTotal: 1000,
    shippingAddress: { firstName: "Sam", line1: "1 St", city: "Manila", country: "PH", phone: "0900" },
    payOnDelivery,
  });
  return `${msg.subject}\n${msg.html}\n${msg.text}`;
}

// ── static wiring ────────────────────────────────────────────────────────
function staticTests() {
  console.log("\n── static wiring ──");
  const notif = read("src/lib/email/notifications.ts");
  const view = read("src/components/admin/orders/order-detail-view.tsx");
  const timeline = read("src/components/order/order-timeline.tsx");
  const data = read("src/lib/data.ts");

  // F1
  ok("F1 · notifications exports isPayOnDeliveryOrder(order) reading only payment fields",
    /export function isPayOnDeliveryOrder\(order: \{\s*\n\s*paymentMethod: string \| null;\s*\n\s*paymentStatus: string;\s*\n\s*\}\)/.test(notif) &&
    /const codMethod = order\.paymentMethod === "NONE" \|\| order\.paymentMethod === "COD";\s*\n\s*return codMethod && order\.paymentStatus !== "PAID";/.test(notif));
  ok("F1 · isPayOnDeliveryOrder never reads Order.status",
    (() => {
      const m = notif.match(/export function isPayOnDeliveryOrder[\s\S]*?\): boolean \{[\s\S]*?\n\}/);
      return !!m && !/\border\.status\b/.test(m[0]);
    })());
  ok("F1 · sendOrderConfirmation uses isPayOnDeliveryOrder(order) for payOnDelivery",
    /payOnDelivery: isPayOnDeliveryOrder\(order\),/.test(notif));
  ok("F1 · sendOrderConfirmation no longer keys payOnDelivery on order.status === PENDING_PAYMENT",
    !/payOnDelivery: order\.status === "PENDING_PAYMENT"/.test(notif));

  // F2
  ok("F2 · admin order detail no longer renders '\"Not set\"' anywhere",
    !/"Not set"/.test(view));
  ok("F2 · payment-method Field falls back to codLabel, not a blank",
    /order\.paymentMethod && order\.paymentMethod !== "NONE"\s*\n\s*\? \(paymentMethod\?\.label \?\? order\.paymentMethod\)\s*\n\s*: codLabel\}/.test(view));
  ok("F2 · admin order detail derives the COD label from PAYMENT_METHODS ('Cash on delivery')",
    /PAYMENT_METHODS\.find\(\(p\) => p\.id === "COD"\)\?\.label \?\? "Cash on delivery"/.test(view));

  // F5 — no false paid claim introduced
  ok("F5 · order-confirmation template still never claims a payment occurred",
    !/Payment confirmed|Payment received|has been paid|payment was received/i.test(read("src/lib/email/templates/order-confirmation.ts")));
  ok("F5 · sendOrderConfirmation region introduces no 'paid' claim",
    (() => {
      const start = notif.indexOf("export async function sendOrderConfirmation");
      const region = notif.slice(start, start + 2500);
      return start >= 0 && !/Payment confirmed|Payment received|marked paid/i.test(region);
    })());

  // 9F-21 regression — timeline / tracking untouched
  ok("9F-21 · order-timeline still drops the PAID rung for a non-paid order (unchanged)",
    /const paid = paymentStatus === "PAID" \|\| status === "PAID";/.test(timeline) &&
    /flow: readonly string\[\] = paid \? baseFlow : baseFlow\.filter\(\(s\) => s !== "PAID"\);/.test(timeline) &&
    !/9F-28B/.test(timeline));
  ok("9F-21 · getPublicTracking still selects paymentStatus for the timeline",
    /paymentStatus: true,/.test(data) && !/9F-28B/.test(data));

  // scope
  ok("scope · checkout / webhook / order-status machine / seed-rbac untouched",
    !/9F-28B/.test(read("src/lib/checkout.ts")) && !/9F-28B/.test(read("src/lib/payments/webhook.ts")) &&
    !/9F-28B/.test(read("src/lib/orders/status.ts")) && !/9F-28B/.test(read("scripts/seed-rbac.ts")));
  ok("scope · /track view + customer order-detail component untouched",
    !/9F-28B/.test(read("src/components/order/public-tracking.tsx")) &&
    !/9F-28B/.test(read("src/components/order/order-detail.tsx")));
  ok("scope · no schema change", !/9F-28B/.test(read("prisma/schema.prisma")));
}

// ── unit: isPayOnDeliveryOrder ───────────────────────────────────────────
function unitTests() {
  console.log("\n── isPayOnDeliveryOrder ──");
  ok("1P COD (NONE / PENDING) → pay on delivery",
    isPayOnDeliveryOrder({ paymentMethod: "NONE", paymentStatus: "PENDING" }) === true);
  ok("COD method (COD / PENDING) → pay on delivery",
    isPayOnDeliveryOrder({ paymentMethod: "COD", paymentStatus: "PENDING" }) === true);
  ok("3P COD is decided by payment fields only (status is not an input) → still pay on delivery",
    isPayOnDeliveryOrder({ paymentMethod: "NONE", paymentStatus: "PENDING" }) === true);
  ok("PAID card → NOT pay on delivery",
    isPayOnDeliveryOrder({ paymentMethod: "CARD", paymentStatus: "PAID" }) === false);
  ok("PAID GCash → NOT pay on delivery",
    isPayOnDeliveryOrder({ paymentMethod: "GCASH", paymentStatus: "PAID" }) === false);
  ok("unpaid card (CARD / PENDING) → NOT pay on delivery (neither paid nor COD)",
    isPayOnDeliveryOrder({ paymentMethod: "CARD", paymentStatus: "PENDING" }) === false);
  ok("defensive: COD marked PAID → NOT pay on delivery (don't ask them to pay again)",
    isPayOnDeliveryOrder({ paymentMethod: "NONE", paymentStatus: "PAID" }) === false);
}

// ── composition: the exact wording sendOrderConfirmation would produce ────
function compositionTests() {
  console.log("\n── rendered confirmation body ──");
  // COD — whether the order sits at PENDING_PAYMENT (1P) or PROCESSING (3P), the
  // payment fields are identical, so isPayOnDeliveryOrder returns true either way.
  const codPod = isPayOnDeliveryOrder({ paymentMethod: "NONE", paymentStatus: "PENDING" });
  const codBody = confirmationBody(codPod);
  ok("F1 · COD confirmation body includes 'Payment is arranged on delivery.'", codBody.includes(PAY_ON_DELIVERY_LINE));
  ok("F1 · COD confirmation preview text includes 'pay on delivery'", /pay on delivery/.test(codBody));

  // PAID card — unchanged: no pay-on-delivery wording, no false "paid" claim.
  const cardPod = isPayOnDeliveryOrder({ paymentMethod: "CARD", paymentStatus: "PAID" });
  const cardBody = confirmationBody(cardPod);
  ok("CARD · PAID confirmation body does NOT include the pay-on-delivery line",
    !cardBody.includes(PAY_ON_DELIVERY_LINE) && cardBody.includes(RECEIVED_ONLY_LINE));
  ok("CARD · PAID confirmation preview text has no 'pay on delivery'", !/pay on delivery/.test(cardBody));
  ok("CARD · PAID confirmation introduces no 'Payment confirmed' wording",
    !/Payment confirmed|Payment received/i.test(cardBody));
}

// ── production read-only ─────────────────────────────────────────────────
async function prodTests() {
  console.log("\n── production (READ-ONLY) ──");
  const orders = await prisma.order.findMany({
    select: { orderNumber: true, status: true, paymentMethod: true, paymentStatus: true },
    orderBy: { placedAt: "asc" },
  });
  let codPod = 0;
  let paidNotPod = 0;
  for (const o of orders) {
    const pod = isPayOnDeliveryOrder(o);
    if (pod) codPod++;
    if (o.paymentStatus === "PAID" && !pod) paidNotPod++;
    console.log(`  INFO  ${o.orderNumber}  status=${o.status}  method=${o.paymentMethod}  payStatus=${o.paymentStatus}  → payOnDelivery=${pod}`);
  }
  ok("prod · every non-PAID COD order (incl. 3P PROCESSING) now classifies as pay-on-delivery",
    orders.filter((o) => (o.paymentMethod === "NONE" || o.paymentMethod === "COD") && o.paymentStatus !== "PAID").every((o) => isPayOnDeliveryOrder(o)));
  ok("prod · every PAID order classifies as NOT pay-on-delivery",
    orders.filter((o) => o.paymentStatus === "PAID").every((o) => !isPayOnDeliveryOrder(o)),
    `paidNotPod=${paidNotPod}`);
  console.log(`  INFO  ${orders.length} orders — ${codPod} pay-on-delivery, ${orders.length - codPod} not`);
}

async function main() {
  console.log("\nPHASE 9F-28B — COD payment terminology F1 / F2\n");
  staticTests();
  unitTests();
  compositionTests();
  await prodTests();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
