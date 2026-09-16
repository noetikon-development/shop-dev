/**
 * MULTI-SELLER PUBLIC /TRACK — presentation-only regression tests.
 *
 * Extends the public tracking experience so a multi-seller order shows each
 * SellerOrder's OWN status/items/shipment, mirroring the authenticated
 * order-detail page's already-shipped presentation (`order-detail.tsx`'s
 * `SellerItemGroup` / `groupOrderItemsBySeller`). Everything here is
 * presentation-support only:
 *   - `getPublicTracking` (src/lib/data.ts) additionally selects each
 *     SellerOrder's id/sellerType/status/sellerName/shipments (the SAME
 *     allow-list `getOrderByNumber` already uses for the authenticated page)
 *     and each item's `sellerOrderId`. No new business rule, no new query on
 *     any OTHER table, no financial field.
 *   - `PublicOrderTracking` (src/components/order/public-tracking.tsx) reuses
 *     `groupOrderItemsBySeller` — no second grouping implementation — and
 *     reuses `sellerOrderStatusLabel` / `sellerOrderStatusTone` from
 *     `seller-order-status.ts`, the same helpers the authenticated page uses.
 *   - Cancellation / returns / settlement / commission logic, the Order/
 *     SellerOrder status model, and the schema are all untouched.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-multiseller-public-tracking.ts
 */
import { readFileSync } from "node:fs";
import {
  groupOrderItemsBySeller,
  type CustomerOrderSellerOrder,
} from "@/lib/marketplace/customer-order-view";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

function mkSellerOrder(
  over: Partial<CustomerOrderSellerOrder> & { id: string; status: string },
): CustomerOrderSellerOrder {
  return {
    sellerName: `Seller ${over.id}`,
    sellerType: "THIRD_PARTY",
    shipments: [],
    ...over,
  };
}

type Item = { sellerOrderId: string | null; name: string; variantLabel: string | null; quantity: number };
function mkItem(over: Partial<Item> & { sellerOrderId: string | null; name: string }): Item {
  return { variantLabel: null, quantity: 1, ...over };
}

// ── per-scenario independence: each SellerOrder's status is read from ITSELF,
//    never inferred from or overridden by a sibling ────────────────────────
function scenarioTests() {
  console.log("\n── multi-seller status scenarios (A–E) — each SellerOrder independent ──");

  // A: Seller A DELIVERED, Seller B PROCESSING
  {
    const sellerOrders = [
      mkSellerOrder({ id: "A", status: "DELIVERED" }),
      mkSellerOrder({ id: "B", status: "PROCESSING" }),
    ];
    const items = [mkItem({ sellerOrderId: "A", name: "Product A" }), mkItem({ sellerOrderId: "B", name: "Product B" })];
    const { groups } = groupOrderItemsBySeller(items, sellerOrders);
    ok("A · Seller A shows DELIVERED regardless of Seller B", groups.find((g) => g.sellerOrder.id === "A")?.sellerOrder.status === "DELIVERED");
    ok("A · Seller B shows PROCESSING regardless of Seller A", groups.find((g) => g.sellerOrder.id === "B")?.sellerOrder.status === "PROCESSING");
  }

  // B: Seller A SHIPPED, Seller B DELIVERED
  {
    const sellerOrders = [mkSellerOrder({ id: "A", status: "SHIPPED" }), mkSellerOrder({ id: "B", status: "DELIVERED" })];
    const items = [mkItem({ sellerOrderId: "A", name: "Product A" }), mkItem({ sellerOrderId: "B", name: "Product B" })];
    const { groups } = groupOrderItemsBySeller(items, sellerOrders);
    ok("B · Seller A shows SHIPPED", groups.find((g) => g.sellerOrder.id === "A")?.sellerOrder.status === "SHIPPED");
    ok("B · Seller B shows DELIVERED", groups.find((g) => g.sellerOrder.id === "B")?.sellerOrder.status === "DELIVERED");
  }

  // C: Seller A CANCELLED, Seller B PROCESSING
  {
    const sellerOrders = [mkSellerOrder({ id: "A", status: "CANCELLED" }), mkSellerOrder({ id: "B", status: "PROCESSING" })];
    const items = [mkItem({ sellerOrderId: "A", name: "Product A" }), mkItem({ sellerOrderId: "B", name: "Product B" })];
    const { groups } = groupOrderItemsBySeller(items, sellerOrders);
    ok("C · Seller A shows CANCELLED (not hidden, not overridden)", groups.find((g) => g.sellerOrder.id === "A")?.sellerOrder.status === "CANCELLED");
    ok("C · Seller B remains PROCESSING, unaffected by A's cancellation", groups.find((g) => g.sellerOrder.id === "B")?.sellerOrder.status === "PROCESSING");
  }

  // D: Seller A DELIVERED, Seller B CANCELLED
  {
    const sellerOrders = [mkSellerOrder({ id: "A", status: "DELIVERED" }), mkSellerOrder({ id: "B", status: "CANCELLED" })];
    const items = [mkItem({ sellerOrderId: "A", name: "Product A" }), mkItem({ sellerOrderId: "B", name: "Product B" })];
    const { groups } = groupOrderItemsBySeller(items, sellerOrders);
    ok("D · Seller A shows DELIVERED", groups.find((g) => g.sellerOrder.id === "A")?.sellerOrder.status === "DELIVERED");
    ok("D · Seller B shows CANCELLED", groups.find((g) => g.sellerOrder.id === "B")?.sellerOrder.status === "CANCELLED");
  }

  // E: Seller A PROCESSING, Seller B PROCESSING
  {
    const sellerOrders = [mkSellerOrder({ id: "A", status: "PROCESSING" }), mkSellerOrder({ id: "B", status: "PROCESSING" })];
    const items = [mkItem({ sellerOrderId: "A", name: "Product A" }), mkItem({ sellerOrderId: "B", name: "Product B" })];
    const { groups } = groupOrderItemsBySeller(items, sellerOrders);
    ok("E · both sellers independently show PROCESSING", groups.every((g) => g.sellerOrder.status === "PROCESSING"));
    ok("E · two distinct groups form (not collapsed into one)", groups.length === 2);
  }

  // Mixed 1P + 3P, one item with no sellerOrderId (legacy/ungrouped) — must not
  // be dropped.
  {
    const sellerOrders = [
      mkSellerOrder({ id: "1p", status: "PROCESSING", sellerType: "FIRST_PARTY", sellerName: "Axiaro" }),
      mkSellerOrder({ id: "3p", status: "DELIVERED", sellerType: "THIRD_PARTY", sellerName: "Style Avenue" }),
    ];
    const items = [
      mkItem({ sellerOrderId: "1p", name: "Axiaro item" }),
      mkItem({ sellerOrderId: "3p", name: "Style Avenue item" }),
      mkItem({ sellerOrderId: null, name: "Legacy item" }),
    ];
    const { groups, ungrouped } = groupOrderItemsBySeller(items, sellerOrders);
    ok("mixed 1P+3P · both groups form regardless of sellerType", groups.length === 2);
    ok("mixed 1P+3P · the FIRST_PARTY group is unaffected by the THIRD_PARTY sibling's DELIVERED status",
      groups.find((g) => g.sellerOrder.id === "1p")?.sellerOrder.status === "PROCESSING");
    ok("legacy item with no sellerOrderId lands in `ungrouped`, never silently dropped", ungrouped.length === 1 && ungrouped[0].name === "Legacy item");
  }
}

