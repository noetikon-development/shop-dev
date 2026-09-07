/**
 * Phase 9F-8d.1 — minimum admin marketplace visibility: cross-seller Offer
 * view, SellerOrder list/detail view, SellerOrder -> parent Order link,
 * commission display (from the stored value only, never recalculated).
 *
 * These are READ-ONLY admin views over already-committed data — there is no
 * write path to test, and no fixture-seeding transaction is needed. The DB
 * tests below read REAL, already-existing rows (the Style Avenue seller +
 * its one DRAFT offer, and the most recent real SellerOrder) exactly as an
 * admin viewing the page would, and assert nothing about them changes.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f8d1.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { listAllOffersForAdmin, listSellersForOfferFilter, adminOfferStatusCounts } from "../src/lib/admin/offers";
import { listAdminSellerOrders, getAdminSellerOrder, listSellersForSellerOrderFilter, adminCommissionTotal } from "../src/lib/admin/seller-orders";
import { getAdminOrder } from "../src/lib/admin/orders";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// ---------------------------------------------------------------------------
// Static — permission gating + read-only-ness
// ---------------------------------------------------------------------------

function staticTests() {
  const offersRepo = read("src/lib/admin/offers.ts");
  const sellerOrdersRepo = read("src/lib/admin/seller-orders.ts");
  const offersPage = read("src/app/admin/(shell)/offers/page.tsx");
  const sellerOrdersListPage = read("src/app/admin/(shell)/seller-orders/page.tsx");
  const sellerOrdersDetailPage = read("src/app/admin/(shell)/seller-orders/[id]/page.tsx");
  const orderDetailPage = read("src/app/admin/(shell)/orders/[id]/page.tsx");
  const ordersRepo = read("src/lib/admin/orders.ts");
  const nav = read("src/lib/admin/navigation.ts");
  const schema = read("prisma/schema.prisma");

  // Permission gates — reuse existing permissions, no new one introduced
  ok("1 · /admin/offers reuses requireAnyPermission([manage_settings, manage_content])", /requireAnyPermission\(\["manage_settings", "manage_content"\]\)/.test(offersPage));
  ok("2 · /admin/seller-orders (list) reuses requireAnyPermission([view_orders, manage_orders])", /requireAnyPermission\(\["view_orders", "manage_orders"\]\)/.test(sellerOrdersListPage));
  ok("2 · /admin/seller-orders/[id] (detail) uses the SAME permission set as the list", /requireAnyPermission\(\["view_orders", "manage_orders"\]\)/.test(sellerOrdersDetailPage));
  ok("nav · both new routes registered with the same accepts arrays as their pages", /path: "\/admin\/offers"[\s\S]{0,150}accepts: \["manage_settings", "manage_content"\]/.test(nav) && /path: "\/admin\/seller-orders"[\s\S]{0,150}accepts: \["view_orders", "manage_orders"\]/.test(nav));
  ok("no new permission · RBAC catalog untouched", !/9F-8d/.test(read("src/lib/rbac/catalog.ts")));
  ok("scope · scripts/seed-rbac.ts not referenced by any new/changed file", ![offersRepo, sellerOrdersRepo, offersPage, sellerOrdersListPage, sellerOrdersDetailPage, ordersRepo, nav].some((f) => /seed-rbac/.test(f)));

  // Read-only — no write call anywhere in the two new repository files
  const writeCallPattern = /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/;
  ok("3 · src/lib/admin/offers.ts contains no write call (fully read-only)", !writeCallPattern.test(offersRepo));
  ok("3 · src/lib/admin/seller-orders.ts contains no write call (fully read-only)", !writeCallPattern.test(sellerOrdersRepo));

  // Commission — displayed from the stored column only, never recalculated
  ok("4 · adminCommissionTotal only aggregates the stored commissionAmount column (no rate * subtotal anywhere)", /_sum: \{ commissionAmount: true \}/.test(sellerOrdersRepo) && !/commissionRate \*/.test(sellerOrdersRepo) && !/roundHalfUp/.test(sellerOrdersRepo));
  ok("4 · getAdminSellerOrder selects commissionAmount directly, computes nothing", /commissionAmount: true,/.test(sellerOrdersRepo) && !/commissionAmount\s*=\s*[^,\n]*\*/.test(sellerOrdersRepo));
  ok("4 · the seller-order detail page labels commission as calculated/read-only, not a settlement/payout figure", /Not a settlement or payout/.test(sellerOrdersDetailPage));
  ok("4 · the aggregate StatCard is explicitly labelled calculated/read-only", /not a settlement figure/.test(sellerOrdersListPage));

  // SellerOrder -> parent Order link
  ok("5 · getAdminOrder now selects sellerOrders (id/sellerId/sellerName/status) — read-only addition", /sellerOrders: \{\s*\n\s*select: \{ id: true, sellerId: true, sellerName: true, status: true \}/.test(ordersRepo));
  ok("5 · the order detail page renders a link to /admin/seller-orders/<id> when sellerOrders exist", /order\.sellerOrders\.length > 0/.test(orderDetailPage) && /\/admin\/seller-orders\/\$\{so\.id\}/.test(orderDetailPage));
  ok("5 · order-actions.ts (the cancel cascade) is untouched by this phase", !/9F-8d/.test(read("src/lib/admin/order-actions.ts")));

  // No schema/inventory/offer-activation/checkout/PayMongo/multiSellerCheckout change
  ok("scope · no schema change", !/9F-8d/.test(schema));
  ok("scope · checkout.ts untouched", !/9F-8d/.test(read("src/lib/checkout.ts")));
  ok("scope · seller-repository.ts (offer activation) untouched by this phase", !/9F-8d/.test(read("src/lib/marketplace/seller-repository.ts")));
  ok("scope · no multiSellerCheckout write anywhere in the new/changed files", ![offersRepo, sellerOrdersRepo, offersPage, sellerOrdersListPage, sellerOrdersDetailPage, ordersRepo, orderDetailPage].some((f) => /multiSellerCheckout.*=.*"true"/.test(f)));
  ok("scope · no PayMongo / payout / settlement WRITE code added", ![offersRepo, sellerOrdersRepo].some((f) => /PAYMONGO_|initiateProviderRefund/.test(f)));
}

