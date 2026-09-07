/**
 * PHASE 9F-16B — customer-facing 3P pre-acceptance status copy.
 *
 * Presentation only: while a THIRD_PARTY SellerOrder is still PENDING_PAYMENT
 * (seller hasn't clicked "Accept order") the customer order-detail timeline
 * shows the PROCESSING rung as "Order received / Sent to {seller} …" instead of
 * "Preparing your order / Your order is being packed". Reverts once the seller
 * accepts. FIRST_PARTY unchanged. Badge, /track, emails, state machines untouched.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f16b.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { processingRungOverride } from "../src/lib/orders/status";
import { ORDER_STATUS_META } from "../src/lib/constants";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const SO = (over: Partial<{ sellerType: string; status: string; sellerName: string }> = {}) => ({
  sellerType: "THIRD_PARTY",
  status: "PENDING_PAYMENT",
  sellerName: "Style Avenue",
  ...over,
});

function pureTests() {
  console.log("\n── pure — processingRungOverride ──");

  // A — THIRD_PARTY + PROCESSING + SellerOrder PENDING_PAYMENT
  const a = processingRungOverride("PROCESSING", [SO()]);
  ok("A · returns an override object", a !== null);
  ok("A · title = 'Order received'", a?.title === "Order received");
  ok("A · description names the seller", (a?.description ?? "").includes("Style Avenue"));
  ok("A · description does NOT say 'Your order is being packed'", !/being packed/i.test(a?.description ?? ""));
  ok("A · description conveys awaiting confirmation", /confirm and prepare your order/.test(a?.description ?? ""));

  // B — THIRD_PARTY + SellerOrder past PENDING_PAYMENT → default copy
  ok("B · SellerOrder PROCESSING → null (default 'Preparing your order')", processingRungOverride("PROCESSING", [SO({ status: "PROCESSING" })]) === null);
  ok("B · SellerOrder READY_TO_SHIP → null", processingRungOverride("PROCESSING", [SO({ status: "READY_TO_SHIP" })]) === null);
  ok("B · SellerOrder SHIPPED → null", processingRungOverride("PROCESSING", [SO({ status: "SHIPPED" })]) === null);

  // C — FIRST_PARTY → never overridden
  ok("C · FIRST_PARTY + SellerOrder PENDING_PAYMENT → null", processingRungOverride("PROCESSING", [SO({ sellerType: "FIRST_PARTY" })]) === null);

  // only the PROCESSING order status
  ok("only fires at Order.status PROCESSING (PENDING_PAYMENT → null)", processingRungOverride("PENDING_PAYMENT", [SO()]) === null);
  ok("only fires at Order.status PROCESSING (SHIPPED → null)", processingRungOverride("SHIPPED", [SO()]) === null);
  ok("no seller orders → null", processingRungOverride("PROCESSING", []) === null);
  ok("mixed: any THIRD_PARTY still-pending SellerOrder triggers it", processingRungOverride("PROCESSING", [SO({ sellerType: "FIRST_PARTY", status: "PROCESSING" }), SO()]) !== null);

  console.log("\n── D — badge unchanged ──");
  ok("D · ORDER_STATUS_META.PROCESSING.label still 'Preparing'", ORDER_STATUS_META.PROCESSING.label === "Preparing");
  ok("D · ORDER_STATUS_META.PROCESSING.description still 'Your order is being packed'", ORDER_STATUS_META.PROCESSING.description === "Your order is being packed");
}

function staticTests() {
  console.log("\n── static wiring ──");
  const data = read("src/lib/data.ts");
  const timeline = read("src/components/order/order-timeline.tsx");
  const detail = read("src/components/order/order-detail.tsx");
  const publicTracking = read("src/components/order/public-tracking.tsx");
  const status = read("src/lib/orders/status.ts");

  // 1 — read-only SellerOrder select, no PII
  ok("data · getOrderByNumber selects ONLY sellerType/status/sellerName", /getOrderByNumber[\s\S]{0,600}sellerOrders: \{ select: \{ sellerType: true, status: true, sellerName: true \} \}/.test(data));
  ok("data · no customer PII / extra SellerOrder fields added to that select", !/getOrderByNumber[\s\S]{0,600}sellerOrders: \{ select: \{[^}]*\b(supportEmail|total|commissionAmount|merchandiseSubtotal|settlement)/.test(data));
  ok("data · getPublicTracking still does NOT select sellerOrders (E)", (() => {
    const start = data.indexOf("export async function getPublicTracking");
    const slice = data.slice(start, data.indexOf("export ", start + 1));
    return start !== -1 && !/sellerOrders/.test(slice);
  })());

  // 2/3 — timeline override
  ok("timeline · imports + uses processingRungOverride", /import \{ processingRungOverride \} from "@\/lib\/orders\/status";/.test(timeline) && /const procOverride = processingRungOverride\(status, sellerOrders\);/.test(timeline));
  ok("timeline · override applies ONLY to the PROCESSING rung", /const override = s === "PROCESSING" \? procOverride : null;/.test(timeline));
  ok("timeline · uses override.title / override.description, suppresses the packed detail", /\{override\?\.title \?\? ev\?\.title \?\? meta\.label\}/.test(timeline) && /\{override\s*\n?\s*\? override\.description/.test(timeline) && /\{!override && ev\?\.detail &&/.test(timeline));

  // detail wires it; /track does NOT
  ok("order-detail · passes order.sellerOrders to OrderTimeline", /<OrderTimeline[\s\S]{0,140}sellerOrders=\{order\.sellerOrders\}/.test(detail));
  ok("public-tracking · does NOT pass sellerOrders (E)", !/sellerOrders=/.test(publicTracking));

  // guardrails (F / 11)
  ok("orders/status.ts · override is pure — never writes SellerOrder.status / Order.status", /export function processingRungOverride/.test(status) && !/processingRungOverride[\s\S]{0,600}(prisma\.|\.update\(|tx\.)/.test(status));
  ok("F · no schema change", !/9F-16B/.test(read("prisma/schema.prisma")));
  ok("F · checkout auto-confirm logic untouched", !/9F-16B/.test(read("src/lib/checkout.ts")));
  ok("F · payment / PayMongo untouched", !/9F-16B/.test(read("src/lib/payments/config.ts")));
  ok("F · seller fulfilment workflow untouched", !/9F-16B/.test(read("src/lib/seller/order-actions.ts")) && !/9F-16B/.test(read("src/components/seller/order-fulfillment-panel.tsx")));
  ok("F · 9F-12b rollup untouched", !/9F-16B/.test(read("src/lib/marketplace/seller-order-repository.ts")));
  ok("F · settlement / returns / cancellation untouched", !/9F-16B/.test(read("src/lib/marketplace/settlement.ts")) && !/9F-16B/.test(read("src/lib/admin/returns-actions.ts")) && !/9F-16B/.test(read("src/lib/admin/order-actions.ts")));
  ok("F · emails untouched (no 9F-16B marker in the email subsystem)", !/9F-16B/.test(read("src/lib/email/notifications.ts")) && !/9F-16B/.test(read("src/lib/email/templates/seller-order-notifications.ts")));
  ok("scope · seed-rbac.ts untouched", !/9F-16B/.test(read("scripts/seed-rbac.ts")));
}

async function dbTest() {
  console.log("\n── db (read-only) — production test order AX-260907-100389 ──");
  const o = await prisma.order.findFirst({
    where: { orderNumber: "AX-260907-100389" },
    select: {
      status: true,
      sellerOrders: { select: { sellerType: true, status: true, sellerName: true } },
    },
  });
  ok("order resolves", o !== null);
  ok("parent Order.status = PROCESSING", o?.status === "PROCESSING");
  ok("SellerOrder = Style Avenue / THIRD_PARTY / PENDING_PAYMENT", o?.sellerOrders[0]?.sellerType === "THIRD_PARTY" && o?.sellerOrders[0]?.status === "PENDING_PAYMENT" && o?.sellerOrders[0]?.sellerName === "Style Avenue", JSON.stringify(o?.sellerOrders));

  const ov = processingRungOverride(o!.status, o!.sellerOrders);
  ok("→ timeline shows 'Order received'", ov?.title === "Order received");
  ok("→ description = 'Sent to Style Avenue — …'", (ov?.description ?? "").startsWith("Sent to Style Avenue"));
  ok("→ NOT 'Your order is being packed'", !/being packed/i.test(ov?.description ?? ""));
}

async function main() {
  console.log("\nPHASE 9F-16B — customer 3P pre-acceptance status copy\n");
  pureTests();
  staticTests();
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
