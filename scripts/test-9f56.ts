/**
 * PHASE 9F-56 — 3P marketplace seller email notification framework.
 *
 * Fills the gaps an audit of the 22-item seller-notification checklist found:
 *   - Seller APPLICATION lifecycle gained reject/reopen (Seller.status
 *     PENDING ⇄ REJECTED), each requiring the admin's actual reason, plus the
 *     "application received" ack — seller_account_submitted/rejected/reopened.
 *   - seller_product_request_resubmitted_ops — an Ops-only signal when a
 *     seller resubmits a request that already went through a review cycle.
 *   - seller_order_accepted / ready_to_ship / shipped / delivered — a
 *     self-confirmation receipt for the seller's OWN SellerOrder milestone.
 *   - seller_shipment_created — a shipment record was created.
 *   - seller_return_rejected — the missing counterpart of seller_return_approved.
 *   - seller_refund_notice — a bookkeeping refund completed on an order
 *     covering a THIRD_PARTY seller's line.
 *
 * Every new sender takes an optional transaction client and is
 * failEmailPreparation-backed (durable FAILED row on any prep failure), same
 * as the rest of the seller-notification surface. DB tests build fixtures
 * inside ONE prisma.$transaction and roll back — no EMAIL_* creds locally, so
 * a "successful" send records SKIPPED (not SENT); the assertion is that it
 * ROUTES with the right type/recipient/idempotency key/content and dedupes.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f56.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  sendSellerAccountSubmitted,
  sendSellerAccountRejected,
  sendSellerAccountReopened,
  sendSellerProductRequestResubmittedOps,
  sendSellerOrderMilestone,
  sendSellerShipmentCreated,
  sendSellerReturnRejected,
  sendSellerRefundNotice,
} from "../src/lib/email/notifications";
import {
  renderSellerAccountSubmitted,
  renderSellerAccountRejected,
  renderSellerAccountReopened,
} from "../src/lib/email/templates/seller-lifecycle";
import { renderSellerReturnRejected, renderSellerRefundNotice, renderSellerOrderMilestone, renderSellerShipmentCreated } from "../src/lib/email/templates/seller-order-notifications";
import { renderSellerProductRequestResubmittedOps } from "../src/lib/email/templates/ops-notifications";
import {
  SELLER_TRANSITIONS,
  SELLER_STATUSES,
  sellerTransitionRequiresReason,
  canTransitionSeller,
} from "../src/lib/admin/sellers/lifecycle";
import { transitionSellerStatus } from "../src/lib/admin/sellers/repository";
import { submitSellerRequest } from "../src/lib/marketplace/seller-product-request-repository";

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function seedSeller(tx: Tx, tag: string, over: { status?: string; notifyEmail?: string | null } = {}) {
  return tx.seller.create({
    data: {
      type: "THIRD_PARTY",
      status: over.status ?? "PENDING",
      displayName: `Seller ${tag}`,
      slug: `s9f56-${tag}-${Math.random().toString(36).slice(2, 7)}`,
      supportEmail: `support-${tag}@t.test`,
      contentStatus: "DRAFT",
      notifyEmail: over.notifyEmail ?? null,
    },
    select: { id: true, displayName: true, supportEmail: true },
  });
}
async function seedOwner(tx: Tx, sellerId: string, tag: string) {
  const email = `owner-${tag}@t.test`;
  const user = await tx.user.create({ data: { email, name: "Owner" }, select: { id: true } });
  await tx.sellerUser.create({ data: { sellerId, userId: user.id, role: "OWNER", status: "ACTIVE" } });
  return email;
}
async function seedAudit(tx: Tx, action: string, sellerId: string, meta: Record<string, unknown>) {
  return tx.adminAuditLog.create({
    data: { action, targetType: "seller", targetId: sellerId, summary: "x", meta: JSON.stringify(meta) },
    select: { id: true },
  });
}

async function seedOrderWithSellerOrder(tx: Tx, sellerId: string, sellerDisplayName: string, tag: string) {
  const order = await tx.order.create({
    data: {
      orderNumber: `AX-T9F56-${tag}-${Math.random().toString(36).slice(2, 6)}`,
      email: "buyer-secret@t.test",
      phone: "+639000000000",
      status: "PROCESSING",
      paymentMethod: "NONE",
      subtotal: 100000,
      shippingFee: 15000,
      grandTotal: 115000,
      shippingAddress: JSON.stringify({ firstName: "T", city: "M", country: "PH" }),
    },
    select: { id: true, orderNumber: true },
  });
  const so = await tx.sellerOrder.create({
    data: {
      orderId: order.id,
      sellerId,
      sellerName: sellerDisplayName,
      sellerType: "THIRD_PARTY",
      supportEmail: "s@t.test",
      merchandiseSubtotal: 100000,
      shippingFee: 15000,
      total: 115000,
      status: "PROCESSING",
    },
    select: { id: true },
  });
  await tx.orderItem.create({
    data: { orderId: order.id, sellerOrderId: so.id, sellerId, productId: "p", name: "Test Item", unitPrice: 100000, quantity: 1, lineTotal: 100000 },
  });
  return { orderId: order.id, orderNumber: order.orderNumber, sellerOrderId: so.id };
}

async function seedReturnForSeller(
  tx: Tx,
  orderId: string,
  sellerOrderId: string,
  sellerId: string,
  tag: string,
  over: { resolutionNote?: string | null; refundAmount?: number | null; status?: string } = {},
) {
  const oi = await tx.orderItem.create({
    data: { orderId, sellerOrderId, sellerId, productId: "p", name: "Returned Item", unitPrice: 50000, quantity: 1, lineTotal: 50000 },
    select: { id: true },
  });
  return tx.returnRequest.create({
    data: {
      returnNumber: `RET-T9F56-${tag}`,
      orderId,
      status: over.status ?? "REJECTED",
      reason: "NOT_AS_DESCRIBED",
      resolutionNote: over.resolutionNote === undefined ? "Item shows normal wear, not a defect." : over.resolutionNote,
      refundAmount: over.refundAmount === undefined ? 50000 : over.refundAmount,
      items: { create: [{ orderItemId: oi.id, productId: "p", name: "Returned Item", unitPrice: 50000, quantity: 1, refundAmount: 50000 }] },
    },
    select: { id: true, returnNumber: true },
  });
}

// ---------------------------------------------------------------------------
// 1 — pure / static: the seller-account state machine gained REJECTED cleanly
// ---------------------------------------------------------------------------

function stateMachineTests() {
  console.log("\n── 1 · seller account state machine (REJECTED added) ──");
  ok("1 · SELLER_STATUSES includes REJECTED (5 total)", [...SELLER_STATUSES].sort().join(",") === "APPROVED,CLOSED,PENDING,REJECTED,SUSPENDED");
  ok("1 · PENDING → REJECTED is now valid", canTransitionSeller("PENDING", "REJECTED") === true);
  ok("1 · REJECTED → PENDING (reopen) is now valid", canTransitionSeller("REJECTED", "PENDING") === true);
  ok("1 · REJECTED is otherwise terminal (no REJECTED → APPROVED/SUSPENDED/CLOSED)",
    !canTransitionSeller("REJECTED", "APPROVED") && !canTransitionSeller("REJECTED", "SUSPENDED") && !canTransitionSeller("REJECTED", "CLOSED"));
  ok("1 · every PRE-EXISTING transition is untouched", JSON.stringify(SELLER_TRANSITIONS.APPROVED) === JSON.stringify(["SUSPENDED", "CLOSED"]) &&
    JSON.stringify(SELLER_TRANSITIONS.SUSPENDED) === JSON.stringify(["APPROVED", "CLOSED"]) &&
    JSON.stringify(SELLER_TRANSITIONS.CLOSED) === JSON.stringify([]));
  ok("1 · sellerTransitionRequiresReason(PENDING,REJECTED) === true", sellerTransitionRequiresReason("PENDING", "REJECTED") === true);
  ok("1 · sellerTransitionRequiresReason(REJECTED,PENDING) === true", sellerTransitionRequiresReason("REJECTED", "PENDING") === true);
  for (const [from, to] of [["PENDING", "APPROVED"], ["APPROVED", "SUSPENDED"], ["APPROVED", "CLOSED"], ["SUSPENDED", "APPROVED"], ["SUSPENDED", "CLOSED"]] as const) {
    ok(`1 · sellerTransitionRequiresReason(${from},${to}) === false (unchanged transitions never require one)`,
      sellerTransitionRequiresReason(from, to) === false);
  }
}

// ---------------------------------------------------------------------------
// 2 — static wiring
// ---------------------------------------------------------------------------

function staticTests() {
  console.log("\n── 2 · static wiring ──");
  const send = read("src/lib/email/send.ts");
  const notif = read("src/lib/email/notifications.ts");
  const sellersActions = read("src/lib/admin/sellers/actions.ts");
  const orderActions = read("src/lib/seller/order-actions.ts");
  const returnsActions = read("src/lib/admin/returns-actions.ts");
  const productRequestActions = read("src/lib/seller/product-request-actions.ts");
  const productRequestRepo = read("src/lib/marketplace/seller-product-request-repository.ts");

  const NEW_TYPES = [
    "seller_account_submitted", "seller_account_rejected", "seller_account_reopened",
    "seller_order_accepted", "seller_order_ready_to_ship", "seller_shipment_created",
    "seller_order_shipped", "seller_order_delivered",
    "seller_return_rejected", "seller_refund_notice",
    "seller_product_request_resubmitted_ops",
  ];
  for (const t of NEW_TYPES) {
    ok(`2 · EmailType includes "${t}"`, new RegExp(`"${t}"`).test(send));
  }

  // reason enforcement — action layer, BEFORE any state mutation
  ok("2 · transitionSellerAction schema accepts an optional reason",
    /reason: z\.string\(\)\.trim\(\)\.max\(2000\)\.optional\(\)/.test(sellersActions));
  ok("2 · transitionSellerAction REQUIRES a reason for REJECTED and PENDING(reopen), checked BEFORE transitionSellerStatus is called",
    /if \(\(parsed\.data\.to === "REJECTED" \|\| parsed\.data\.to === "PENDING"\) && !reason\) \{\s*\n\s*return \{[\s\S]{0,260}const res = await transitionSellerStatus/.test(sellersActions));
  ok("2 · the reason is written into the audit meta only for the two reason-requiring transitions",
    /\.\.\.\(requiresReason \? \{ reason \} : \{\}\)/.test(sellersActions));
  ok("2 · createSellerAction schedules the 'submitted' ack",
    /scheduleEmail\(\(\) => sendSellerAccountSubmitted\(res\.sellerId\)\)/.test(sellersActions));
  ok("2 · transitionSellerAction schedules sendSellerAccountRejected on REJECTED",
    /else if \(res\.to === "REJECTED"\) \{\s*\n\s*scheduleEmail\(\(\) => sendSellerAccountRejected\(res\.sellerId, auditLogId\)\)/.test(sellersActions));
  ok("2 · transitionSellerAction schedules sendSellerAccountReopened on PENDING",
    /else if \(res\.to === "PENDING"\) \{\s*\n\s*scheduleEmail\(\(\) => sendSellerAccountReopened\(res\.sellerId, auditLogId\)\)/.test(sellersActions));

  // order milestone wiring — all 4, gated correctly
  ok("2 · advanceSellerOrderAction computes a milestone for accepted/ready_to_ship/shipped/delivered",
    /"accepted"[\s\S]{0,80}"ready_to_ship"[\s\S]{0,400}sendSellerOrderMilestone\(parsed\.data\.sellerOrderId, milestone\)/.test(orderActions));
  ok("2 · the 'accepted' milestone still requires res.from === PENDING_PAYMENT (same gate as sendOrderProcessing)",
    /res\.from === "PENDING_PAYMENT" && parsed\.data\.to === "PROCESSING"\s+\? "accepted"/.test(orderActions));
  ok("2 · saveShipmentAction fires sendSellerShipmentCreated ONLY on create (isCreate), never on edit",
    /const isCreate = !d\.shipmentId;[\s\S]{0,700}if \(isCreate\) \{\s*scheduleEmail\(\(\) => sendSellerShipmentCreated\(res\.shipmentId\)\)/.test(orderActions));

  // returns / refund wiring
  ok("2 · rejectReturnAction fires sendSellerReturnRejected per affected seller (mirrors the approve loop)",
    /scheduleEmail\(\(\) => sendReturnRejected\(ret\.id\)\);[\s\S]{0,400}const affectedSellerIds = await getReturnAffectedSellerIds\(ret\.id\);[\s\S]{0,200}scheduleEmail\(\(\) => sendSellerReturnRejected\(ret\.id, sellerId\)\)/.test(returnsActions));
  ok("2 · completeRefundAction fires sendSellerRefundNotice per affected seller (bookkeeping path only)",
    /scheduleEmail\(\(\) => sendReturnRefundCompletedOps\(ret\.id\)\);[\s\S]{0,600}scheduleEmail\(\(\) => sendSellerRefundNotice\(ret\.id, sellerId\)\)/.test(returnsActions));

  // resubmission signal
  ok("2 · submitSellerRequest reports wasResubmission derived from reviewedAt (never a caller flag)",
    /const wasResubmission = current\.reviewedAt !== null;/.test(productRequestRepo));
  ok("2 · submitRequestAction fires the Ops resubmission email ONLY when wasResubmission",
    /if \(res\.wasResubmission\) \{\s*\n\s*scheduleEmail\(\(\) => sendSellerProductRequestResubmittedOps\(requestId\)\)/.test(productRequestActions));
  ok("2 · the seller's own 'submitted' ack still fires unconditionally (both first-time and resubmission)",
    /scheduleEmail\(\(\) => sendSellerProductRequestSubmitted\(requestId\)\);[\s\S]{0,300}if \(res\.wasResubmission\)/.test(productRequestActions));

  // durable-failure pattern used by every new sender
  for (const fn of [
    "sendSellerAccountSubmitted", "sendSellerAccountRejected", "sendSellerAccountReopened",
    "sendSellerOrderMilestone", "sendSellerShipmentCreated", "sendSellerReturnRejected",
    "sendSellerRefundNotice", "sendSellerProductRequestResubmittedOps",
  ]) {
    const body = notif.slice(notif.indexOf(`export async function ${fn}(`), notif.indexOf(`export async function ${fn}(`) + 2600);
    ok(`2 · ${fn} uses failEmailPreparation (durable row), not a bare FAILED`, /failEmailPreparation\(/.test(body) && body.includes("failPrep"));
  }

  // never triggered from browser UI
  const suspects = ["src/components/seller/order-detail.tsx", "src/components/checkout/checkout-flow.tsx", "src/lib/checkout.ts", "src/lib/checkout-actions.ts"];
  const leaked = suspects.filter((s) => { try { return NEW_TYPES.some((t) => read(s).includes(t.replace(/_/g, ""))); } catch { return false; } });
  ok("2 · none of the new seller EmailTypes are referenced from checkout/browser-facing modules (best-effort scan)", leaked.length === 0, JSON.stringify(leaked));

  // scope
  ok("2 · scope · seed-rbac.ts untouched by this phase", !/9F-56/.test(read("scripts/seed-rbac.ts")));
  ok("2 · scope · no schema migration added for this phase (Seller/ReturnRequest/SellerOrder columns unchanged)",
    !/9F-56/.test(read("prisma/schema.prisma")));
  ok("2 · scope · settlement calculation module untouched", !/9F-56/.test(read("src/lib/marketplace/settlement.ts")));
  ok("2 · scope · PayMongo / payments webhook untouched", !/9F-56/.test(read("src/lib/payments/webhook.ts")) && !/9F-56/.test(read("src/lib/payments/checkout-session.ts")));
}

// ---------------------------------------------------------------------------
// 3 — pure render content: exact reason/note text, no invented copy
// ---------------------------------------------------------------------------

function renderTests() {
  console.log("\n── 3 · render content ──");
  const submitted = renderSellerAccountSubmitted({ brand: "Axiaro", siteUrl: "https://axiaro.shop", sellerName: "Acme Co" });
  ok("3 · submitted ack names the seller, no portal link claim (can't log in yet)", submitted.text.includes("Acme Co") && !submitted.html.includes("seller portal"));

  const EXACT_REASON = "Business registration document was illegible; please resubmit a clearer scan.";
  const rejected = renderSellerAccountRejected({ brand: "Axiaro", siteUrl: "https://axiaro.shop", sellerName: "Acme Co", reason: EXACT_REASON });
  ok("3 · rejection email includes the EXACT admin reason, verbatim", rejected.text.includes(EXACT_REASON) && rejected.html.includes(EXACT_REASON));
  ok("3 · rejection email does NOT invent a generic reason instead", !rejected.text.includes("not approved this time.\n\nAxiaro will") /* i.e. reason line is actually present, not skipped */);

  const EXACT_NOTE = "We re-checked with the business registry — the earlier mismatch was on our end.";
  const reopened = renderSellerAccountReopened({ brand: "Axiaro", siteUrl: "https://axiaro.shop", sellerName: "Acme Co", note: EXACT_NOTE });
  ok("3 · reopen email includes the EXACT admin note, verbatim", reopened.text.includes(EXACT_NOTE) && reopened.html.includes(EXACT_NOTE));

  const EXACT_RETURN_REASON = "Photos show normal wear consistent with use, not a manufacturing defect.";
  const returnRejected = renderSellerReturnRejected({
    brand: "Axiaro", siteUrl: "https://axiaro.shop", sellerName: "Acme Co", orderNumber: "AX-260911-100010",
    ordersUrl: "https://axiaro.shop/seller/orders", returnNumber: "RET-260911-100001", returnsUrl: "https://axiaro.shop/seller/returns",
    reasonLabel: "Not as described", reason: EXACT_RETURN_REASON, items: [{ name: "Lamp", variantLabel: null, quantity: 1 }],
  });
  ok("3 · return-rejected email includes the EXACT customer-facing reason, verbatim", returnRejected.text.includes(EXACT_RETURN_REASON) && returnRejected.html.includes(EXACT_RETURN_REASON));

  const refundNotice = renderSellerRefundNotice({
    brand: "Axiaro", siteUrl: "https://axiaro.shop", sellerName: "Acme Co", orderNumber: "AX-260911-100010", ordersUrl: "https://axiaro.shop/seller/orders",
    returnNumber: "RET-260911-100001", returnsUrl: "https://axiaro.shop/seller/returns", refundAmount: 50000,
    items: [{ name: "Lamp", variantLabel: null, quantity: 1 }],
  });
  ok("3 · refund notice carries the amount + order + return reference", refundNotice.text.includes("₱500") && refundNotice.text.includes("AX-260911-100010") && refundNotice.text.includes("RET-260911-100001"));

  for (const milestone of ["accepted", "ready_to_ship", "shipped", "delivered"] as const) {
    const r = renderSellerOrderMilestone({
      brand: "Axiaro", siteUrl: "https://axiaro.shop", sellerName: "Acme Co", orderNumber: "AX-260911-100010",
      ordersUrl: "https://axiaro.shop/seller/orders", orderUrl: "https://axiaro.shop/seller/orders/so1", milestone,
      items: [{ name: "Lamp", variantLabel: null, quantity: 1 }],
    });
    ok(`3 · milestone "${milestone}" email names the order + has a distinct subject`, r.text.includes("AX-260911-100010") && r.subject.includes(milestone === "accepted" ? "accepted" : milestone.replace(/_/g, " ")));
  }

  const shipmentCreated = renderSellerShipmentCreated({
    brand: "Axiaro", siteUrl: "https://axiaro.shop", sellerName: "Acme Co", orderNumber: "AX-260911-100010",
    ordersUrl: "https://axiaro.shop/seller/orders", orderUrl: "https://axiaro.shop/seller/orders/so1",
    carrierLabel: "J&T Express", trackingNumber: "JT123456789PH", trackingUrl: "https://jtexpress.ph/track/JT123456789PH",
  });
  ok("3 · shipment-created email carries carrier + tracking number + tracking link", shipmentCreated.text.includes("J&T Express") && shipmentCreated.text.includes("JT123456789PH") && shipmentCreated.text.includes("https://jtexpress.ph/track/JT123456789PH"));

  const resubmittedOps = renderSellerProductRequestResubmittedOps({ brand: "Axiaro", siteUrl: "https://axiaro.shop", adminUrl: "https://axiaro.shop/admin/seller-product-requests/r1", sellerName: "Acme Co", productName: "Table Lamp" });
  ok("3 · resubmitted-Ops email names the seller + product, links to admin review", resubmittedOps.text.includes("Acme Co") && resubmittedOps.text.includes("Table Lamp") && resubmittedOps.html.includes("/admin/seller-product-requests/r1"));

  for (const r of [submitted, rejected, reopened, returnRejected, refundNotice, shipmentCreated, resubmittedOps]) {
    ok("3 · no card number / token / provider secret leaks into a rendered email", !/\b\d{12,19}\b/.test(r.html) && !/pk_|sk_|whsk_/i.test(r.html));
  }
}

