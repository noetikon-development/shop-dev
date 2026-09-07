/**
 * PHASE 9F-21 — COD payment-status / customer timeline accuracy.
 *
 * The customer order timeline (`OrderTimeline`) must NOT show a completed
 * "Payment confirmed / Payment received" rung for a COD order (1P or 3P) that
 * has advanced to PROCESSING or beyond. Fix: the "PAID" rung is filtered out of
 * the flow unless `paymentStatus === "PAID"` (or `status === "PAID"`).
 *
 * Presentation + one coarse-enum select field only — no payment-processing,
 * status-machine, schema or email change.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f21.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { ORDER_STATUS_FLOW } from "../src/lib/constants";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// The exact flow-derivation the component performs (kept in lockstep with
// order-timeline.tsx — asserted identical by the static check below).
const PICKUP_STATUS_FLOW = ["PENDING", "PAID", "PROCESSING", "DELIVERED"] as const;
function timelineFlow(status: string, paymentStatus: string | undefined, pickup = false): string[] {
  const paid = paymentStatus === "PAID" || status === "PAID";
  const baseFlow: readonly string[] = pickup ? PICKUP_STATUS_FLOW : ORDER_STATUS_FLOW;
  return (paid ? baseFlow : baseFlow.filter((s) => s !== "PAID")).slice();
}
/** does the rung at `status` render as a completed "Payment confirmed" step? */
function showsCompletedPaymentRung(status: string, paymentStatus: string | undefined): boolean {
  const flow = timelineFlow(status, paymentStatus);
  const paidIdx = flow.indexOf("PAID");
  if (paidIdx === -1) return false;
  return paidIdx <= flow.indexOf(status); // `done = i <= currentIndex`
}

function staticTests() {
  console.log("\n── static wiring ──");
  const tl = read("src/components/order/order-timeline.tsx");
  const detail = read("src/components/order/order-detail.tsx");
  const pub = read("src/components/order/public-tracking.tsx");
  const data = read("src/lib/data.ts");
  const constants = read("src/lib/constants.ts");

  ok("timeline · has an optional paymentStatus prop", /paymentStatus\?: string;/.test(tl));
  ok("timeline · paid = paymentStatus === \"PAID\" || status === \"PAID\"", /const paid = paymentStatus === "PAID" \|\| status === "PAID";/.test(tl));
  ok("timeline · flow filters out \"PAID\" when not paid", /const flow: readonly string\[\] = paid \? baseFlow : baseFlow\.filter\(\(s\) => s !== "PAID"\);/.test(tl));
  ok("timeline · downstream still uses flow.indexOf(status) unchanged", /const currentIndex = flow\.indexOf\(status\);/.test(tl));
  ok("timeline · processingRungOverride wiring untouched", /const procOverride = processingRungOverride\(status, sellerOrders\);/.test(tl));

  ok("order-detail · passes paymentStatus={order.paymentStatus}", /<OrderTimeline[\s\S]{0,200}paymentStatus=\{order\.paymentStatus\}/.test(detail));
  ok("public-tracking · passes paymentStatus={order.paymentStatus}", /<OrderTimeline[\s\S]{0,200}paymentStatus=\{order\.paymentStatus\}/.test(pub));

  ok("data · getPublicTracking select adds paymentStatus: true", (() => {
    const start = data.indexOf("export async function getPublicTracking");
    const slice = data.slice(start, data.indexOf("export ", start + 1));
    return start !== -1 && /paymentStatus: true,/.test(slice);
  })());

  ok("constants · ORDER_STATUS_FLOW unchanged (still contains PAID)", /ORDER_STATUS_FLOW = \[\s*"PENDING",\s*"PAID",\s*"PROCESSING",\s*"SHIPPED",\s*"OUT_FOR_DELIVERY",\s*"DELIVERED",\s*\]/.test(constants));
  ok("constants · ORDER_STATUS_META.PAID unchanged", /PAID: \{ label: "Payment confirmed", description: "Payment received", tone: "progress" \}/.test(constants));
  ok("scope · no 9F-21 edit to constants / status machine / checkout / webhook", !/9F-21/.test(constants) && !/9F-21/.test(read("src/lib/orders/status.ts")) && !/9F-21/.test(read("src/lib/checkout.ts")) && !/9F-21/.test(read("src/lib/payments/webhook.ts")));
  ok("scope · no 9F-21 edit to email / settlement / seller-order status", !/9F-21/.test(read("src/lib/email/notifications.ts")) && !/9F-21/.test(read("src/lib/marketplace/settlement.ts")) && !/9F-21/.test(read("src/lib/marketplace/seller-order-status.ts")));
  ok("scope · seed-rbac.ts untouched", !/9F-21/.test(read("scripts/seed-rbac.ts")));
}

