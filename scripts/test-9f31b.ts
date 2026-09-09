/**
 * PHASE 9F-31B — fix the two remaining 1P+3P email gaps found by 9F-31A.
 *
 *  P1  The "we're preparing your order" email (`order_processing`) no longer
 *      fires from the checkout 3P-COD auto-confirm branch (the SellerOrder is
 *      still PENDING_PAYMENT there — nothing is being packed). It now fires from
 *      `advanceSellerOrderAction` on the seller-accept transition
 *      (SellerOrder PENDING_PAYMENT → PROCESSING). Same `ORDER_PROCESSING:<orderId>`
 *      key ⇒ still one send per order. 1P (admin confirm / status→PROCESSING)
 *      unchanged.
 *
 *  P2  New `seller_return_requested` — one email per affected THIRD_PARTY seller
 *      the moment a return is CREATED (customer self-service OR admin-assisted).
 *      FIRST_PARTY lines are skipped. No customer PII. Retryable, idempotency
 *      key `SELLER_RETURN_REQUESTED:<returnId>:<sellerId>`.
 *
 * DB tests build fixtures inside ONE prisma.$transaction and roll back. The local
 * env has NO EMAIL_* config, so `dispatchEmail` returns SKIPPED and never sends —
 * the senders are safe to call with `{ client: tx }` (same posture as test-9f14).
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f31b.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient, Prisma } from "@prisma/client";
import { advanceSellerOrderStatus } from "@/lib/marketplace/seller-order-repository";
import {
  sendSellerReturnRequested,
  getReturnAffectedSellerIds,
  retryEmailByLog,
} from "@/lib/email/notifications";
import { dispatchEmail } from "@/lib/email/send";
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
  sellerId,
  sellerName,
  sellerUserId: "su-" + sellerId,
  userId: "u-" + sellerId,
  role: "OWNER" as SellerContext["role"],
  permissions: new Set(["manage_seller_fulfillment"]),
});

// ── static wiring ───────────────────────────────────────────────────────
function staticTests() {
  console.log("\n── static wiring ──");
  const checkout = read("src/lib/checkout.ts");
  const sellerActions = read("src/lib/seller/order-actions.ts");
  const adminOrderActions = read("src/lib/admin/order-actions.ts");
  const repo = read("src/lib/marketplace/seller-order-repository.ts");
  const send = read("src/lib/email/send.ts");
  const notif = read("src/lib/email/notifications.ts");
  const tpl = read("src/lib/email/templates/seller-order-notifications.ts");
  const custReturns = read("src/lib/returns-actions.ts");
  const adminReturns = read("src/lib/admin/returns-actions.ts");

  // ── P1 ──
  ok("P1 · checkout NO LONGER imports or calls sendOrderProcessing",
    !/sendOrderProcessing/.test(checkout));
  ok("P1 · checkout auto-confirm block still writes the order.confirmed audit (system actor, trigger tag)",
    /if \(autoConfirmParent\) \{[\s\S]{0,400}action: "order\.confirmed",[\s\S]{0,400}trigger: "checkout_3p_cod_autoconfirm"/.test(checkout));
  ok("P1 · checkout still fires order confirmation + ops + seller-new-order, unchanged",
    /scheduleEmail\(\(\) => sendOrderConfirmation\(created\.id\)\)/.test(checkout) &&
    /scheduleEmail\(\(\) => sendOrderReceivedOps\(created\.id\)\)/.test(checkout) &&
    /scheduleEmail\(\(\) => sendSellerOrderReceived\(created\.id\)\)/.test(checkout));
  ok("P1 · advanceSellerOrderAction sends order_processing ONLY on PENDING_PAYMENT → PROCESSING",
    /if \(res\.from === "PENDING_PAYMENT" && parsed\.data\.to === "PROCESSING"\) \{[\s\S]{0,260}scheduleEmail\(\(\) => sendOrderProcessing\(res\.orderId\)\)/.test(sellerActions));
  ok("P1 · that block also revalidates the customer order pages (timeline rung changes on accept)",
    /if \(res\.from === "PENDING_PAYMENT" && parsed\.data\.to === "PROCESSING"\) \{[\s\S]{0,200}revalidateOrderPaths\(res\.orderNumber, res\.orderId\)/.test(sellerActions));
  ok("P1 · repo result now carries orderId + orderNumber on every successful advance",
    /ok: true;\s*\n\s*status: SellerOrderStatus;\s*\n\s*from: SellerOrderStatus;[\s\S]{0,200}orderId: string;\s*\n\s*orderNumber: string;/.test(repo) &&
    /orderId: so\.order\.id,\s*\n\s*orderNumber: so\.order\.orderNumber,/.test(repo));
  ok("P1 · 1P admin path UNCHANGED — still sends order_processing on confirm + status→PROCESSING",
    (adminOrderActions.match(/scheduleEmail\(\(\) => sendOrderProcessing\(orderId\)\)/g) ?? []).length === 2);
  ok("P1 · order_processing sender + ORDER_PROCESSING:<orderId> key unchanged (single-send mechanism)",
    /idempotencyKey: `ORDER_PROCESSING:\$\{order\.id\}`/.test(notif));
  ok("P1 · no new EmailType for the processing email (sendOrderProcessing already exists)",
    !/order_processing_3p|seller_order_processing/.test(send));

  // ── P2 ──
  ok("P2 · send.ts adds the seller_return_requested EmailType",
    /\| "seller_return_requested"/.test(send));
  ok("P2 · template renderSellerReturnRequested exists and carries NO customer PII",
    /export function renderSellerReturnRequested/.test(tpl) &&
    !/customerName|customerEmail|customerNote|\bphone\b|shippingAddress|firstName|lastName/.test(
      tpl.slice(tpl.indexOf("renderSellerReturnRequested"), tpl.indexOf("renderSellerReturnRequested") + 2200),
    ));
  ok("P2 · sender guards FIRST_PARTY → SKIPPED (Axiaro has no seller mailbox), before dispatch",
    /const seller = await db\.seller\.findUnique\(\{ where: \{ id: sellerId \}, select: \{ type: true \} \}\);\s*\n\s*if \(seller\?\.type !== "THIRD_PARTY"\) return \{ ok: true, skipped: true, status: "SKIPPED" \};/.test(notif));
  ok("P2 · sender reuses loadSellerLifecycleEmailContext (existing recipient resolution), from SECURITY_FROM",
    /sendSellerReturnRequested[\s\S]{0,1400}loadSellerLifecycleEmailContext\(sellerId/.test(notif) &&
    /type: "seller_return_requested",\s*\n\s*to: ctx\.recipients,\s*\n\s*from: SECURITY_FROM/.test(notif));
  ok("P2 · idempotency key SELLER_RETURN_REQUESTED:<returnId>:<sellerId>",
    /idempotencyKey: opts\.idempotencyKey \?\? `SELLER_RETURN_REQUESTED:\$\{returnId\}:\$\{sellerId\}`/.test(notif));
  ok("P2 · sender selects only its own seller's return lines (orderItem.sellerId scoped)",
    /returnItem\.findMany\(\{\s*\n\s*where: \{ returnRequestId: returnId, orderItem: \{ sellerId \} \}/.test(notif));
  ok("P2 · retry-switch case present, parses both ids back out of the key",
    /case "seller_return_requested": \{[\s\S]{0,320}sendSellerReturnRequested\(returnId, sellerId, \{ retry: true, idempotencyKey: log\.idempotencyKey, client: tx \}\)/.test(notif));
  ok("P2 · fired from the CUSTOMER return-request path, one per affected seller",
    /const affectedSellerIds = await getReturnAffectedSellerIds\(created\.id\);\s*\n\s*for \(const sellerId of affectedSellerIds\) \{\s*\n\s*scheduleEmail\(\(\) => sendSellerReturnRequested\(created\.id, sellerId\)\)/.test(custReturns));
  ok("P2 · fired from the ADMIN-ASSISTED return-create path, one per affected seller",
    /const affectedSellerIds = await getReturnAffectedSellerIds\(created\.id\);\s*\n\s*for \(const sellerId of affectedSellerIds\) \{\s*\n\s*scheduleEmail\(\(\) => sendSellerReturnRequested\(created\.id, sellerId\)\)/.test(adminReturns));
  ok("P2 · NOT added: seller_return_approved / seller_return_rejected / new settlement|refund|payment emails",
    !/seller_return_approved|seller_return_rejected/.test(send) &&
    !/9F-31B/.test(read("src/lib/admin/settlement-actions.ts")));

  // ── scope ──
  ok("scope · order status rules untouched", !/9F-31B/.test(read("src/lib/orders/status.ts")) && !/9F-31B/.test(read("src/lib/marketplace/seller-order-status.ts")));
  ok("scope · returns workflow untouched beyond the new notification (no status/refund/restock change)",
    !/9F-31B/.test(read("src/lib/returns/status.ts")) && !/9F-31B/.test(read("src/lib/returns.ts")));
  ok("scope · email pipeline (send.ts dispatchEmail / claim / retry mechanism) not restructured",
    /createMany\(\{\s*\n?\s*data: \[/.test(send) && /skipDuplicates: true/.test(send));
  ok("scope · no schema change", !/9F-31B/.test(read("prisma/schema.prisma")));
  ok("scope · seed-rbac.ts untouched", !/9F-31B/.test(read("scripts/seed-rbac.ts")));
}

// ── DB behaviour (rolled-back fixtures) ─────────────────────────────────
async function dbTests() {
  console.log("\n── DB (fixtures rolled back; local env has no EMAIL_* → dispatch is SKIPPED) ──");
  const category = await prisma.category.findFirst({ select: { id: true } });
  if (!category) { ok("(skipped — no category)", true); return; }
  const firstParty = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
  const sfx = "9f31b-" + String(Date.now()).slice(-7);

  const emailBefore = await prisma.emailLog.count();
  const orderEventsBefore = await prisma.orderEvent.count();

  async function seedSeller(tx: Prisma.TransactionClient, n: string, withUser: boolean) {
    const seller = await tx.seller.create({
      data: { type: "THIRD_PARTY", status: "APPROVED", displayName: `${n} ${sfx}`, slug: `${n.toLowerCase()}-${sfx}-${Math.random().toString(36).slice(2, 6)}`, supportEmail: "s@t.test", notifyEmail: withUser ? `notify-${n}-${sfx}@t.test` : null },
      select: { id: true },
    });
    if (withUser) {
      const user = await tx.user.create({ data: { email: `owner-${n}-${sfx}@t.test`, name: "Owner" }, select: { id: true } });
      await tx.sellerUser.create({ data: { sellerId: seller.id, userId: user.id, role: "OWNER", status: "ACTIVE" } });
    }
    return seller.id;
  }
  async function seedProductForSeller(tx: Prisma.TransactionClient) {
    const product = await tx.product.create({
      data: { name: `P ${sfx}`, slug: `p-${sfx}-${Math.random().toString(36).slice(2, 7)}`, shortDescription: "s", description: "d", categoryId: category!.id, status: "ACTIVE", price: 1000 },
      select: { id: true },
    });
    return product.id;
  }

  try {
    await prisma.$transaction(async (tx) => {
      const buyer = await tx.user.create({ data: { email: `buyer-${sfx}@t.test`, name: "Buyer" }, select: { id: true } });

      // ── P1 · advanceSellerOrderStatus returns orderId + orderNumber ──────
      {
        const sellerId = await seedSeller(tx, "S1", false);
        const productId = await seedProductForSeller(tx);
        const order = await tx.order.create({
          data: { orderNumber: `AX-T31B-${sfx}`, email: "b@e.test", phone: "+630", status: "PROCESSING", paymentStatus: "PENDING", paymentMethod: "COD", subtotal: 1000, grandTotal: 1150, shippingFee: 150, shippingAddress: "{}" },
          select: { id: true, orderNumber: true },
        });
        const so = await tx.sellerOrder.create({
          data: { orderId: order.id, sellerId, sellerName: "S", sellerType: "THIRD_PARTY", supportEmail: "s@t.test", merchandiseSubtotal: 1000, shippingFee: 150, total: 1150, status: "PENDING_PAYMENT" },
          select: { id: true },
        });
        await tx.orderItem.create({ data: { orderId: order.id, sellerOrderId: so.id, sellerId, productId, name: "Item", unitPrice: 1000, quantity: 1, lineTotal: 1000 } });

        const r = await advanceSellerOrderStatus(ctxFor(sellerId), so.id, "PROCESSING", tx);
        ok("P1 · seller accept (PENDING_PAYMENT → PROCESSING) succeeds", r.ok === true, JSON.stringify(r));
        ok("P1 · result carries the parent orderId + orderNumber (for the sendOrderProcessing trigger)",
          r.ok === true && r.orderId === order.id && r.orderNumber === order.orderNumber);
        ok("P1 · result.from = PENDING_PAYMENT (the branch the action gates the email on)",
          r.ok === true && r.from === "PENDING_PAYMENT");
        ok("P1 · NOT a parent rollup (parent already PROCESSING) — no shipped/delivered email path",
          r.ok === true && r.parentOrder === undefined);
      }

      // ── P1 · ORDER_PROCESSING:<orderId> can't double-send (dispatch dedupe) ──
      {
        const key = `ORDER_PROCESSING:ord-${sfx}`;
        const d1 = await dispatchEmail({ type: "order_processing", to: "x@t.test", subject: "s", html: "h", text: "t", idempotencyKey: key, client: tx });
        const d2 = await dispatchEmail({ type: "order_processing", to: "x@t.test", subject: "s", html: "h", text: "t", idempotencyKey: key, client: tx });
        ok("P1 · first dispatch records a row (SKIPPED — no SMTP in test env)", d1.status === "SKIPPED");
        ok("P1 · second dispatch on the same ORDER_PROCESSING key is DEDUPED (never a 2nd send)", d2.status === "DEDUPED");
        ok("P1 · exactly one EmailLog row for that key", (await tx.emailLog.count({ where: { idempotencyKey: key } })) === 1);
      }

      // ── P2 · seller_return_requested — THIRD_PARTY happy path ────────────
      {
        const sellerId = await seedSeller(tx, "S2", true);
        const productId = await seedProductForSeller(tx);
        const order = await tx.order.create({
          data: { orderNumber: `AX-T31B-R-${sfx}`, email: "buyer@e.test", phone: "+630", status: "DELIVERED", paymentStatus: "PENDING", paymentMethod: "COD", subtotal: 1000, grandTotal: 1000, shippingFee: 0, shippingAddress: "{}", userId: buyer.id },
          select: { id: true, orderNumber: true },
        });
        const so = await tx.sellerOrder.create({ data: { orderId: order.id, sellerId, sellerName: "S", sellerType: "THIRD_PARTY", supportEmail: "s@t.test", merchandiseSubtotal: 1000, total: 1000, status: "DELIVERED" }, select: { id: true } });
        const oi = await tx.orderItem.create({ data: { orderId: order.id, sellerOrderId: so.id, sellerId, productId, name: "Wool scarf", variantLabel: "Grey", unitPrice: 1000, quantity: 2, lineTotal: 2000 }, select: { id: true } });
        const ret = await tx.returnRequest.create({
          data: { returnNumber: `RMA-${sfx}`, orderId: order.id, userId: buyer.id, status: "REQUESTED", reason: "DEFECTIVE", items: { create: [{ orderItemId: oi.id, productId, name: "Wool scarf", variantLabel: "Grey", unitPrice: 1000, quantity: 1, refundAmount: 1000 }] } },
          select: { id: true, returnNumber: true },
        });

        const affected = await getReturnAffectedSellerIds(ret.id, tx);
        ok("P2 · getReturnAffectedSellerIds returns the 3P seller", affected.includes(sellerId));

        const r = await sendSellerReturnRequested(ret.id, sellerId, { client: tx });
        ok("P2 · THIRD_PARTY seller with recipients → dispatched (SKIPPED, no SMTP) not FAILED", r.status === "SKIPPED" && r.ok === true, JSON.stringify(r));
        const row = await tx.emailLog.findUnique({ where: { idempotencyKey: `SELLER_RETURN_REQUESTED:${ret.id}:${sellerId}` }, select: { type: true, recipient: true, status: true } });
        ok("P2 · one EmailLog row, type seller_return_requested, to the resolved seller recipients (OWNER user + notifyEmail, deduped)",
          row?.type === "seller_return_requested" && row?.status === "SKIPPED" &&
          /owner-s2-/i.test(row?.recipient ?? "") && /notify-s2-/i.test(row?.recipient ?? ""), JSON.stringify(row));

        // idempotency
        const r2 = await sendSellerReturnRequested(ret.id, sellerId, { client: tx });
        ok("P2 · repeat call is DEDUPED — no second seller notification", r2.status === "DEDUPED");
        ok("P2 · still exactly one row for the key", (await tx.emailLog.count({ where: { idempotencyKey: `SELLER_RETURN_REQUESTED:${ret.id}:${sellerId}` } })) === 1);

        // retry
        await tx.emailLog.update({ where: { idempotencyKey: `SELLER_RETURN_REQUESTED:${ret.id}:${sellerId}` }, data: { status: "FAILED", error: "test" } });
        const rr = await retryEmailByLog((await tx.emailLog.findUniqueOrThrow({ where: { idempotencyKey: `SELLER_RETURN_REQUESTED:${ret.id}:${sellerId}` }, select: { id: true } })).id, tx);
        ok("P2 · retryEmailByLog routes seller_return_requested (re-dispatches, reuses the row)",
          (rr.status === "SKIPPED" || rr.status === "SENT" || rr.status === "DEDUPED") &&
          (await tx.emailLog.count({ where: { idempotencyKey: `SELLER_RETURN_REQUESTED:${ret.id}:${sellerId}` } })) === 1);
      }

      // ── P2 · FIRST_PARTY line → NO seller_return_requested ──────────────
      if (firstParty) {
        const productId = await seedProductForSeller(tx);
        const order = await tx.order.create({
          data: { orderNumber: `AX-T31B-FP-${sfx}`, email: "b@e.test", phone: "+630", status: "DELIVERED", paymentStatus: "PENDING", paymentMethod: "COD", subtotal: 1000, grandTotal: 1000, shippingFee: 0, shippingAddress: "{}" },
          select: { id: true },
        });
        const so = await tx.sellerOrder.create({ data: { orderId: order.id, sellerId: firstParty.id, sellerName: "Axiaro", sellerType: "FIRST_PARTY", supportEmail: "o@t.test", merchandiseSubtotal: 1000, total: 1000, status: "DELIVERED" }, select: { id: true } });
        const oi = await tx.orderItem.create({ data: { orderId: order.id, sellerOrderId: so.id, sellerId: firstParty.id, productId, name: "1P item", unitPrice: 1000, quantity: 1, lineTotal: 1000 }, select: { id: true } });
        const ret = await tx.returnRequest.create({ data: { returnNumber: `RMA-FP-${sfx}`, orderId: order.id, userId: buyer.id, status: "REQUESTED", reason: "DEFECTIVE", items: { create: [{ orderItemId: oi.id, productId, name: "1P item", unitPrice: 1000, quantity: 1, refundAmount: 1000 }] } }, select: { id: true } });

        const r = await sendSellerReturnRequested(ret.id, firstParty.id, { client: tx });
        ok("P2 · FIRST_PARTY seller → SKIPPED via the guard, NO EmailLog row written",
          r.status === "SKIPPED" && r.ok === true &&
          (await tx.emailLog.count({ where: { idempotencyKey: `SELLER_RETURN_REQUESTED:${ret.id}:${firstParty.id}` } })) === 0);
      } else {
        ok("P2 · (skipped FIRST_PARTY case — no FIRST_PARTY seller in DB)", true);
      }

      // ── P2 · multi-seller return → one email per THIRD_PARTY seller ──────
      {
        const sA = await seedSeller(tx, "MA", true);
        const sB = await seedSeller(tx, "MB", true);
        const pA = await seedProductForSeller(tx);
        const pB = await seedProductForSeller(tx);
        const order = await tx.order.create({ data: { orderNumber: `AX-T31B-MS-${sfx}`, email: "b@e.test", phone: "+630", status: "DELIVERED", paymentStatus: "PENDING", paymentMethod: "COD", subtotal: 2000, grandTotal: 2000, shippingFee: 0, shippingAddress: "{}" }, select: { id: true } });
        const soA = await tx.sellerOrder.create({ data: { orderId: order.id, sellerId: sA, sellerName: "A", sellerType: "THIRD_PARTY", supportEmail: "a@t.test", merchandiseSubtotal: 1000, total: 1000, status: "DELIVERED" }, select: { id: true } });
        const soB = await tx.sellerOrder.create({ data: { orderId: order.id, sellerId: sB, sellerName: "B", sellerType: "THIRD_PARTY", supportEmail: "b@t.test", merchandiseSubtotal: 1000, total: 1000, status: "DELIVERED" }, select: { id: true } });
        const oiA = await tx.orderItem.create({ data: { orderId: order.id, sellerOrderId: soA.id, sellerId: sA, productId: pA, name: "A item", unitPrice: 1000, quantity: 1, lineTotal: 1000 }, select: { id: true } });
        const oiB = await tx.orderItem.create({ data: { orderId: order.id, sellerOrderId: soB.id, sellerId: sB, productId: pB, name: "B item", unitPrice: 1000, quantity: 1, lineTotal: 1000 }, select: { id: true } });
        const ret = await tx.returnRequest.create({ data: { returnNumber: `RMA-MS-${sfx}`, orderId: order.id, userId: buyer.id, status: "REQUESTED", reason: "CHANGED_MIND", items: { create: [
          { orderItemId: oiA.id, productId: pA, name: "A item", unitPrice: 1000, quantity: 1, refundAmount: 1000 },
          { orderItemId: oiB.id, productId: pB, name: "B item", unitPrice: 1000, quantity: 1, refundAmount: 1000 },
        ] } }, select: { id: true } });

        const affected = await getReturnAffectedSellerIds(ret.id, tx);
        ok("P2 · multi-seller return → getReturnAffectedSellerIds returns BOTH 3P sellers", affected.length === 2 && affected.includes(sA) && affected.includes(sB));
        for (const sid of affected) await sendSellerReturnRequested(ret.id, sid, { client: tx });
        const rows = await tx.emailLog.count({ where: { type: "seller_return_requested", idempotencyKey: { contains: ret.id } } });
        ok("P2 · one distinct seller_return_requested row per affected seller (2)", rows === 2);
      }

      throw new Rollback();
    }, { timeout: 120000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("ROLLBACK · no EmailLog leaked", (await prisma.emailLog.count()) === emailBefore);
  ok("ROLLBACK · no OrderEvent leaked", (await prisma.orderEvent.count()) === orderEventsBefore);
  ok("ROLLBACK · no fixture seller leaked", (await prisma.seller.count({ where: { slug: { contains: sfx } } })) === 0);
}

async function main() {
  console.log("\nPHASE 9F-31B — fix remaining 1P + 3P email gaps\n");
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