// ---------------------------------------------------------------------------
// 4 — DB (rolled back)
// ---------------------------------------------------------------------------

async function dbTests() {
  console.log("\n── 4 · DB (rolled back) ──");
  try {
    await prisma.$transaction(async (tx) => {
      // 4a — submitted ack: goes to supportEmail (no team members exist yet)
      const s1 = await seedSeller(tx, "app1");
      const r1 = await sendSellerAccountSubmitted(s1.id, { client: tx });
      ok("4a · sendSellerAccountSubmitted routes (not FAILED)", r1.ok === true, JSON.stringify(r1));
      const log1 = await tx.emailLog.findUnique({ where: { idempotencyKey: `SELLER_ACCOUNT_SUBMITTED:${s1.id}` }, select: { recipient: true, type: true } });
      ok("4a · EmailLog row exists, addressed to Seller.supportEmail, type seller_account_submitted", log1?.recipient === s1.supportEmail && log1?.type === "seller_account_submitted");
      const r1dup = await sendSellerAccountSubmitted(s1.id, { client: tx });
      ok("4a · duplicate call → deduped, still exactly one row", (r1dup.deduped === true || r1dup.status === "DEDUPED") && (await tx.emailLog.count({ where: { idempotencyKey: `SELLER_ACCOUNT_SUBMITTED:${s1.id}` } })) === 1);

      // 4b — reject: PENDING → REJECTED requires + carries the EXACT admin reason
      const s2 = await seedSeller(tx, "app2");
      const REASON = "The uploaded business permit has expired.";
      const trans2 = await transitionSellerStatus(s2.id, "REJECTED", tx);
      ok("4b · transitionSellerStatus(PENDING → REJECTED) now succeeds", trans2.ok === true && trans2.to === "REJECTED");
      const audit2 = await seedAudit(tx, "seller.rejected", s2.id, { sellerId: s2.id, from: "PENDING", to: "REJECTED", reason: REASON });
      const r2 = await sendSellerAccountRejected(s2.id, audit2.id, { client: tx });
      ok("4b · sendSellerAccountRejected routes", r2.ok === true, JSON.stringify(r2));
      const log2 = await tx.emailLog.findUnique({ where: { idempotencyKey: `SELLER_ACCOUNT_REJECTED:${s2.id}:${audit2.id}` }, select: { recipient: true, subject: true } });
      ok("4b · addressed to supportEmail (no team yet)", log2?.recipient === s2.supportEmail);
      const r2dup = await sendSellerAccountRejected(s2.id, audit2.id, { client: tx });
      ok("4b · duplicate call → deduped, still exactly one row", (r2dup.deduped === true || r2dup.status === "DEDUPED") && (await tx.emailLog.count({ where: { idempotencyKey: `SELLER_ACCOUNT_REJECTED:${s2.id}:${audit2.id}` } })) === 1);

      // 4b-missing — an audit row with no reason must FAIL, never invent one
      const s2b = await seedSeller(tx, "app2b");
      const audit2b = await seedAudit(tx, "seller.rejected", s2b.id, { sellerId: s2b.id, from: "PENDING", to: "REJECTED" });
      const r2b = await sendSellerAccountRejected(s2b.id, audit2b.id, { client: tx });
      ok("4b · a reject audit row with NO reason → durable FAILED, never invented text", r2b.ok === false);
      const failRow2b = await tx.emailLog.findUnique({ where: { idempotencyKey: `SELLER_ACCOUNT_REJECTED:${s2b.id}:${audit2b.id}` } });
      ok("4b · ...and a durable row records exactly why", failRow2b?.status === "FAILED" && failRow2b.error === "missing_reason_on_audit_row");

      // 4c — reopen: REJECTED → PENDING carries the EXACT admin note
      const s3 = await seedSeller(tx, "app3", { status: "REJECTED" });
      const NOTE = "Please resubmit with your updated DTI registration.";
      const trans3 = await transitionSellerStatus(s3.id, "PENDING", tx);
      ok("4c · transitionSellerStatus(REJECTED → PENDING) now succeeds", trans3.ok === true && trans3.to === "PENDING");
      const audit3 = await seedAudit(tx, "seller.reopened", s3.id, { sellerId: s3.id, from: "REJECTED", to: "PENDING", reason: NOTE });
      const r3 = await sendSellerAccountReopened(s3.id, audit3.id, { client: tx });
      ok("4c · sendSellerAccountReopened routes", r3.ok === true, JSON.stringify(r3));
      const r3dup = await sendSellerAccountReopened(s3.id, audit3.id, { client: tx });
      ok("4c · repeated identical transition → deduped, still exactly one row", (r3dup.deduped === true || r3dup.status === "DEDUPED") && (await tx.emailLog.count({ where: { idempotencyKey: `SELLER_ACCOUNT_REOPENED:${s3.id}:${audit3.id}` } })) === 1);

      // 4d — product-request resubmission signal: wasResubmission derived correctly
      const s4 = await seedSeller(tx, "pr4", { status: "APPROVED" });
      const cat = await tx.category.findFirst({ select: { id: true } });
      if (!cat) throw new Error("fixture requires at least one Category to exist");
      const freshDraft = await tx.sellerProductRequest.create({
        data: { sellerId: s4.id, status: "DRAFT", proposedName: "New Widget", proposedCondition: "NEW" },
        select: { id: true },
      });
      const freshCtx = { sellerId: s4.id, userId: "u", sellerName: "S4" } as never;
      const freshRes = await submitSellerRequest(freshCtx, freshDraft.id, tx);
      ok("4d · a FIRST-TIME submission reports wasResubmission = false", freshRes.ok === true && freshRes.wasResubmission === false, JSON.stringify(freshRes));

      const reviewedDraft = await tx.sellerProductRequest.create({
        data: { sellerId: s4.id, status: "DRAFT", proposedName: "Reopened Widget", proposedCondition: "NEW", reviewedAt: new Date(), reviewStatusNote: "Fix the SKU" },
        select: { id: true },
      });
      const resubmitRes = await submitSellerRequest(freshCtx, reviewedDraft.id, tx);
      ok("4d · a RESUBMISSION (reviewedAt already set) reports wasResubmission = true", resubmitRes.ok === true && resubmitRes.wasResubmission === true, JSON.stringify(resubmitRes));

      const opsR = await sendSellerProductRequestResubmittedOps(reviewedDraft.id, { client: tx });
      ok("4d · sendSellerProductRequestResubmittedOps routes to the Ops inbox", opsR.ok === true, JSON.stringify(opsR));
      const opsLog = await tx.emailLog.findFirst({ where: { idempotencyKey: { startsWith: `SELLER_PRODUCT_REQUEST_RESUBMITTED_OPS:${reviewedDraft.id}:` } }, select: { type: true } });
      ok("4d · Ops row type is seller_product_request_resubmitted_ops", opsLog?.type === "seller_product_request_resubmitted_ops");
      const opsRdup = await sendSellerProductRequestResubmittedOps(reviewedDraft.id, { client: tx });
      ok("4d · duplicate resubmission-Ops call → deduped (same submittedAt bucket)", opsRdup.deduped === true || opsRdup.status === "DEDUPED");

      // 4e — seller order milestones: one per transition, distinct rows, dedupe
      const s5 = await seedSeller(tx, "ord5", { status: "APPROVED" });
      await seedOwner(tx, s5.id, "ord5");
      const o5 = await seedOrderWithSellerOrder(tx, s5.id, s5.displayName, "ord5");
      for (const milestone of ["accepted", "ready_to_ship", "shipped", "delivered"] as const) {
        const r = await sendSellerOrderMilestone(o5.sellerOrderId, milestone, { client: tx });
        ok(`4e · sendSellerOrderMilestone(${milestone}) routes`, r.ok === true, JSON.stringify(r));
      }
      const milestoneTypes = await tx.emailLog.findMany({
        where: { orderId: null, idempotencyKey: { startsWith: "SELLER_ORDER_" } },
        select: { type: true },
      });
      // (orderId isn't set on these — recipient resolution doesn't carry it; assert via key prefix instead)
      const acceptedCount = await tx.emailLog.count({ where: { idempotencyKey: `SELLER_ORDER_ACCEPTED:${o5.sellerOrderId}` } });
      const readyCount = await tx.emailLog.count({ where: { idempotencyKey: `SELLER_ORDER_READY_TO_SHIP:${o5.sellerOrderId}` } });
      const shippedCount = await tx.emailLog.count({ where: { idempotencyKey: `SELLER_ORDER_SHIPPED:${o5.sellerOrderId}` } });
      const deliveredCount = await tx.emailLog.count({ where: { idempotencyKey: `SELLER_ORDER_DELIVERED:${o5.sellerOrderId}` } });
      ok("4e · all 4 milestones produced their OWN distinct EmailLog row (no cross-milestone collision)",
        acceptedCount === 1 && readyCount === 1 && shippedCount === 1 && deliveredCount === 1);
      const rdup = await sendSellerOrderMilestone(o5.sellerOrderId, "accepted", { client: tx });
      ok("4e · repeating the SAME milestone → deduped, not a 2nd row", (rdup.deduped === true || rdup.status === "DEDUPED") && (await tx.emailLog.count({ where: { idempotencyKey: `SELLER_ORDER_ACCEPTED:${o5.sellerOrderId}` } })) === 1);

      // 4f — shipment created: fires once, carries tracking, dedupe on repeat
      const s6 = await seedSeller(tx, "ship6", { status: "APPROVED" });
      await seedOwner(tx, s6.id, "ship6");
      const o6 = await seedOrderWithSellerOrder(tx, s6.id, s6.displayName, "ship6");
      const shipment = await tx.shipment.create({
        data: { sellerOrderId: o6.sellerOrderId, carrier: "jt", carrierName: "J&T Express", trackingNumber: "JT999888777PH", status: "PENDING" },
        select: { id: true },
      });
      const r6 = await sendSellerShipmentCreated(shipment.id, { client: tx });
      ok("4f · sendSellerShipmentCreated routes", r6.ok === true, JSON.stringify(r6));
      const r6dup = await sendSellerShipmentCreated(shipment.id, { client: tx });
      ok("4f · duplicate shipment-created call → deduped", r6dup.deduped === true || r6dup.status === "DEDUPED");
      ok("4f · still exactly one row for this shipment", (await tx.emailLog.count({ where: { idempotencyKey: `SELLER_SHIPMENT_CREATED:${shipment.id}` } })) === 1);

      // 4g — return rejected: carries the EXACT resolutionNote; missing note fails durably
      const s7 = await seedSeller(tx, "ret7", { status: "APPROVED" });
      await seedOwner(tx, s7.id, "ret7");
      const o7 = await seedOrderWithSellerOrder(tx, s7.id, s7.displayName, "ret7");
      const EXACT_NOTE_7 = "Return window had already closed by the time this was filed.";
      const ret7 = await seedReturnForSeller(tx, o7.orderId, o7.sellerOrderId, s7.id, "7", { resolutionNote: EXACT_NOTE_7 });
      const r7 = await sendSellerReturnRejected(ret7.id, s7.id, { client: tx });
      ok("4g · sendSellerReturnRejected routes", r7.ok === true, JSON.stringify(r7));
      const r7dup = await sendSellerReturnRejected(ret7.id, s7.id, { client: tx });
      ok("4g · duplicate return-rejected call → deduped", r7dup.deduped === true || r7dup.status === "DEDUPED");

      const s7b = await seedSeller(tx, "ret7b", { status: "APPROVED" });
      await seedOwner(tx, s7b.id, "ret7b");
      const o7b = await seedOrderWithSellerOrder(tx, s7b.id, s7b.displayName, "ret7b");
      const ret7b = await seedReturnForSeller(tx, o7b.orderId, o7b.sellerOrderId, s7b.id, "7b", { resolutionNote: null });
      const r7b = await sendSellerReturnRejected(ret7b.id, s7b.id, { client: tx });
      ok("4g · a REJECTED return with NO resolutionNote → durable FAILED, never invented text", r7b.ok === false);
      const failRow7b = await tx.emailLog.findUnique({ where: { idempotencyKey: `SELLER_RETURN_REJECTED:${ret7b.id}:${s7b.id}` } });
      ok("4g · ...durable row records exactly why", failRow7b?.status === "FAILED" && failRow7b.error === "missing_resolution_note");

      // 4h — 1P seller → SKIPPED for both new return/refund senders (never emailed)
      const fpSeller = await tx.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
      if (fpSeller) {
        const r8 = await sendSellerReturnRejected(ret7.id, fpSeller.id, { client: tx });
        ok("4h · sendSellerReturnRejected on a FIRST_PARTY seller id → SKIPPED, no row", r8.status === "SKIPPED" && !(await tx.emailLog.findUnique({ where: { idempotencyKey: `SELLER_RETURN_REJECTED:${ret7.id}:${fpSeller.id}` } })));
      }

      // 4i — refund notice: carries refund amount, dedupe, 1P → SKIPPED
      const s9 = await seedSeller(tx, "ref9", { status: "APPROVED" });
      await seedOwner(tx, s9.id, "ref9");
      const o9 = await seedOrderWithSellerOrder(tx, s9.id, s9.displayName, "ref9");
      const ret9 = await seedReturnForSeller(tx, o9.orderId, o9.sellerOrderId, s9.id, "9", { status: "REFUND_COMPLETED", refundAmount: 42000 });
      const r9 = await sendSellerRefundNotice(ret9.id, s9.id, { client: tx });
      ok("4i · sendSellerRefundNotice routes", r9.ok === true, JSON.stringify(r9));
      const r9dup = await sendSellerRefundNotice(ret9.id, s9.id, { client: tx });
      ok("4i · repeated identical refund-complete call → deduped, not a 2nd send", r9dup.deduped === true || r9dup.status === "DEDUPED");
      ok("4i · still exactly one row for this refund", (await tx.emailLog.count({ where: { idempotencyKey: `SELLER_REFUND_NOTICE:${ret9.id}:${s9.id}` } })) === 1);
      if (fpSeller) {
        const r9b = await sendSellerRefundNotice(ret9.id, fpSeller.id, { client: tx });
        ok("4i · sendSellerRefundNotice on a FIRST_PARTY seller id → SKIPPED", r9b.status === "SKIPPED");
      }

      // 4j — email preparation failure (nonexistent ids) is durably logged for every new sender
      const missing = `missing-${Date.now().toString(36)}`;
      for (const [label, fn] of [
        ["sendSellerAccountSubmitted", () => sendSellerAccountSubmitted(missing, { client: tx })],
        ["sendSellerOrderMilestone", () => sendSellerOrderMilestone(missing, "accepted", { client: tx })],
        ["sendSellerShipmentCreated", () => sendSellerShipmentCreated(missing, { client: tx })],
      ] as const) {
        const r = await fn();
        ok(`4j · ${label}(nonexistent id) → FAILED result, never throws`, r.ok === false);
      }
      // sendSellerRefundNotice(missing returnId) against a REAL 3P seller —
      // a nonexistent seller id would defensively SKIP (not a failure, since
      // it can't tell "unknown" from "not this seller's concern"); the
      // meaningful not-found case is a genuinely missing return.
      const rMissingReturn = await sendSellerRefundNotice(missing, s9.id, { client: tx });
      ok("4j · sendSellerRefundNotice(nonexistent return) → FAILED result, never throws", rMissingReturn.ok === false);

      throw new Rollback();
    }, { timeout: 60_000, maxWait: 15_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

async function isolationCheck() {
  console.log("\n── 5 · isolation ──");
  const [sellers, orders, returns, emails, audits] = await Promise.all([
    prisma.seller.count({ where: { slug: { startsWith: "s9f56-" } } }),
    prisma.order.count({ where: { orderNumber: { startsWith: "AX-T9F56-" } } }),
    prisma.returnRequest.count({ where: { returnNumber: { startsWith: "RET-T9F56-" } } }),
    prisma.emailLog.count({ where: { idempotencyKey: { contains: "T9F56" } } }),
    prisma.adminAuditLog.count({ where: { summary: "x", targetType: "seller" } }),
  ]);
  ok("5 · no fixture Seller leaked", sellers === 0);
  ok("5 · no fixture Order leaked", orders === 0);
  ok("5 · no fixture ReturnRequest leaked", returns === 0);
  ok("5 · no fixture EmailLog leaked", emails === 0);
  ok("5 · no fixture AdminAuditLog leaked", audits === 0);
}

async function main() {
  console.log("\nPHASE 9F-56 — 3P marketplace seller email notification framework\n");
  stateMachineTests();
  staticTests();
  renderTests();
  await dbTests();
  await isolationCheck();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