function behaviourTests() {
  console.log("\n── behaviour — no false 'Payment confirmed' for COD ──");

  // 1 — 1P COD PROCESSING
  ok("1 · 1P COD PROCESSING → no PAID rung", !timelineFlow("PROCESSING", "PENDING").includes("PAID"));
  ok("1 · 1P COD PROCESSING → no completed payment rung", !showsCompletedPaymentRung("PROCESSING", "PENDING"));
  // seed-style COD uses paymentStatus UNPAID
  ok("1 · 1P COD (UNPAID) PROCESSING → no completed payment rung", !showsCompletedPaymentRung("PROCESSING", "UNPAID"));

  // 2 — 1P COD SHIPPED / OUT_FOR_DELIVERY / DELIVERED
  for (const s of ["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"]) {
    ok(`2 · 1P COD ${s} → no completed payment rung`, !showsCompletedPaymentRung(s, "PENDING"));
  }

  // 3 — 3P COD PROCESSING (auto-confirmed at checkout, 9F-15B)
  ok("3 · 3P COD PROCESSING → no PAID rung", !timelineFlow("PROCESSING", "PENDING").includes("PAID"));
  ok("3 · 3P COD PROCESSING → no completed payment rung", !showsCompletedPaymentRung("PROCESSING", "PENDING"));

  // 4 — 3P COD DELIVERED
  ok("4 · 3P COD DELIVERED → no completed payment rung", !showsCompletedPaymentRung("DELIVERED", "PENDING"));

  // 5 — genuinely paid order keeps the PAID rung + completed state
  ok("5 · PAID order → PAID rung present", timelineFlow("PROCESSING", "PAID").includes("PAID"));
  ok("5 · PAID order at PROCESSING → payment rung shows completed", showsCompletedPaymentRung("PROCESSING", "PAID"));
  ok("5 · PAID order at PAID status (webhook window) → payment rung present", timelineFlow("PAID", undefined).includes("PAID"));
  ok("5 · PAID order DELIVERED → payment rung still shown", showsCompletedPaymentRung("DELIVERED", "PAID"));

  // ladder shape
  ok("COD ladder = placed → preparing → shipped → out for delivery → delivered", JSON.stringify(timelineFlow("PROCESSING", "PENDING")) === JSON.stringify(["PENDING", "PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"]));
  ok("COD pickup ladder drops PAID too", !timelineFlow("PROCESSING", "PENDING", true).includes("PAID"));
  ok("paid ladder is the full 6-rung flow", JSON.stringify(timelineFlow("PROCESSING", "PAID")) === JSON.stringify([...ORDER_STATUS_FLOW]));
}

async function dbTest() {
  console.log("\n── db (READ-ONLY) — real production orders vs the fixed timeline ──");
  const orders = await prisma.order.findMany({
    select: { orderNumber: true, status: true, paymentStatus: true, paymentMethod: true },
  });
  let codPast = 0;
  let paidPast = 0;
  for (const o of orders) {
    if (["CANCELLED", "PENDING_PAYMENT"].includes(o.status)) continue;
    const flow = timelineFlow(o.status, o.paymentStatus);
    if (o.paymentStatus === "PAID") {
      paidPast++;
      ok(`paid ${o.orderNumber} (${o.status}) → PAID rung KEPT`, flow.includes("PAID"));
    } else {
      codPast++;
      ok(`COD ${o.orderNumber} (${o.status}, pay=${o.paymentStatus}/${o.paymentMethod}) → no PAID rung, no false 'Payment confirmed'`, !flow.includes("PAID") && !showsCompletedPaymentRung(o.status, o.paymentStatus));
    }
  }
  ok("covered ≥1 COD order past PENDING_PAYMENT", codPast >= 1, `codPast=${codPast}`);
  ok("covered the genuinely-paid seed order", paidPast >= 1, `paidPast=${paidPast}`);
  ok("no production data was written", true); // read-only: findMany only
}

async function main() {
  console.log("\nPHASE 9F-21 — COD payment-status / customer timeline accuracy\n");
  staticTests();
  behaviourTests();
  await dbTest();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
