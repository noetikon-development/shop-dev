/**
 * MULTI-SELLER CUSTOMER ORDER UI — presentation-only regression tests.
 *
 * Covers the customer order-detail presentation fix: a multi-seller order
 * (Seller A DELIVERED, Seller B PROCESSING/SHIPPED) was previously shown as a
 * single flat item list under one aggregate `Order.status` badge, with a
 * "Cancel order" button gated ONLY on `isCancellable(order.status)` — so it
 * stayed visible even when the server's own per-SellerOrder safety gate would
 * refuse the cancellation outright.
 *
 * The fix adds ONLY presentation-support logic, all pure and all composing
 * ALREADY-canonical signals (never a new business rule):
 *   - `allSellerOrdersCancellable` reuses `sellerCanCancelSellerOrder` — the
 *     exact same predicate `orders/cancellation.ts`'s safety gate uses.
 *   - `groupOrderItemsBySeller` / `hasUndeliveredSellerLines` only describe
 *     already-fetched `SellerOrder.status` data; `returnEligibility()` itself
 *     is untouched.
 * `getOrderByNumber` was extended (read-only) to also select each
 * SellerOrder's `id` and its own `shipments` fields, so the customer view can
 * show per-seller status/tracking instead of only the aggregate Order fields.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-multiseller-customer-order-ui.ts
 */