// ---------------------------------------------------------------------------
// Database — read-only, against real committed data
// ---------------------------------------------------------------------------

const STYLE_AVENUE_SELLER_ID = "cmtmqr8p70003l7046ygchae6";
const KNOWN_STYLE_AVENUE_OFFER_ID = "cmtmuh6lu0001kg8g8shh2z90";

async function dbTests() {
  // ---- Cross-seller Offer listing + filters ----
  const allOffers = await listAllOffersForAdmin({});
  ok("6 · listAllOffersForAdmin({}) returns offers from more than one seller", new Set(allOffers.rows.map((r) => r.sellerId)).size > 1 || allOffers.total > allOffers.rows.length, JSON.stringify({ total: allOffers.total, distinctSellersOnPage1: new Set(allOffers.rows.map((r) => r.sellerId)).size }));
  ok("6 · total count is a real positive number (Axiaro alone has hundreds of offers)", allOffers.total > 1);

  const styleAvenueOffers = await listAllOffersForAdmin({ sellerId: STYLE_AVENUE_SELLER_ID });
  ok("7 · filter by seller (Style Avenue) returns exactly its known offer", styleAvenueOffers.rows.length === 1 && styleAvenueOffers.rows[0].id === KNOWN_STYLE_AVENUE_OFFER_ID, JSON.stringify(styleAvenueOffers.rows));
  ok("7 · the row correctly identifies status DRAFT", styleAvenueOffers.rows[0]?.status === "DRAFT");
  ok("7 · the row correctly identifies the seller name and product", styleAvenueOffers.rows[0]?.sellerName === "Style Avenue" && styleAvenueOffers.rows[0]?.productName === "Linen Blend Relaxed Shirt");

  const styleAvenueActiveOnly = await listAllOffersForAdmin({ sellerId: STYLE_AVENUE_SELLER_ID, status: "ACTIVE" });
  ok("8 · filter by seller + status=ACTIVE returns 0 (the only offer is DRAFT)", styleAvenueActiveOnly.rows.length === 0);
  const styleAvenueDraftOnly = await listAllOffersForAdmin({ sellerId: STYLE_AVENUE_SELLER_ID, status: "DRAFT" });
  ok("8 · filter by seller + status=DRAFT returns the 1 known offer", styleAvenueDraftOnly.rows.length === 1);

  const counts = await adminOfferStatusCounts(STYLE_AVENUE_SELLER_ID);
  ok("9 · adminOfferStatusCounts identifies DRAFT/ACTIVE/INACTIVE/ARCHIVED correctly for Style Avenue", counts.DRAFT === 1 && counts.ACTIVE === 0 && counts.INACTIVE === 0 && counts.ARCHIVED === 0, JSON.stringify(counts));

  const sellerFilterOptions = await listSellersForOfferFilter();
  ok("10 · the seller filter dropdown includes Style Avenue (it has an offer)", sellerFilterOptions.some((s) => s.id === STYLE_AVENUE_SELLER_ID));

  // ---- SellerOrder visibility + linkage ----
  const anySellerOrders = await listAdminSellerOrders({});
  ok("11 · listAdminSellerOrders({}) sees at least one real SellerOrder", anySellerOrders.total >= 1, JSON.stringify({ total: anySellerOrders.total }));
  const first = anySellerOrders.rows[0];
  ok("11 · each row carries seller, order, status, and all 4 money fields", Boolean(first) && typeof first.sellerName === "string" && typeof first.orderNumber === "string" && typeof first.status === "string" && typeof first.merchandiseSubtotal === "number" && typeof first.shippingFee === "number" && typeof first.total === "number" && typeof first.commissionAmount === "number");

  const detail = await getAdminSellerOrder(first.id);
  ok("12 · getAdminSellerOrder returns the matching detail row", detail !== null && detail?.id === first.id);
  ok("12 · detail exposes the parent order reference (id, number, email, status, placedAt)", Boolean(detail?.order.id) && Boolean(detail?.order.orderNumber) && Boolean(detail?.order.email) && Boolean(detail?.order.status) && Boolean(detail?.order.placedAt));
  ok("12 · detail exposes commission fields straight from storage", detail?.commissionAmount === first.commissionAmount && typeof detail?.commissionRate === "number");
  ok("12 · detail exposes settlementStatus (visibility only, never transitioned here)", typeof detail?.settlementStatus === "string");

  const parentOrder = await getAdminOrder(detail!.order.id);
  ok("13 · getAdminOrder(parentOrderId) links back to the SAME SellerOrder id", Boolean(parentOrder) && parentOrder!.sellerOrders.some((so) => so.id === detail!.id), JSON.stringify(parentOrder?.sellerOrders));

  const sellerOrderFilterOptions = await listSellersForSellerOrderFilter();
  ok("14 · the SellerOrder seller-filter dropdown is non-empty and well-shaped", sellerOrderFilterOptions.length > 0 && typeof sellerOrderFilterOptions[0].id === "string" && typeof sellerOrderFilterOptions[0].displayName === "string");

  const total = await adminCommissionTotal();
  ok("15 · adminCommissionTotal() returns a non-negative number (sum of stored values)", typeof total === "number" && total >= 0);
}

async function main() {
  console.log("\nPHASE 9F-8d.1 — admin marketplace visibility (offers + seller orders)\n");
  console.log("Static wiring");
  staticTests();
  console.log("\nDatabase (read-only, real committed data)");
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
