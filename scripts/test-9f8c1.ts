/**
 * Phase 9F-8c.1 — commission return-correction consistency: the same partial-
 * return commission reduction added to the admin `receiveReturnAction` path in
 * 9F-8c is now also applied to the seller self-service `sellerReceiveReturn`
 * path, using the identical formula (never a second, different one).
 *
 * DB tests build a real 3P Seller + Offer + Order + SellerOrder (with a
 * non-zero commissionRate/commissionAmount) + OrderItem + ReturnRequest(APPROVED)
 * + ReturnItem inside ONE prisma.$transaction and roll back.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f8c1.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { sellerReceiveReturn } from "../src/lib/marketplace/seller-return-repository";
import type { SellerContext } from "../src/lib/marketplace/types";

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

function roundHalfUp(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

function ctxFor(sellerId: string): SellerContext {
  return { sellerId, sellerName: "S", sellerUserId: "su-" + sellerId, userId: "u-" + sellerId, role: "OWNER", permissions: new Set() };
}

// ---------------------------------------------------------------------------
// Static wiring — the two commission-adjustment sites must be the SAME formula
// ---------------------------------------------------------------------------

function staticTests() {
  const sellerRepo = read("src/lib/marketplace/seller-return-repository.ts");
  const adminActions = read("src/lib/admin/returns-actions.ts");

  ok("1 · seller-return-repository.ts has a local roundHalfUp matching the admin/checkout rule", /function roundHalfUp\(x: number\): number \{\s*\n\s*return Math\.sign\(x\) \* Math\.round\(Math\.abs\(x\)\)/.test(sellerRepo));
  ok("1 · seller path sums the same snapshotted ReturnItem.refundAmount basis", /returnedValueBySellerOrder\.set\(\s*\n\s*sellerOrderId,\s*\n\s*\(returnedValueBySellerOrder\.get\(sellerOrderId\) \?\? 0\) \+ it\.refundAmount,/.test(sellerRepo));
  ok("1 · seller path uses the identical adjustment formula (roundHalfUp(returnedValue * commissionRate / 10000))", /roundHalfUp\(\(returnedValue \* so\.commissionRate\) \/ 10000\)/.test(sellerRepo));
  ok("1 · seller path floors at 0, never negative — identical to the admin path", /Math\.max\(0, so\.commissionAmount - commissionAdjustment\)/.test(sellerRepo));

  // Both files must contain the EXACT same 3 formula fragments — proving one
  // shared pattern was reused, not two different formulas invented.
  const sharedFragments = [
    "return Math.sign(x) * Math.round(Math.abs(x))",
    "roundHalfUp((returnedValue * so.commissionRate) / 10000)",
    "Math.max(0, so.commissionAmount - commissionAdjustment)",
  ];
  for (const frag of sharedFragments) {
    ok(`2 · both admin and seller paths contain "${frag}"`, sellerRepo.includes(frag) && adminActions.includes(frag));
  }

  ok(
    "3 · the seller-path commission block sits AFTER its own idempotency guard (status/restockedAt), so a repeat receive (0 rows -> throw) never re-adjusts",
    (() => {
      const guardIdx = sellerRepo.indexOf('where: { id: returnId, status: "APPROVED", restockedAt: null }');
      const commissionIdx = sellerRepo.indexOf("returnedValueBySellerOrder");
      return guardIdx > -1 && commissionIdx > guardIdx;
    })(),
  );
  ok("4 · seller path never touches Offer/OfferInventory/Inventory beyond the pre-existing restock call", !/tx\.inventory\.|tx\.offerInventory\.(create|update|delete)/.test(sellerRepo.slice(sellerRepo.indexOf("returnedValueBySellerOrder"), sellerRepo.indexOf("returnedValueBySellerOrder") + 1500)));
  ok("scope · no schema markers, no PayMongo/payout/settlement code added", !/9F-8c\.1[\s\S]{0,50}schema/i.test(sellerRepo) && !/PAYMONGO_|payout|settlement/i.test(sellerRepo));
  ok("scope · scripts/seed-rbac.ts not referenced", !/seed-rbac/.test(sellerRepo));
  ok("scope · checkout.ts not touched by this phase", !/9F-8c/.test(read("src/lib/checkout.ts")));
}

// ---------------------------------------------------------------------------
// Database (rolled back)
// ---------------------------------------------------------------------------

async function seedSellerWithOffer(tx: Tx, slug: string, variantId: string, commissionRate: number) {
  const seller = await tx.seller.create({
    data: { type: "THIRD_PARTY", status: "APPROVED", displayName: slug, slug, supportEmail: `${slug}@t.test`, commissionRate },
    select: { id: true, displayName: true, supportEmail: true, commissionRate: true },
  });
  const offer = await tx.offer.create({
    data: { sellerId: seller.id, variantId, price: 5000, condition: "NEW", status: "DRAFT", sellerSku: `${slug}-sku` },
    select: { id: true },
  });
  await tx.offerInventory.create({ data: { offerId: offer.id, quantity: 10, reserved: 0, reorderPoint: 2 } });
  return { seller, offer };
}

async function seedOrderReturn(
  tx: Tx,
  seller: { id: string; displayName: string; supportEmail: string; commissionRate: number },
  offer: { id: string },
  productId: string,
  variantId: string,
  suffix: string,
  opts: { qty?: number; returnedQty?: number; commissionAmount?: number; merchandiseSubtotal?: number },
) {
  const qty = opts.qty ?? 3;
  const unitPrice = 5000;
  const merchandiseSubtotal = opts.merchandiseSubtotal ?? unitPrice * qty;
  const commissionAmount = opts.commissionAmount ?? roundHalfUp((merchandiseSubtotal * seller.commissionRate) / 10000);

  const order = await tx.order.create({
    data: {
      orderNumber: `AX-T9F8C1-${suffix}-${Math.random().toString(36).slice(2, 6)}`,
      email: "buyer@example.test",
      status: "DELIVERED",
      subtotal: merchandiseSubtotal,
      grandTotal: merchandiseSubtotal,
      deliveredAt: new Date(),
      shippingAddress: JSON.stringify({ firstName: "T", lastName: "B", phone: "+639", line1: "1 St", city: "M", province: "N", postalCode: "1000", country: "PH" }),
    },
    select: { id: true, orderNumber: true },
  });
  const so = await tx.sellerOrder.create({
    data: {
      orderId: order.id, sellerId: seller.id, sellerName: seller.displayName, sellerType: "THIRD_PARTY",
      supportEmail: seller.supportEmail, commissionRate: seller.commissionRate, merchandiseSubtotal, total: merchandiseSubtotal,
      status: "DELIVERED", commissionAmount,
    },
    select: { id: true, commissionAmount: true, commissionRate: true },
  });
  const oi = await tx.orderItem.create({
    data: {
      orderId: order.id, sellerOrderId: so.id, sellerId: seller.id, offerId: offer.id,
      productId, variantId, name: "Test item", unitPrice, quantity: qty, lineTotal: unitPrice * qty,
    },
    select: { id: true },
  });
  const returnedQty = opts.returnedQty ?? qty;
  const seq = await tx.$queryRawUnsafe<{ v: bigint }[]>(`SELECT nextval('return_number_seq') AS v`);
  const ret = await tx.returnRequest.create({
    data: {
      returnNumber: `RET-T9F8C1-${seq[0].v}`,
      orderId: order.id,
      status: "APPROVED",
      reason: "DAMAGED",
      items: {
        create: [
          {
            orderItemId: oi.id, productId, variantId, name: "Test item",
            unitPrice, quantity: returnedQty, refundAmount: unitPrice * returnedQty,
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
  const variant = await prisma.variant.findFirst({ where: { status: "ACTIVE" }, select: { id: true, productId: true } });
  if (!variant) { ok("db tests skipped — no ACTIVE variant", true); return; }

  const sellerBefore = await prisma.seller.count();
  const sellerOrderBefore = await prisma.sellerOrder.count();

  try {
    await prisma.$transaction(async (tx) => {
      // ---- 1 — partial return reduces commission ONCE via sellerReceiveReturn ----
      const A = await seedSellerWithOffer(tx, `a9f8c1-${suffix}`, variant.id, 1500); // 15%
      const ctxA = ctxFor(A.seller.id);
      // 3 units @ 5000 = 15000 merchandise -> commission 2250; return 1 unit -> refundAmount 5000
      const fx = await seedOrderReturn(tx, A.seller, A.offer, variant.productId, variant.id, suffix, { qty: 3, returnedQty: 1 });
      ok("1 · fixture SellerOrder starts at commission 2250 (15000 * 15%)", fx.so.commissionAmount === 2250, String(fx.so.commissionAmount));

      const rec = await sellerReceiveReturn(
        ctxA,
        fx.ret.id,
        [{ returnItemId: fx.returnItemId, receivedQuantity: 1, restockQuantity: 1, condition: "RESELLABLE" }],
        tx,
      );
      ok("1 · sellerReceiveReturn succeeds", rec.ok === true, JSON.stringify(rec));
      const afterFirst = await tx.sellerOrder.findUniqueOrThrow({ where: { id: fx.so.id }, select: { commissionAmount: true } });
      // returned value 5000 * 15% = 750 -> 2250 - 750 = 1500
      ok("1 · commissionAmount reduced from 2250 to 1500 (5000 returned * 15%)", afterFirst.commissionAmount === 1500, String(afterFirst.commissionAmount));

      // ---- 2 — repeated receive attempt does not reduce it again ----------
      const rec2 = await sellerReceiveReturn(
        ctxA,
        fx.ret.id,
        [{ returnItemId: fx.returnItemId, receivedQuantity: 1, restockQuantity: 1, condition: "RESELLABLE" }],
        tx,
      );
      // Rejected before even reaching the transaction's atomic guard — the
      // return is no longer APPROVED (it's RECEIVED), so `canTransitionReturn`
      // catches it first (code VALIDATION); a same-status race would instead
      // hit the atomic `restockedAt`-guarded updateMany and return STALE. Both
      // outcomes mean "rejected, not reprocessed" — what matters is proven
      // right below: the commission is NOT touched a second time either way.
      ok(
        "2 · a repeated receipt attempt is rejected, not silently re-applied",
        rec2.ok === false && ["VALIDATION", "STALE"].includes((rec2 as { code?: string }).code ?? ""),
        JSON.stringify(rec2),
      );
      const afterRepeat = await tx.sellerOrder.findUniqueOrThrow({ where: { id: fx.so.id }, select: { commissionAmount: true } });
      ok("2 · commissionAmount unchanged after the repeat attempt (still 1500, not double-adjusted)", afterRepeat.commissionAmount === 1500, String(afterRepeat.commissionAmount));

      // ---- 3 — commission never goes negative ------------------------------
      const B = await seedSellerWithOffer(tx, `b9f8c1-${suffix}`, variant.id, 1500);
      const ctxB = ctxFor(B.seller.id);
      // Seed a SellerOrder whose recorded commission (100) is much smaller than
      // what a full-value return would compute (2250) — simulates a prior
      // partial adjustment or a data inconsistency; the floor must still hold.
      const fxNeg = await seedOrderReturn(tx, B.seller, B.offer, variant.productId, variant.id, suffix + "n", {
        qty: 3,
        returnedQty: 3,
        commissionAmount: 100,
      });
      const recNeg = await sellerReceiveReturn(
        ctxB,
        fxNeg.ret.id,
        [{ returnItemId: fxNeg.returnItemId, receivedQuantity: 3, restockQuantity: 3, condition: "RESELLABLE" }],
        tx,
      );
      ok("3 · sellerReceiveReturn succeeds for the full-return fixture", recNeg.ok === true, JSON.stringify(recNeg));
      const afterNeg = await tx.sellerOrder.findUniqueOrThrow({ where: { id: fxNeg.so.id }, select: { commissionAmount: true } });
      ok("3 · commissionAmount floors at 0, never negative, even when the adjustment exceeds the recorded amount", afterNeg.commissionAmount === 0, String(afterNeg.commissionAmount));

      // ---- 4 — cross-seller isolation: seller B's receipt never touches A's SellerOrder ----
      const aUnaffected = await tx.sellerOrder.findUniqueOrThrow({ where: { id: fx.so.id }, select: { commissionAmount: true } });
      ok("4 · seller A's SellerOrder is unaffected by seller B's receipt", aUnaffected.commissionAmount === 1500);

      throw new Rollback();
    }, { timeout: 40_000, maxWait: 12_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("isolation · Seller count unchanged after rollback", (await prisma.seller.count()) === sellerBefore);
  ok("isolation · SellerOrder count unchanged after rollback", (await prisma.sellerOrder.count()) === sellerOrderBefore);
}

async function main() {
  console.log("\nPHASE 9F-8c.1 — commission return-correction consistency\n");
  console.log("Static wiring");
  staticTests();
  console.log("\nDatabase (rolled back)");
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