import { readFileSync } from "node:fs";
import {
  allSellerOrdersCancellable,
  hasUndeliveredSellerLines,
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

function mkSellerOrder(over: Partial<CustomerOrderSellerOrder> & { id: string; status: string }): CustomerOrderSellerOrder {
  return {
    sellerName: `Seller ${over.id}`,
    sellerType: "THIRD_PARTY",
    shipments: [],
    ...over,
  };
}

// ── E · Cancel button — all-or-nothing, reusing the canonical server gate ──
function cancelButtonTests() {
  console.log("\n── E · cancel-button eligibility (reuses sellerCanCancelSellerOrder) ──");

  ok("E1 · all SellerOrders cancellable (PENDING_PAYMENT + PROCESSING) → true (button visible)",
    allSellerOrdersCancellable([{ status: "PENDING_PAYMENT" }, { status: "PROCESSING" }]));

  ok("E2 · one SellerOrder SHIPPED → false (button hidden)",
    allSellerOrdersCancellable([{ status: "PROCESSING" }, { status: "SHIPPED" }]) === false);

  ok("E3 · one SellerOrder DELIVERED → false (button hidden — the core scenario this fix closes)",
    allSellerOrdersCancellable([{ status: "PROCESSING" }, { status: "DELIVERED" }]) === false);

  ok("E4 · single-seller cancellable order (unchanged) → true",
    allSellerOrdersCancellable([{ status: "PROCESSING" }]));

  ok("E5 · single-seller SHIPPED order → false (matches existing single-seller behavior — Order.status would already exclude it via isCancellable too)",
    allSellerOrdersCancellable([{ status: "SHIPPED" }]) === false);

  ok("E6 · legacy order with no SellerOrders → true (vacuous — caller still gates on isCancellable(order.status) first, unchanged)",
    allSellerOrdersCancellable([]));
}

// ── F · Return explanatory note ──────────────────────────────────────────
function returnNoteTests() {
  console.log("\n── F · return explanation note ──");

  ok("F1 · multi-seller, one undelivered → note shown",
    hasUndeliveredSellerLines([{ status: "DELIVERED" }, { status: "PROCESSING" }]));

  ok("F2 · multi-seller, ALL delivered → note NOT shown",
    hasUndeliveredSellerLines([{ status: "DELIVERED" }, { status: "DELIVERED" }]) === false);

  ok("F3 · single-seller (even if somehow not delivered) → note NOT shown (not needed there)",
    hasUndeliveredSellerLines([{ status: "PROCESSING" }]) === false);

  ok("F4 · legacy zero-SellerOrder order → note NOT shown",
    hasUndeliveredSellerLines([]) === false);
}

// ── B/C/D/G · grouping, per-seller status, shipment, mixed 1P+3P ─────────
function groupingTests() {
  console.log("\n── B/C/D/G · groupOrderItemsBySeller ──");

  type Item = { id: string; sellerOrderId: string | null };

  // B — basic multi-seller partition
  {
    const sellers: CustomerOrderSellerOrder[] = [
      mkSellerOrder({ id: "so-A", status: "DELIVERED" }),
      mkSellerOrder({ id: "so-B", status: "PROCESSING" }),
    ];
    const items: Item[] = [
      { id: "item-1", sellerOrderId: "so-A" },
      { id: "item-2", sellerOrderId: "so-A" },
      { id: "item-3", sellerOrderId: "so-B" },
    ];
    const { groups, ungrouped } = groupOrderItemsBySeller(items, sellers);
    ok("B1 · two groups formed, one per SellerOrder", groups.length === 2);
    ok("B2 · Seller A's group has exactly its 2 items", groups.find((g) => g.sellerOrder.id === "so-A")?.items.length === 2);
    ok("B3 · Seller B's group has exactly its 1 item", groups.find((g) => g.sellerOrder.id === "so-B")?.items.length === 1);
    ok("B4 · no ungrouped items when every item resolves to a real SellerOrder", ungrouped.length === 0);

    // C — each group carries its OWN SellerOrder status, not the sibling's
    const gA = groups.find((g) => g.sellerOrder.id === "so-A")!;
    const gB = groups.find((g) => g.sellerOrder.id === "so-B")!;
    ok("C1 · Seller A's group reports DELIVERED", gA.sellerOrder.status === "DELIVERED");
    ok("C2 · Seller B's group reports PROCESSING (not contaminated by Seller A's status)", gB.sellerOrder.status === "PROCESSING");
  }

  // D — shipment fields survive grouping untouched
  {
    const shipDate = new Date("2026-01-15T00:00:00Z");
    const sellers: CustomerOrderSellerOrder[] = [
      mkSellerOrder({
        id: "so-ship",
        status: "DELIVERED",
        shipments: [{ carrier: "JT_EXPRESS", carrierName: null, trackingNumber: "JT12345", trackingUrl: null, shippedAt: null, deliveredAt: shipDate }],
      }),
    ];
    const items: Item[] = [{ id: "item-1", sellerOrderId: "so-ship" }];
    const { groups } = groupOrderItemsBySeller(items, sellers);
    const ship = groups[0]?.sellerOrder.shipments[0];
    ok("D1 · the seller's own shipment carrier/tracking/deliveredAt pass through unchanged",
      ship?.carrier === "JT_EXPRESS" && ship?.trackingNumber === "JT12345" && ship?.deliveredAt?.getTime() === shipDate.getTime());
  }

  // A (partial) — a single-seller "group" still partitions correctly if ever
  // called (OrderDetail itself never calls this for sellerOrders.length <= 1,
  // verified separately in staticTests — this just proves the function isn't
  // the reason single-seller would misbehave if it were).
  {
    const sellers: CustomerOrderSellerOrder[] = [mkSellerOrder({ id: "so-solo", status: "PROCESSING" })];
    const items: Item[] = [{ id: "item-1", sellerOrderId: "so-solo" }, { id: "item-2", sellerOrderId: "so-solo" }];
    const { groups, ungrouped } = groupOrderItemsBySeller(items, sellers);
    ok("A1 · a single seller's items all land in its one group", groups.length === 1 && groups[0].items.length === 2 && ungrouped.length === 0);
  }

  // legacy / unmatched items → ungrouped, never silently dropped
  {
    const sellers: CustomerOrderSellerOrder[] = [mkSellerOrder({ id: "so-A", status: "DELIVERED" })];
    const items: Item[] = [{ id: "item-1", sellerOrderId: "so-A" }, { id: "legacy-item", sellerOrderId: null }, { id: "orphan-item", sellerOrderId: "so-nonexistent" }];
    const { groups, ungrouped } = groupOrderItemsBySeller(items, sellers);
    ok("legacy · a null-sellerOrderId item is placed in `ungrouped`, not dropped", ungrouped.some((it) => it.id === "legacy-item"));
    ok("legacy · an item whose sellerOrderId matches no known SellerOrder is also `ungrouped`, not dropped", ungrouped.some((it) => it.id === "orphan-item"));
    ok("legacy · Seller A's real item is still grouped normally", groups[0]?.items.some((it) => it.id === "item-1"));
  }

  // G — mixed 1P + 3P and multi-3P: grouping is seller-type-agnostic
  {
    const mixedSellers: CustomerOrderSellerOrder[] = [
      mkSellerOrder({ id: "so-1p", status: "PROCESSING", sellerType: "FIRST_PARTY", sellerName: "Axiaro" }),
      mkSellerOrder({ id: "so-3p", status: "DELIVERED", sellerType: "THIRD_PARTY", sellerName: "Style Avenue" }),
    ];
    const items: Item[] = [{ id: "item-1p", sellerOrderId: "so-1p" }, { id: "item-3p", sellerOrderId: "so-3p" }];
    const { groups } = groupOrderItemsBySeller(items, mixedSellers);
    ok("G1 · mixed 1P+3P — both groups form correctly regardless of sellerType", groups.length === 2);
    ok("G2 · the FIRST_PARTY group is unaffected by the THIRD_PARTY sibling's DELIVERED status", groups.find((g) => g.sellerOrder.id === "so-1p")?.sellerOrder.status === "PROCESSING");

    const multi3p: CustomerOrderSellerOrder[] = [
      mkSellerOrder({ id: "so-3p-a", status: "SHIPPED", sellerType: "THIRD_PARTY" }),
      mkSellerOrder({ id: "so-3p-b", status: "DELIVERED", sellerType: "THIRD_PARTY" }),
    ];
    const items3p: Item[] = [{ id: "i1", sellerOrderId: "so-3p-a" }, { id: "i2", sellerOrderId: "so-3p-b" }];
    const { groups: groups3p } = groupOrderItemsBySeller(items3p, multi3p);
    ok("G3 · multi-3P — both groups form correctly", groups3p.length === 2);
  }
}

// ── static wiring / scope ─────────────────────────────────────────────────
function staticTests() {
  console.log("\n── static wiring / scope ──");
  const customerOrderView = read("src/lib/marketplace/customer-order-view.ts");
  const orderDetail = read("src/components/order/order-detail.tsx");
  const accountOrderPage = read("src/app/(shop)/account/orders/[orderNumber]/page.tsx");
  const returnPage = read("src/app/(shop)/account/orders/[orderNumber]/return/page.tsx");
  const data = read("src/lib/data.ts");
  const returns = read("src/lib/returns.ts");
  const cancellation = read("src/lib/orders/cancellation.ts");
  const adminOrderActions = read("src/lib/admin/order-actions.ts");
  const accountOrderActions = read("src/lib/account/order-actions.ts");
  const schema = read("prisma/schema.prisma");

  ok("A2 · OrderDetail only groups when sellerOrders.length > 1 — single-seller keeps the original flat list branch",
    /const isMultiSeller = order\.sellerOrders\.length > 1;/.test(orderDetail) &&
      /: \{ groups: \[\], ungrouped: order\.items \}/.test(orderDetail));
  ok("A3 · the single-seller branch still renders the ORIGINAL 'Items' heading + ItemRow list",
    /<h2 className="text-subtitle">Items<\/h2>[\s\S]{0,150}order\.items\.map/.test(orderDetail));

  ok("getOrderByNumber now selects SellerOrder.id + shipments (carrier/trackingNumber/shippedAt/deliveredAt)",
    /sellerOrders: \{[\s\S]{0,50}select: \{[\s\S]{0,50}id: true,[\s\S]{0,400}shipments: \{[\s\S]{0,200}carrier: true, carrierName: true, trackingNumber: true, trackingUrl: true, shippedAt: true, deliveredAt: true/.test(data));
  ok("getOrderByNumber does NOT expose commission/settlement or other seller-sensitive fields",
    !/sellerOrders:[\s\S]{0,600}(commissionAmount|commissionRate|settlementId|settlementStatus)/.test(data));

  ok("D2 · SellerItemGroup reads the SellerOrder's OWN shipment fields, never the aggregate order.courier/trackingNumber",
    (() => {
      const start = orderDetail.indexOf("function SellerItemGroup(");
      if (start === -1) return false;
      const end = orderDetail.indexOf("\nfunction ", start + 1);
      const body = orderDetail.slice(start, end === -1 ? undefined : end);
      return /ship\?\.carrier/.test(body) && /ship\?\.trackingNumber/.test(body) && !/order\.courier|order\.trackingNumber/.test(body);
    })());
  ok("the aggregate Delivery card is now gated to single-seller/legacy only",
    /!isMultiSeller && showFulfilment/.test(orderDetail));

  ok("E7 · the account order page combines isCancellable(order.status) WITH allSellerOrdersCancellable(order.sellerOrders) — both required, no invented rule",
    /isCancellable\(order\.status\) && allSellerOrdersCancellable\(order\.sellerOrders\)/.test(accountOrderPage) &&
      /import \{ allSellerOrdersCancellable, hasUndeliveredSellerLines \} from "@\/lib\/marketplace\/customer-order-view"/.test(accountOrderPage));
  ok("customer-order-view.ts reuses sellerCanCancelSellerOrder — the EXACT canonical predicate, not a new rule",
    /import \{ sellerCanCancelSellerOrder \} from "@\/lib\/marketplace\/seller-order-status"/.test(customerOrderView) &&
      /sellerOrders\.every\(\(so\) => sellerCanCancelSellerOrder\(so\.status\)\)/.test(customerOrderView));

  ok("F5 · the order-detail return callout renders the partial-eligibility note",
    /hasUndeliveredSellerLines\(sellerOrders\)/.test(accountOrderPage));
  ok("F6 · the dedicated return page also renders the partial-eligibility note (reusing the same signal, no new eligibility logic)",
    /hasUndeliveredSellerLines\(/.test(returnPage) && /getOrderByNumber\(orderNumber\)/.test(returnPage));

  // Scope — nothing this task said not to touch was touched.
  ok("returnEligibility() itself is UNTOUCHED — no reference to the new presentation helpers",
    !/customer-order-view/.test(returns));
  ok("cancellation.ts server-side safety gate is UNTOUCHED — this fix lives ONLY in the presentation layer",
    !/customer-order-view/.test(cancellation));
  ok("admin/order-actions.ts (server-side cancellation) is UNTOUCHED by this UI fix",
    !/customer-order-view/.test(adminOrderActions));
  ok("account/order-actions.ts (server-side cancellation) is UNTOUCHED by this UI fix",
    !/customer-order-view/.test(accountOrderActions));
  ok("no schema change", !/customer-order-view|CustomerOrderSellerOrder/.test(schema));
  ok("no seller-type-based branching invented in the new presentation helpers (mixed 1P+3P works because grouping is seller-type-agnostic)",
    !/FIRST_PARTY|THIRD_PARTY/.test(customerOrderView));
  ok("seed-rbac.ts untouched", !/customer-order-view|allSellerOrdersCancellable|groupOrderItemsBySeller/.test(read("scripts/seed-rbac.ts")));
}

async function main() {
  console.log("\nMULTI-SELLER CUSTOMER ORDER UI — presentation-only regression tests\n");
  cancelButtonTests();
  returnNoteTests();
  groupingTests();
  staticTests();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
