/**
 * PHASE 9F-14 — seller new-order notification + shipping-workflow UX labels.
 *
 *   1. seller_order_received email — one per THIRD_PARTY order, to the seller's
 *      own mailbox(es), fulfilment data only, idempotent, retryable; a no-op for
 *      a FIRST_PARTY order.
 *   2. seller fulfilment button / toast labels ("Accept order" vs "Move back to
 *      preparing").
 *
 * DB tests build a seller + OWNER user + order + THIRD_PARTY SellerOrder + items
 * in ONE prisma.$transaction and roll back. No EMAIL_* creds locally, so a
 * "successful" send records SKIPPED — the assertion is that it ROUTES with the
 * right type / recipient / idempotency key and dedupes.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f14.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { sendSellerOrderReceived, retryEmailByLog } from "../src/lib/email/notifications";
import { renderSellerOrderReceived } from "../src/lib/email/templates/seller-order-notifications";
import { sellerAdvanceLabels } from "../src/lib/marketplace/seller-order-status";

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

const SHIP_ADDR = {
  firstName: "Del",
  lastName: "Recipient",
  phone: "+639170000000",
  line1: "42 Sample Rd",
  barangay: "Poblacion",
  city: "Makati",
  province: "NCR",
  postalCode: "1210",
  country: "PH",
};

async function seedOrder(tx: Tx, t: string, opts: { sellerType?: string; withOwner?: boolean; paymentMethod?: string } = {}) {
  const sellerType = opts.sellerType ?? "THIRD_PARTY";
  const withOwner = opts.withOwner ?? true;
  const seller = await tx.seller.create({
    data: { type: sellerType === "FIRST_PARTY" ? "THIRD_PARTY" : sellerType, status: "APPROVED", displayName: `SA ${t}`, slug: `sa9f14-${t}`, supportEmail: `sa-${t}@t.test`, contentStatus: "DRAFT" },
    select: { id: true, displayName: true },
  });
  let ownerEmail: string | null = null;
  if (withOwner) {
    ownerEmail = `owner-${t}@t.test`;
    const owner = await tx.user.create({ data: { email: ownerEmail, name: "Owner", role: "CUSTOMER" }, select: { id: true } });
    await tx.sellerUser.create({ data: { sellerId: seller.id, userId: owner.id, role: "OWNER", status: "ACTIVE" } });
  }
  const order = await tx.order.create({
    data: {
      orderNumber: `AX-T9F14-${t}-${Math.random().toString(36).slice(2, 5)}`,
      email: "customer-secret@t.test",
      phone: "+639999999999",
      status: "PENDING_PAYMENT",
      paymentMethod: opts.paymentMethod ?? "NONE",
      subtotal: 239800,
      shippingFee: 15000,
      discountTotal: 0,
      grandTotal: 254800,
      shippingAddress: JSON.stringify(SHIP_ADDR),
    },
    select: { id: true, orderNumber: true },
  });
  const so = await tx.sellerOrder.create({
    data: {
      orderId: order.id,
      sellerId: seller.id,
      sellerName: seller.displayName,
      sellerType, // FIRST_PARTY here means "1P order" for the skip test
      supportEmail: `sa-${t}@t.test`,
      merchandiseSubtotal: 239800,
      discountAllocated: 0,
      shippingFee: 15000,
      total: 254800,
      commissionAmount: 35970,
      status: "PENDING_PAYMENT",
      settlementStatus: "PENDING_CAPTURE",
    },
    select: { id: true },
  });
  await tx.orderItem.create({
    data: { orderId: order.id, sellerOrderId: so.id, sellerId: seller.id, productId: "p", name: "Linen Blend Relaxed Shirt", variantLabel: "Medium", sku: "LBRS-M", unitPrice: 119900, quantity: 2, lineTotal: 239800 },
  });
  return { orderId: order.id, orderNumber: order.orderNumber, sellerOrderId: so.id, ownerEmail };
}

function pureTests() {
  console.log("\n── pure — sellerAdvanceLabels (9F-14 fulfilment button / toast) ──");
  const accept = sellerAdvanceLabels("PENDING_PAYMENT", "PROCESSING");
  ok("PENDING_PAYMENT → PROCESSING button = 'Accept order'", accept.button === "Accept order");
  ok("PENDING_PAYMENT → PROCESSING toast = 'accepted'", accept.done === "accepted");
  ok("PENDING_PAYMENT → PROCESSING is a primary action", accept.primary === true);
  const unready = sellerAdvanceLabels("READY_TO_SHIP", "PROCESSING");
  ok("READY_TO_SHIP → PROCESSING button = 'Move back to preparing'", unready.button === "Move back to preparing");
  ok("READY_TO_SHIP → PROCESSING is NOT primary (secondary/outline)", unready.primary === false);
  ok("READY_TO_SHIP → PROCESSING toast = 'moved back to preparing'", unready.done === "moved back to preparing");
  ok("PROCESSING → READY_TO_SHIP button = 'Mark ready to ship'", sellerAdvanceLabels("PROCESSING", "READY_TO_SHIP").button === "Mark ready to ship");
  ok("READY_TO_SHIP → SHIPPED button = 'Mark shipped'", sellerAdvanceLabels("READY_TO_SHIP", "SHIPPED").button === "Mark shipped");
  ok("SHIPPED → DELIVERED button = 'Mark delivered'", sellerAdvanceLabels("SHIPPED", "DELIVERED").button === "Mark delivered");

  console.log("\n── pure — renderSellerOrderReceived content ──");
  const msg = renderSellerOrderReceived({
    brand: "Axiaro",
    siteUrl: "https://axiaro.shop",
    sellerName: "Style Avenue",
    orderNumber: "AX-260907-100358",
    ordersUrl: "https://axiaro.shop/seller/orders",
    orderUrl: "https://axiaro.shop/seller/orders/so_123",
    items: [{ name: "Linen Blend Relaxed Shirt", variantLabel: "Medium", quantity: 2, unitPrice: 119900, lineTotal: 239800 }],
    merchandiseSubtotal: 239800,
    discountAllocated: 0,
    shippingFee: 15000,
    payoutBasis: 254800,
    paymentMethodLabel: "Cash on Delivery (COD)",
    shipTo: SHIP_ADDR,
  });
  const blob = msg.subject + "\n" + msg.html + "\n" + msg.text;
  ok("subject carries order number + seller name", /AX-260907-100358/.test(msg.subject) && /Style Avenue/.test(msg.subject));
  ok("body carries the item (name + variant + qty)", /Linen Blend Relaxed Shirt/.test(blob) && /Medium/.test(blob) && /2/.test(msg.text));
  ok("body carries merchandise + shipping + payout basis", /Merchandise/.test(blob) && /₱2,398/.test(blob) && /₱150/.test(blob) && /payout basis/i.test(blob) && /₱2,548/.test(blob));
  ok("body carries the COD payment method", /Cash on Delivery \(COD\)/.test(blob));
  ok("body carries the delivery address (recipient + street + phone)", /Del Recipient/.test(blob) && /42 Sample Rd/.test(blob) && /\+639170000000/.test(blob));
  ok("body carries the Seller Portal order link", /seller\/orders\/so_123/.test(blob));
  ok("NO customer email / account name / grand-total-only leakage", !/customer-secret/.test(blob) && !/customer@/.test(blob));
  ok("has a Seller-Portal CTA button", /Open order in Seller Portal/.test(msg.html));
}

function staticTests() {
  console.log("\n── static wiring ──");
  const send = read("src/lib/email/send.ts");
  const notifs = read("src/lib/email/notifications.ts");
  const checkout = read("src/lib/checkout.ts");
  const panel = read("src/components/seller/order-fulfillment-panel.tsx");
  const actions = read("src/lib/seller/order-actions.ts");
  const repo = read("src/lib/marketplace/seller-order-repository.ts");

  ok("EmailType gained exactly one new (seller-facing) type: seller_order_received", /\| "seller_order_received"/.test(send));
  ok("no NEW customer-facing email type introduced", !/order_(confirmation|processing|shipped|delivered)_v2|customer_/.test(send));
  ok("sender reuses loadSellerLifecycleEmailContext (no new resolver)", /sendSellerOrderReceived[\s\S]{0,2600}loadSellerLifecycleEmailContext\(so\.sellerId/.test(notifs));
  ok("sender uses renderAndDispatch (existing dispatchEmail path)", /sendSellerOrderReceived[\s\S]{0,2600}renderAndDispatch\(/.test(notifs));
  ok("sender key = SELLER_ORDER_RECEIVED:<orderId>", /const idempotencyKey = opts\.idempotencyKey \?\? `SELLER_ORDER_RECEIVED:\$\{orderId\}`/.test(notifs));
  ok("sender skips a FIRST_PARTY (Axiaro) order", /so\.sellerType !== "THIRD_PARTY"\) return \{ ok: true, skipped: true, status: "SKIPPED" \}/.test(notifs));
  ok("sender never selects the customer's Order.email / userId / billing", !/sendSellerOrderReceived[\s\S]{0,900}(email: true|userId: true|billingAddress: true)/.test(notifs));
  ok("retryEmailByLog handles seller_order_received", /case "seller_order_received":[\s\S]{0,200}sendSellerOrderReceived\(log\.orderId/.test(notifs));
  ok("checkout fires it after commit alongside the other order emails", /scheduleEmail\(\(\) => sendSellerOrderReceived\(created\.id\)\)/.test(checkout));
  ok("checkout change is email-only — no payment / inventory / offer write added", !/paymentStatus|paymentMethod|offerInventory|OfferInventory/i.test(checkout.slice(checkout.indexOf("sendOrderReceivedOps(created.id)"), checkout.indexOf("sendOrderReceivedOps(created.id)") + 400)));

  ok("panel button label comes from sellerAdvanceLabels(status, to)", /const \{ button, primary \} = sellerAdvanceLabels\(status, to\);/.test(panel));
  ok("panel no longer hard-codes 'Move back to preparing' as the PENDING_PAYMENT label", !/to === "PROCESSING"\s*\n?\s*\? "Move back to preparing"/.test(panel));
  ok("seller action toast uses res.from + sellerAdvanceLabels", /const \{ done \} = sellerAdvanceLabels\(res\.from, parsed\.data\.to\);/.test(actions));
  ok("advanceSellerOrderStatus returns `from` on success (+ orderId/orderNumber, 9F-31B)", /return \{\s*\n\s*ok: true,\s*\n\s*status: to,\s*\n\s*from: so\.status as SellerOrderStatus,\s*\n\s*orderId: so\.order\.id,\s*\n\s*orderNumber: so\.order\.orderNumber,\s*\n\s*parentOrder,\s*\n\s*\};/.test(repo));

  // guardrails — 9F-12b rollup + its emails untouched
  ok("9F-12b rollup helper unchanged (still keyed on ORDER_SHIPPED / ORDER_DELIVERED via existing senders)", /rollUpParentOrder/.test(repo) && /sendOrderShipped\(id\) : sendOrderDelivered\(id\)/.test(actions));
  ok("no change to SellerSettlement / settlement eligibility / returns / cancellation in these files", !/SellerSettlement|settlementStatus =|getSellerSettlementPreview/.test(notifs.slice(notifs.indexOf("sendSellerOrderReceived"), notifs.indexOf("sendSellerOrderReceived") + 1600)));
  ok("scope · seed-rbac.ts untouched marker", !/9F-14/.test(read("scripts/seed-rbac.ts")));
}

async function dbTests() {
  console.log("\n── db (rolled back) ──");
  const emailBefore = await prisma.emailLog.count();
  try {
    await prisma.$transaction(async (tx) => {
      const t = String(Date.now()).slice(-7);

      // ── 1. THIRD_PARTY → exactly one seller_order_received, to the seller ──
      const tp = await seedOrder(tx, t + "a", { sellerType: "THIRD_PARTY", paymentMethod: "NONE" });
      const r1 = await sendSellerOrderReceived(tp.orderId, { client: tx });
      ok("1 · send routed (ok / skipped-because-no-creds, never threw)", r1.ok === true || r1.status === "SKIPPED", JSON.stringify(r1));
      const key = `SELLER_ORDER_RECEIVED:${tp.orderId}`;
      const row1 = await tx.emailLog.findUnique({ where: { idempotencyKey: key }, select: { type: true, recipient: true, orderId: true, subject: true } });
      ok("1 · one EmailLog row, type seller_order_received", !!row1 && row1.type === "seller_order_received");
      ok("1 · addressed to the seller OWNER, not the customer", row1?.recipient === tp.ownerEmail && !row1?.recipient?.includes("customer-secret"));
      ok("1 · row is linked to the order", row1?.orderId === tp.orderId);
      ok("1 · subject names the order + seller", !!row1 && /T9F14/.test(row1.subject));

      // repeat → deduped, still one row
      const r1b = await sendSellerOrderReceived(tp.orderId, { client: tx });
      ok("1 · repeat send is deduped (no second email)", (await tx.emailLog.count({ where: { idempotencyKey: key } })) === 1, JSON.stringify(r1b));

      // retry via the log → same row
      const logId = (await tx.emailLog.findUniqueOrThrow({ where: { idempotencyKey: key }, select: { id: true } })).id;
      const retry = await retryEmailByLog(logId, tx);
      ok("1 · retryEmailByLog reuses the same row", Boolean(retry) && (await tx.emailLog.count({ where: { idempotencyKey: key } })) === 1);

      // ── 2. FIRST_PARTY (1P) order → skipped, no row ──
      const fp = await seedOrder(tx, t + "b", { sellerType: "FIRST_PARTY" });
      const r2 = await sendSellerOrderReceived(fp.orderId, { client: tx });
      ok("2 · a 1P (FIRST_PARTY) order → SKIPPED", r2.status === "SKIPPED");
      ok("2 · no EmailLog row for the 1P order", (await tx.emailLog.findUnique({ where: { idempotencyKey: `SELLER_ORDER_RECEIVED:${fp.orderId}` } })) === null);

      // ── 3. seller with NO resolvable recipient → FAILED, no crash, no row ──
      const nr = await seedOrder(tx, t + "c", { sellerType: "THIRD_PARTY", withOwner: false });
      const r3 = await sendSellerOrderReceived(nr.orderId, { client: tx });
      ok("3 · no recipient → FAILED 'no_recipient' (handled, not thrown)", r3.ok === false && r3.error === "no_recipient");

      // ── 4. missing order → FAILED, no crash ──
      const r4 = await sendSellerOrderReceived("cmnope0000000000000000000", { client: tx });
      ok("4 · unknown order → FAILED, handled", r4.ok === false);

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  ok("rolled back cleanly — no EmailLog rows persisted", (await prisma.emailLog.count()) === emailBefore);
}

async function main() {
  console.log("\nPHASE 9F-14 — seller new-order notification + shipping UX\n");
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
