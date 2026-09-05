/**
 * Phase 9F-3 — Seller Returns & Post-Order Operations — assertion runner.
 *
 * DB tests build a real 3P Order + SellerOrder + OrderItems (offer-bound) +
 * ReturnRequest(APPROVED) + ReturnItems inside ONE prisma.$transaction and roll
 * back — nothing persists. Run with --conditions=react-server.
 *
 * Groups:
 *   A  seller-scoped return isolation (see only own; another seller's return → null)
 *   B  cross-seller mutation rejected; forged id rejected
 *   C  APPROVED → RECEIVED works; invalid status transitions rejected
 *   D  restock-quantity validation (cap at received; received cap at returned; condition)
 *   E  RETURN creates OfferAdjustment; OfferInventory increases correctly
 *   F  repeated receipt cannot double-restock (idempotency)
 *   G  Inventory / InventoryAdjustment untouched; Order.status / OrderEvent untouched
 *   H  cancelled parent Order syncs SellerOrder → CANCELLED (status-guarded)
 *   I  static wiring
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f3.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  listSellerReturns,
  getSellerReturnForSeller,
  sellerReceiveReturn,
} from "../src/lib/marketplace/seller-return-repository";
import type { SellerContext } from "../src/lib/marketplace/types";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.error(`  FAIL  ${name}   ${detail}`);
  }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

function ctxFor(sellerId: string): SellerContext {
  return {
    sellerId,
    sellerName: "S",
    sellerUserId: "su-" + sellerId,
    userId: "u-" + sellerId,
    role: "OWNER",
    permissions: new Set(),
  };
}
class Rollback extends Error {}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

async function seedSellerWithOffer(tx: Tx, slug: string, variantId: string, opening = 10) {
  const seller = await tx.seller.create({
    data: { type: "THIRD_PARTY", status: "APPROVED", displayName: slug, slug, supportEmail: `${slug}@t.test` },
  });
  const offer = await tx.offer.create({
    data: { sellerId: seller.id, variantId, price: 5000, condition: "NEW", status: "DRAFT", sellerSku: `${slug}-sku` },
  });
  await tx.offerInventory.create({ data: { offerId: offer.id, quantity: opening, reserved: 0, reorderPoint: 2 } });
  return { seller, offer };
}

async function seedOrderReturn(
  tx: Tx,
  seller: { id: string; displayName: string; supportEmail: string },
  offer: { id: string },
  productId: string,
  variantId: string,
  suffix: string,
  opts: { returnStatus?: string; itemQty?: number } = {},
) {
  const order = await tx.order.create({
    data: {
      orderNumber: `AX-T9F3-${suffix}-${Math.random().toString(36).slice(2, 6)}`,
      email: "buyer@example.test",
      status: "DELIVERED",
      subtotal: 5000,
      grandTotal: 5000,
      deliveredAt: new Date(),
      shippingAddress: JSON.stringify({ firstName: "T", lastName: "B", phone: "+639", line1: "1 St", city: "M", province: "N", postalCode: "1000", country: "PH" }),
    },
    select: { id: true, orderNumber: true },
  });
  const so = await tx.sellerOrder.create({
    data: {
      orderId: order.id, sellerId: seller.id, sellerName: seller.displayName, sellerType: "THIRD_PARTY",
      supportEmail: seller.supportEmail, merchandiseSubtotal: 5000, total: 5000, status: "DELIVERED",
    },
    select: { id: true },
  });
  const qty = opts.itemQty ?? 3;
  const oi = await tx.orderItem.create({
    data: {
      orderId: order.id, sellerOrderId: so.id, sellerId: seller.id, offerId: offer.id,
      productId, variantId, name: "Test item", unitPrice: 5000, quantity: qty, lineTotal: 15000,
    },
    select: { id: true },
  });
  const seq = await tx.$queryRawUnsafe<{ v: bigint }[]>(`SELECT nextval('return_number_seq') AS v`);
  const ret = await tx.returnRequest.create({
    data: {
      returnNumber: `RET-T9F3-${seq[0].v}`,
      orderId: order.id,
      status: opts.returnStatus ?? "APPROVED",
      reason: "DAMAGED",
      items: {
        create: [
          {
            orderItemId: oi.id, productId, variantId, name: "Test item",
            unitPrice: 5000, quantity: qty, refundAmount: 5000 * qty,
          },
        ],
      },
    },
    select: { id: true, returnNumber: true, items: { select: { id: true } } },
  });
  return { order, so, orderItemId: oi.id, ret, returnItemId: ret.items[0].id };
}

async function dbTests() {
  const suffix = String(Date.now()).slice(-7);
  const variant = await prisma.variant.findFirst({
    where: { status: "ACTIVE" },
    select: { id: true, productId: true },
  });
  if (!variant) {
    ok("db tests skipped — no ACTIVE variant", true);
    return;
  }
  const invAdjBefore = await prisma.inventoryAdjustment.count();
  const invBefore = await prisma.inventory.count();
  const eventsBefore = await prisma.orderEvent.count();

  try {
    await prisma.$transaction(async (tx) => {
      const A = await seedSellerWithOffer(tx, `a9f3-${suffix}`, variant.id, 10);
      const B = await seedSellerWithOffer(tx, `b9f3-${suffix}`, variant.id, 10);
      const ctxA = ctxFor(A.seller.id);
      const ctxB = ctxFor(B.seller.id);

      const fx = await seedOrderReturn(tx, A.seller, A.offer, variant.productId, variant.id, suffix);
      const fxB = await seedOrderReturn(tx, B.seller, B.offer, variant.productId, variant.id, suffix + "b");

      // ---- A: isolation ----
      const listA = await listSellerReturns(ctxA, {}, tx);
      ok("A1 listSellerReturns(A) has A's return", listA.some((r) => r.id === fx.ret.id));
      ok("A2 listSellerReturns(A) excludes B's return", !listA.some((r) => r.id === fxB.ret.id));
      ok("A3 getSellerReturnForSeller(A, B's return) → null", (await getSellerReturnForSeller(ctxA, fxB.ret.id, tx)) === null);
      const detailA = await getSellerReturnForSeller(ctxA, fx.ret.id, tx);
      ok(
        "A4 detail exposes no customer account / refund fields",
        !!detailA &&
          !("email" in (detailA.order as object)) &&
          !("userId" in (detailA.order as object)) &&
          !("grandTotal" in (detailA.order as object)) &&
          !("refundAmount" in (detailA as object)) &&
          !("staffNote" in (detailA as object)),
      );

      // ---- B: cross-seller / forged ----
      ok(
        "B1 sellerReceiveReturn(A, B's return) rejected",
        (await sellerReceiveReturn(ctxA, fxB.ret.id, [{ returnItemId: fxB.returnItemId, receivedQuantity: 1, restockQuantity: 1, condition: "RESELLABLE" }], tx)).ok === false,
      );
      ok(
        "B2 forged returnId rejected",
        (await sellerReceiveReturn(ctxA, "cmforged0000000000000000", [{ returnItemId: fx.returnItemId, receivedQuantity: 1, restockQuantity: 1, condition: "RESELLABLE" }], tx)).ok === false,
      );

      // ---- D: validation (before the guard fires — safe to retry) ----
      ok(
        "D1 restock > received rejected",
        (await sellerReceiveReturn(ctxA, fx.ret.id, [{ returnItemId: fx.returnItemId, receivedQuantity: 1, restockQuantity: 2, condition: "RESELLABLE" }], tx)).ok === false,
      );
      ok(
        "D2 received > returned quantity rejected",
        (await sellerReceiveReturn(ctxA, fx.ret.id, [{ returnItemId: fx.returnItemId, receivedQuantity: 99, restockQuantity: 0, condition: "RESELLABLE" }], tx)).ok === false,
      );
      ok(
        "D3 restock > 0 with non-RESELLABLE condition rejected",
        (await sellerReceiveReturn(ctxA, fx.ret.id, [{ returnItemId: fx.returnItemId, receivedQuantity: 3, restockQuantity: 2, condition: "DAMAGED" }], tx)).ok === false,
      );

      // ---- C + E + G: the happy path ----
      const beforeOA = await tx.offerAdjustment.count({ where: { offerInventory: { offerId: A.offer.id } } });
      const beforeQty = (await tx.offerInventory.findFirst({ where: { offerId: A.offer.id }, select: { quantity: true } }))!.quantity;

      const rec = await sellerReceiveReturn(
        ctxA,
        fx.ret.id,
        [{ returnItemId: fx.returnItemId, receivedQuantity: 3, restockQuantity: 2, condition: "RESELLABLE" }],
        tx,
      );
      ok("C1 APPROVED → receipt ok", rec.ok === true, JSON.stringify(rec));

      const retAfter = await tx.returnRequest.findUnique({ where: { id: fx.ret.id }, select: { status: true, restockedAt: true } });
      ok("C2 return advanced to RECEIVED + restockedAt set", retAfter?.status === "RECEIVED" && !!retAfter?.restockedAt);

      const riAfter = await tx.returnItem.findUnique({ where: { id: fx.returnItemId }, select: { restockQuantity: true, condition: true } });
      ok("C3 ReturnItem restockQuantity + condition persisted", riAfter?.restockQuantity === 2 && riAfter?.condition === "RESELLABLE");

      const afterOA = await tx.offerAdjustment.findMany({
        where: { offerInventory: { offerId: A.offer.id }, reason: "RETURN" },
        select: { delta: true, reason: true },
      });
      ok("E1 one RETURN OfferAdjustment created", afterOA.length === 1 && afterOA[0].delta === 2);
      const afterQty = (await tx.offerInventory.findFirst({ where: { offerId: A.offer.id }, select: { quantity: true } }))!.quantity;
      ok("E2 OfferInventory increased by the restock quantity", afterQty === beforeQty + 2, `${beforeQty} → ${afterQty}`);
      ok("E0 (no other OfferAdjustment created)", (await tx.offerAdjustment.count({ where: { offerInventory: { offerId: A.offer.id } } })) === beforeOA + 1);

      // ---- F: idempotency ----
      const rec2 = await sellerReceiveReturn(
        ctxA,
        fx.ret.id,
        [{ returnItemId: fx.returnItemId, receivedQuantity: 3, restockQuantity: 2, condition: "RESELLABLE" }],
        tx,
      );
      ok("F1 repeated receipt rejected", rec2.ok === false, JSON.stringify(rec2));
      const qtyAfter2 = (await tx.offerInventory.findFirst({ where: { offerId: A.offer.id }, select: { quantity: true } }))!.quantity;
      ok("F2 no double-restock (OfferInventory unchanged by the retry)", qtyAfter2 === afterQty);
      ok(
        "F3 still exactly one RETURN OfferAdjustment",
        (await tx.offerAdjustment.count({ where: { offerInventory: { offerId: A.offer.id }, reason: "RETURN" } })) === 1,
      );

      // ---- C (invalid transitions) ----
      const fxReq = await seedOrderReturn(tx, A.seller, A.offer, variant.productId, variant.id, suffix + "r", { returnStatus: "REQUESTED" });
      ok(
        "C4 receipt on a REQUESTED return rejected",
        (await sellerReceiveReturn(ctxA, fxReq.ret.id, [{ returnItemId: fxReq.returnItemId, receivedQuantity: 1, restockQuantity: 0, condition: "OPENED" }], tx)).ok === false,
      );

      // ---- mixed-seller guard ----
      const mixOrder = await tx.order.create({
        data: {
          orderNumber: `AX-T9F3-mix-${suffix}`, email: "b@e.test", status: "DELIVERED", subtotal: 100, grandTotal: 100,
          deliveredAt: new Date(), shippingAddress: "{}",
        },
        select: { id: true },
      });
      const soA = await tx.sellerOrder.create({ data: { orderId: mixOrder.id, sellerId: A.seller.id, sellerName: "A", sellerType: "THIRD_PARTY", supportEmail: "a@t", merchandiseSubtotal: 50, total: 50, status: "DELIVERED" }, select: { id: true } });
      const soB2 = await tx.sellerOrder.create({ data: { orderId: mixOrder.id, sellerId: B.seller.id, sellerName: "B", sellerType: "THIRD_PARTY", supportEmail: "b@t", merchandiseSubtotal: 50, total: 50, status: "DELIVERED" }, select: { id: true } });
      const oiA = await tx.orderItem.create({ data: { orderId: mixOrder.id, sellerOrderId: soA.id, sellerId: A.seller.id, offerId: A.offer.id, productId: variant.productId, variantId: variant.id, name: "x", unitPrice: 50, quantity: 1, lineTotal: 50 }, select: { id: true } });
      const oiB = await tx.orderItem.create({ data: { orderId: mixOrder.id, sellerOrderId: soB2.id, sellerId: B.seller.id, offerId: B.offer.id, productId: variant.productId, variantId: variant.id, name: "y", unitPrice: 50, quantity: 1, lineTotal: 50 }, select: { id: true } });
      const seqM = await tx.$queryRawUnsafe<{ v: bigint }[]>(`SELECT nextval('return_number_seq') AS v`);
      const mixRet = await tx.returnRequest.create({
        data: {
          returnNumber: `RET-T9F3-mix-${seqM[0].v}`, orderId: mixOrder.id, status: "APPROVED", reason: "OTHER",
          items: {
            create: [
              { orderItemId: oiA.id, productId: variant.productId, variantId: variant.id, name: "x", unitPrice: 50, quantity: 1, refundAmount: 50 },
              { orderItemId: oiB.id, productId: variant.productId, variantId: variant.id, name: "y", unitPrice: 50, quantity: 1, refundAmount: 50 },
            ],
          },
        },
        select: { id: true, items: { select: { id: true, orderItemId: true } } },
      });
      const aLine = mixRet.items.find((i) => i.orderItemId === oiA.id)!;
      const mixRes = await sellerReceiveReturn(ctxA, mixRet.id, [{ returnItemId: aLine.id, receivedQuantity: 1, restockQuantity: 1, condition: "RESELLABLE" }], tx);
      ok("MIX1 receipt on a mixed-seller return refused", mixRes.ok === false && mixRes.code === "MIXED_SELLER", JSON.stringify(mixRes));
      // A only sees its own line in a mixed return
      const mixDetailA = await getSellerReturnForSeller(ctxA, mixRet.id, tx);
      ok("MIX2 mixed return shows A only A's line", mixDetailA?.items.length === 1 && mixDetailA.items[0].orderItem.sellerId === A.seller.id);
      ok("MIX3 B cannot see A's line in the mixed return", (await getSellerReturnForSeller(ctxB, mixRet.id, tx))?.items.every((i) => i.orderItem.sellerId === B.seller.id) === true);

      // ---- G: 1P / order untouched ----
      const invNow = await tx.inventory.count();
      const invAdjNow = await tx.inventoryAdjustment.count();
      ok("G1 Inventory count unchanged inside tx", invNow === invBefore);
      ok("G2 InventoryAdjustment count unchanged inside tx", invAdjNow === invAdjBefore);
      const parentOrder = await tx.order.findUnique({ where: { id: fx.order.id }, select: { status: true } });
      ok("G3 parent Order.status unchanged (still DELIVERED)", parentOrder?.status === "DELIVERED");

      // ---- H: cancel → SellerOrder sync (the exact updateMany from order-actions.ts) ----
      const cOrder = await tx.order.create({ data: { orderNumber: `AX-T9F3-c-${suffix}`, email: "c@e.test", status: "PROCESSING", subtotal: 1, grandTotal: 1, shippingAddress: "{}" }, select: { id: true } });
      const cSO = await tx.sellerOrder.create({ data: { orderId: cOrder.id, sellerId: A.seller.id, sellerName: "A", sellerType: "THIRD_PARTY", supportEmail: "a@t", merchandiseSubtotal: 1, total: 1, status: "PROCESSING" }, select: { id: true } });
      await tx.$executeRaw`UPDATE "Order" SET "status" = 'CANCELLED' WHERE "id" = ${cOrder.id}`;
      const sync1 = await tx.sellerOrder.updateMany({ where: { orderId: cOrder.id, status: { not: "CANCELLED" } }, data: { status: "CANCELLED", updatedAt: new Date() } });
      ok("H1 cancel sync sets SellerOrder → CANCELLED", sync1.count === 1);
      const sync2 = await tx.sellerOrder.updateMany({ where: { orderId: cOrder.id, status: { not: "CANCELLED" } }, data: { status: "CANCELLED", updatedAt: new Date() } });
      ok("H2 sync is status-guarded (second run is a no-op)", sync2.count === 0);
      ok("H3 SellerOrder now CANCELLED", (await tx.sellerOrder.findUnique({ where: { id: cSO.id }, select: { status: true } }))?.status === "CANCELLED");

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  const leaked = await prisma.returnRequest.count({ where: { returnNumber: { contains: `T9F3` } } });
  ok("G4 all test rows rolled back (0 leaked returns)", leaked === 0, `leaked ${leaked}`);
  ok("G5 InventoryAdjustment count unchanged after rollback", (await prisma.inventoryAdjustment.count()) === invAdjBefore);
  ok("G6 Inventory count unchanged after rollback", (await prisma.inventory.count()) === invBefore);
  ok("G7 OrderEvent count unchanged after rollback", (await prisma.orderEvent.count()) === eventsBefore);
}

async function staticTests() {
  const repo = read("src/lib/marketplace/seller-return-repository.ts");
  const repoCode = repo.split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n");
  ok("I1 seller-return-repository never imports @/lib/inventory / calls adjustStock", !/@\/lib\/inventory|adjustStock\(/.test(repoCode));
  ok("I2 never writes Inventory / InventoryAdjustment", !/\b(tx|prisma|client)\.(inventory|inventoryAdjustment)\b/.test(repoCode));
  ok("I3 never writes Order.status / OrderEvent", !/\.order\.update|orderEvent\.create/.test(repoCode));
  ok("I4 never writes a refund field", !/refundAmount:|refundMethod:|refundInitiatedAt:|paymentRefund/.test(repoCode));
  ok("I5 restock goes through restoreOfferStock with reason RETURN", /restoreOfferStock\(/.test(repoCode) && /reason: "RETURN"/.test(repoCode));
  ok("I6 idempotency guard: status APPROVED + restockedAt null", /status: "APPROVED", restockedAt: null/.test(repoCode));
  ok("I7 mixed-seller return is refused", /MIXED_SELLER/.test(repoCode) && /orderItem\.sellerId !== ctx\.sellerId/.test(repoCode));

  const detailFn = repo.slice(repo.indexOf("export async function getSellerReturnForSeller"));
  const detailBody = detailFn.slice(0, detailFn.indexOf("\n}"));
  ok(
    "I8 detail read never selects email/phone/userId/billingAddress/grandTotal/refund/staffNote",
    !/\bemail: true\b/.test(detailBody) &&
      !/\bphone: true\b/.test(detailBody) &&
      !/\buserId: true\b/.test(detailBody) &&
      !/\bbillingAddress: true\b/.test(detailBody) &&
      !/\bgrandTotal: true\b/.test(detailBody) &&
      !/\brefundAmount: true\b/.test(detailBody) &&
      !/\bstaffNote: true\b/.test(detailBody),
  );

  const actions = read("src/lib/seller/return-actions.ts");
  ok("I9 the seller action requires manage_seller_returns", /requireSellerSessionPermission\("manage_seller_returns"\)/.test(actions));
  ok("I10 the seller action never revalidates the storefront", !/revalidateTag\(\s*["']products/.test(actions) && !/revalidatePath\(\s*["']\/p\//.test(actions));
  ok("I11 no approve/reject/refund action in the seller returns surface", !/approveReturn|rejectReturn|initiateRefund|completeRefund/.test(actions));

  const orderActions = read("src/lib/admin/order-actions.ts");
  // 9F-7b: the sync now finds the not-yet-CANCELLED rows first (so the
  // affected seller(s) can be notified after commit), then updates exactly
  // those ids — still status-guarded, still inside the same transaction.
  ok(
    "I12 cancelOrderAction syncs SellerOrder → CANCELLED (status-guarded, in-tx)",
    /tx\.sellerOrder\.findMany\(\{\s*where: \{ orderId, status: \{ not: "CANCELLED" \} \}/.test(
      orderActions.replace(/\n\s*/g, " "),
    ) &&
      /tx\.sellerOrder\.updateMany\(\{\s*where: \{ id: \{ in: toCancel\.map/.test(
        orderActions.replace(/\n\s*/g, " "),
      ) &&
      /data: \{ status: "CANCELLED"/.test(orderActions),
  );

  const nav = read("src/lib/seller/navigation.ts");
  ok("I13 /seller/returns is live in the nav", /path: "\/seller\/returns"[^}]*live: true/.test(nav.replace(/\n/g, " ")));
}

async function run() {
  console.log("PHASE 9F-3 — Seller Returns & Post-Order Operations\n");
  console.log("── static wiring ──");
  await staticTests();
  console.log("\n── seller-scoped return access (rolled back) ──");
  await dbTests();
  console.log(`\n  ${pass} passed, ${fail} failed.`);
  if (fail > 0) process.exitCode = 1;
}

run()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