function staticTests() {
  console.log("\n── static wiring / scope ──");
  const data = read("src/lib/data.ts");
  const publicTracking = read("src/components/order/public-tracking.tsx");
  const schema = read("prisma/schema.prisma");
  const cancellation = read("src/lib/orders/cancellation.ts");
  const returns = read("src/lib/returns.ts");
  const orderStatus = read("src/lib/orders/status.ts");
  const sellerOrderStatus = read("src/lib/marketplace/seller-order-status.ts");
  const seedRbac = read("scripts/seed-rbac.ts");

  // --- getPublicTracking selects the safe SellerOrder allow-list -----------
  const getPublicTrackingBody = (() => {
    const start = data.indexOf("export async function getPublicTracking(");
    if (start === -1) return "";
    const end = data.indexOf("\nexport ", start + 1);
    return data.slice(start, end === -1 ? undefined : end);
  })();
  ok("getPublicTracking is present", getPublicTrackingBody.length > 0);

  ok("getPublicTracking now selects sellerOrders { id, sellerType, status, sellerName, shipments {...} }",
    /sellerOrders: \{[\s\S]{0,50}select: \{[\s\S]{0,50}id: true,[\s\S]{0,200}sellerType: true,[\s\S]{0,200}status: true,[\s\S]{0,200}sellerName: true,[\s\S]{0,400}shipments: \{[\s\S]{0,300}carrier: true,[\s\S]{0,200}carrierName: true,[\s\S]{0,200}trackingNumber: true,[\s\S]{0,200}trackingUrl: true,[\s\S]{0,200}shippedAt: true,[\s\S]{0,200}deliveredAt: true/.test(getPublicTrackingBody));

  ok("getPublicTracking now selects each item's sellerOrderId (needed to group)",
    /items: \{[\s\S]{0,80}select: \{[\s\S]{0,40}sellerOrderId: true/.test(getPublicTrackingBody));

  // --- SECURITY: the new sellerOrders block must NEVER expose financials ---
  const sellerOrdersBlock = (() => {
    const start = getPublicTrackingBody.indexOf("sellerOrders:");
    if (start === -1) return "";
    // sellerOrders is the last top-level key before the closing of `select` —
    // take everything from there to the end of the function body.
    return getPublicTrackingBody.slice(start);
  })();
  ok("SECURITY · getPublicTracking's sellerOrders selection never exposes commission/settlement/financial fields",
    sellerOrdersBlock.length > 0 &&
      !/(commissionAmount|commissionRate|settlementId|settlementStatus|settlementClawbackAmount|grossReceivable|netAmount|clawbackAmount)/.test(sellerOrdersBlock));
  ok("SECURITY · getPublicTracking still never selects customer PII (phone/address/billing/note) or internal fulfilment note",
    !/(phone: true|addressId: true|billingAddress: true|fulfillmentNote: true|\bnote: true)/.test(getPublicTrackingBody));
  ok("SECURITY · the function's final return still omits the customer email before returning",
    /const \{ email: _omit, \.\.\.safe \} = order;/.test(getPublicTrackingBody));

  // --- PublicOrderTracking reuses the canonical grouping/label helpers -----
  ok("PublicOrderTracking imports groupOrderItemsBySeller — no second grouping implementation",
    /import \{\s*groupOrderItemsBySeller,/.test(publicTracking) &&
      /from "@\/lib\/marketplace\/customer-order-view"/.test(publicTracking));
  ok("PublicOrderTracking imports sellerOrderStatusLabel/Tone — reuses the same status vocabulary as order-detail.tsx",
    /import \{ sellerOrderStatusLabel, sellerOrderStatusTone \} from "@\/lib\/marketplace\/seller-order-status"/.test(publicTracking));

  ok("isMultiSeller threshold matches order-detail.tsx (sellerOrders.length > 1)",
    /const isMultiSeller = order\.sellerOrders\.length > 1;/.test(publicTracking));

  ok("single-seller/legacy branch keeps rendering the ORIGINAL aggregate Order.courier/trackingNumber fulfilment card, gated on !isMultiSeller",
    /!isMultiSeller && hasFulfilment && order\.status !== "CANCELLED"/.test(publicTracking));

  ok("SellerTrackingGroup reads the SellerOrder's OWN shipment (ship?.carrier / ship?.trackingNumber), never the aggregate order.courier/trackingNumber",
    (() => {
      const start = publicTracking.indexOf("function SellerTrackingGroup(");
      if (start === -1) return false;
      const end = publicTracking.indexOf("\nfunction ", start + 1);
      const body = publicTracking.slice(start, end === -1 ? undefined : end);
      return /ship\?\.carrier/.test(body) && /ship\?\.trackingNumber/.test(body) && !/order\.courier|order\.trackingNumber/.test(body);
    })());

  ok("seller-type label wording matches the authenticated order-detail page exactly: 'Sold by Axiaro' / 'Sold by ${sellerName}'",
    /sellerOrder\.sellerType === "FIRST_PARTY" \? "Sold by Axiaro" : `Sold by \$\{sellerOrder\.sellerName\}`/.test(publicTracking));

  ok("a not-yet-shipped seller says so plainly instead of an empty shipment card",
    /Not yet shipped/.test(publicTracking));
  ok("a cancelled seller's shipment card reflects the cancellation rather than showing stale/blank shipment data",
    /This part of the order was cancelled/.test(publicTracking));

  // --- required public /track authentication requirement is unchanged -----
  const trackPage = read("src/app/(shop)/track/page.tsx");
  ok("the /track lookup still requires BOTH order number and checkout email (unchanged, not weakened)",
    /orderNumber && email \? await getPublicTracking\(orderNumber, email\) : null/.test(trackPage));
  ok("getPublicTracking still refuses a mismatched email (auth requirement preserved)",
    /if \(!email \|\| order\.email\.trim\(\)\.toLowerCase\(\) !== email\.trim\(\)\.toLowerCase\(\)\) return null;/.test(getPublicTrackingBody));

  // --- no schema change, no touched cancellation/returns/status logic -----
  ok("no schema change (no new Prisma model/field introduced for this feature)",
    !/model\s+SellerOrderTracking|trackingSellerOrder|publicTrackingToken/.test(schema));
  ok("cancellation.ts (orders/cancellation.ts) is untouched by this presentation-only change",
    !/public-tracking|getPublicTracking|PublicOrderTracking/.test(cancellation));
  ok("returns.ts is untouched by this presentation-only change",
    !/public-tracking|getPublicTracking|PublicOrderTracking/.test(returns));
  ok("orders/status.ts (Order status model) is untouched — no PARTIALLY_SHIPPED/PARTIALLY_CANCELLED introduced",
    !/PARTIALLY_SHIPPED|PARTIALLY_CANCELLED/.test(orderStatus) && !/public-tracking|getPublicTracking/.test(orderStatus));
  ok("seller-order-status.ts (SellerOrder state machine) is untouched by this presentation-only change",
    !/public-tracking|getPublicTracking|PublicOrderTracking/.test(sellerOrderStatus));
  ok("PARTIALLY_SHIPPED/PARTIALLY_CANCELLED not introduced anywhere in the new/changed files",
    !/PARTIALLY_SHIPPED|PARTIALLY_CANCELLED/.test(data) && !/PARTIALLY_SHIPPED|PARTIALLY_CANCELLED/.test(publicTracking));
  ok("seed-rbac.ts untouched",
    !/public-tracking|getPublicTracking|PublicOrderTracking|SellerTrackingGroup/.test(seedRbac));
}

async function main() {
  console.log("\nMULTI-SELLER PUBLIC /TRACK — presentation-only regression tests\n");
  scenarioTests();
  staticTests();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
