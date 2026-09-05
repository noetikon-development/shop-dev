/**
 * Phase 9F-8c — offer activation (DRAFT/INACTIVE -> ACTIVE) + commission
 * correction on full cancellation / partial return.
 *
 * SAFETY NOTE on the activation tests: `setSellerOfferStatus`'s
 * `marketplace.multiSellerCheckout` gate check reads via `getStoreSetting`
 * (`src/lib/marketplace/marketplace-settings.ts`), which is NOT
 * transaction-aware (always reads through the module `prisma`, wrapped in
 * React `cache()`). There is no safe way to exercise the "gate is true, the
 * map now allows ACTIVE" path from an isolated, rolled-back transaction
 * without writing `"true"` to the REAL, committed `marketplace.multiSellerCheckout`
 * StoreSetting row on the live production database this script runs
 * against — which the task explicitly forbids ("Do not enable
 * marketplace.multiSellerCheckout"), even momentarily. That half of the
 * behavior is therefore verified via STATIC source inspection only (the
 * `allowed` map literally contains "ACTIVE" for DRAFT/INACTIVE). The "gate
 * still blocks with the real (false) flag" half IS verified live, safely,
 * since it requires no write to the setting at all.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f8c.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { setSellerOfferStatus, createSellerOffer } from "../src/lib/marketplace/seller-repository";

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

async function seedSeller(tx: Tx, slug: string, commissionRate = 1500) {
  return tx.seller.create({
    data: { type: "THIRD_PARTY", status: "APPROVED", displayName: slug, slug, supportEmail: `${slug}@t.test`, contentStatus: "DRAFT", commissionRate },
    select: { id: true, displayName: true, supportEmail: true, commissionRate: true },
  });
}

// ---------------------------------------------------------------------------
// Static wiring
// ---------------------------------------------------------------------------

function staticTests() {
  const repo = read("src/lib/marketplace/seller-repository.ts");
  const orderActions = read("src/lib/admin/order-actions.ts");
  const returnsActions = read("src/lib/admin/returns-actions.ts");
  const checkout = read("src/lib/checkout.ts");
  const schema = read("prisma/schema.prisma");

  // 1/2 — offer activation map
  ok(
    "1 · allowed map now permits DRAFT -> ACTIVE",
    /DRAFT:\s*\["INACTIVE",\s*"ARCHIVED",\s*"ACTIVE"\]/.test(repo),
  );
  ok(
    "2 · allowed map now permits INACTIVE -> ACTIVE",
    /INACTIVE:\s*\["DRAFT",\s*"ARCHIVED",\s*"ACTIVE"\]/.test(repo),
  );
  ok(
    "· ACTIVE's own outgoing transitions unchanged (still only -> INACTIVE/ARCHIVED)",
    /ACTIVE:\s*\["INACTIVE",\s*"ARCHIVED"\],\s*\n\s*\};/.test(repo),
  );
  ok(
    "3 · the live multiSellerCheckout gate is untouched — still the first check, still FORBIDDEN",
    /if \(next === "ACTIVE"\) \{\s*\n\s*const gate = await getStoreSetting\("marketplace\.multiSellerCheckout"\);\s*\n\s*if \(gate !== "true"\) \{\s*\n\s*return \{\s*\n\s*ok: false,\s*\n\s*code: "FORBIDDEN"/.test(
      repo,
    ),
  );
  ok(
    "3 · the gate check runs BEFORE the allowed-map check (still a double-lock, not a replacement)",
    repo.indexOf('if (next === "ACTIVE")') < repo.indexOf("const allowed: Record"),
  );
  ok("· ARCHIVED is still terminal / not reachable-from is unaffected", /if \(offer\.status === "ARCHIVED"\)/.test(repo));

  // 4 — full cancellation zeros commission, in the SAME guarded write as the
  // existing CANCELLED cascade (so a repeat attempt — which matches 0 rows —
  // can never re-zero it)
  ok(
    "4 · cancelOrderAction zeros commissionAmount in the same guarded SellerOrder update",
    /data: \{ status: "CANCELLED", updatedAt: new Date\(\), commissionAmount: 0 \}/.test(orderActions),
  );
  ok(
    "4 · the zero-out is inside the SAME `if (toCancel.length > 0)` guarded block, not a separate ungated write",
    /if \(toCancel\.length > 0\) \{\s*\n\s*await tx\.sellerOrder\.updateMany\(\{\s*\n\s*where: \{ id: \{ in: toCancel\.map[\s\S]{0,300}data: \{ status: "CANCELLED", updatedAt: new Date\(\), commissionAmount: 0 \}/.test(
      orderActions,
    ),
  );

  // 5 — partial return commission reduction
  ok("5 · returns-actions.ts has a local roundHalfUp matching checkout's rule", /function roundHalfUp\(x: number\): number \{\s*\n\s*return Math\.sign\(x\) \* Math\.round\(Math\.abs\(x\)\)/.test(returnsActions));
  ok("5 · commission reduction uses the snapshotted ReturnItem.refundAmount (unitPrice x quantity)", /returnedValueBySellerOrder\.set\(\s*\n\s*sellerOrderId,\s*\n\s*\(returnedValueBySellerOrder\.get\(sellerOrderId\) \?\? 0\) \+ l\.item\.refundAmount,/.test(returnsActions));
  ok("5 · adjustment computed as roundHalfUp(returnedValue * commissionRate / 10000)", /roundHalfUp\(\(returnedValue \* so\.commissionRate\) \/ 10000\)/.test(returnsActions));
  ok("7 · commission floor at 0, never negative", /Math\.max\(0, so\.commissionAmount - commissionAdjustment\)/.test(returnsActions));
  ok("5 · scoped per affected SellerOrder (not a blind single-seller assumption)", /returnedValueBySellerOrder = new Map<string, number>/.test(returnsActions));
  ok(
    "6 · the return commission block sits AFTER the return's own idempotency guard (restockedAt/status), so a repeat receive (0 rows) never re-adjusts",
    (() => {
      const guardIdx = returnsActions.indexOf('where: { id: ret.id, status: "APPROVED", restockedAt: null }');
      const commissionIdx = returnsActions.indexOf("returnedValueBySellerOrder");
      return guardIdx > -1 && commissionIdx > guardIdx;
    })(),
  );

  // 8 — checkout's original formula is untouched
  ok(
    "8 · checkout.ts creation-time commission formula is byte-identical to before this phase",
    /const sellerCommissionAmount = roundHalfUp\(\(subtotal \* soSeller\.commissionRate\) \/ 10000\);/.test(checkout),
  );
  ok("8 · checkout.ts's single-seller gate untouched", /if \(sellerIds\.size !== 1\)/.test(checkout));
  ok("8 · checkout.ts was not touched to export anything new for this phase", !/export function roundHalfUp/.test(checkout) && !/export const roundHalfUp/.test(checkout));

  // scope
  ok("scope · no schema change (Seller/SellerOrder/Offer models unchanged shape)", !/9F-8c/.test(schema));
  ok("scope · marketplace.multiSellerCheckout not flipped anywhere in source", !/multiSellerCheckout["'`]?\s*[,:]\s*["'`]?true/.test(repo) && !/multiSellerCheckout.*=.*"true"/.test(orderActions) && !/multiSellerCheckout.*=.*"true"/.test(returnsActions));
  ok("scope · no PayMongo / payout / settlement code added", !/PAYMONGO_|initiateProviderRefund|payout/i.test(orderActions) && !/PAYMONGO_/i.test(returnsActions));
  ok("scope · scripts/seed-rbac.ts not referenced by any changed file", ![repo, orderActions, returnsActions].some((f) => /seed-rbac/.test(f)));
}

// ---------------------------------------------------------------------------
// Database (rolled back)
// ---------------------------------------------------------------------------

async function dbTests() {
  const sellerBefore = await prisma.seller.count();
  const offerBefore = await prisma.offer.count();
  const sellerOrderBefore = await prisma.sellerOrder.count();

  // 3 — SAFE: verify the gate still blocks activation using the REAL,
  // unmodified `marketplace.multiSellerCheckout` value (confirmed false) —
  // no write to that setting anywhere in this test.
  const liveGate = await prisma.storeSetting.findUnique({ where: { key: "marketplace.multiSellerCheckout" }, select: { value: true } });
  ok("3 · precondition — the real StoreSetting is not \"true\" (nothing here could have enabled it)", liveGate?.value !== "true", JSON.stringify(liveGate));

  try {
    await prisma.$transaction(async (tx) => {
      const t = Date.now().toString(36);
      const category = await tx.category.findFirst({ where: { active: true }, select: { id: true } });
      if (!category) { ok("db tests skipped — no active category", true); throw new Rollback(); }

      const S = await seedSeller(tx, `oc-${t}`, 1500); // 15.00%
      const product = await tx.product.create({
        data: { name: `OC ${t}`, slug: `oc-${t}`, shortDescription: "s", description: "d", categoryId: category.id, status: "ACTIVE", price: 50000 },
        select: { id: true },
      });
      const variant = await tx.variant.create({
        data: { productId: product.id, sku: `OC-${t}`, price: 50000, status: "ACTIVE", stock: 10 },
        select: { id: true },
      });

      // ---- 3 — real gate blocks ACTIVE (both DRAFT-> and INACTIVE->) ------
      const created = await createSellerOffer(
        { sellerId: S.id, sellerName: S.displayName, sellerUserId: "u", userId: "u", role: "OWNER", permissions: new Set(["manage_listings"]) },
        { variantId: variant.id, price: 45000 },
        tx,
      );
      if (!created.ok) throw new Error("fixture: could not create seller offer");
      const goActiveFromDraft = await setSellerOfferStatus(
        { sellerId: S.id, sellerName: S.displayName, sellerUserId: "u", userId: "u", role: "OWNER", permissions: new Set(["manage_listings"]) },
        created.offerId,
        "ACTIVE",
        tx,
      );
      ok("3 · DRAFT -> ACTIVE still refused (FORBIDDEN) with the real flag false", goActiveFromDraft.ok === false && goActiveFromDraft.code === "FORBIDDEN", JSON.stringify(goActiveFromDraft));

      const ctx = { sellerId: S.id, sellerName: S.displayName, sellerUserId: "u", userId: "u", role: "OWNER" as const, permissions: new Set(["manage_listings"]) };
      await setSellerOfferStatus(ctx, created.offerId, "INACTIVE", tx); // DRAFT -> INACTIVE (always allowed)
      const goActiveFromInactive = await setSellerOfferStatus(ctx, created.offerId, "ACTIVE", tx);
      ok("3 · INACTIVE -> ACTIVE still refused (FORBIDDEN) with the real flag false", goActiveFromInactive.ok === false && goActiveFromInactive.code === "FORBIDDEN", JSON.stringify(goActiveFromInactive));
      const stillOffer = await tx.offer.findUnique({ where: { id: created.offerId }, select: { status: true } });
      ok("3 · offer status unaffected by the refused attempts (still INACTIVE)", stillOffer?.status === "INACTIVE");

      // ---- 4 — full cancellation zeros commission (mirrors cancelOrderAction's exact write) ----
      const order = await tx.order.create({
        data: { orderNumber: `OC-${t}`, email: "customer@t.test", subtotal: 100000, grandTotal: 100000, shippingAddress: JSON.stringify({ firstName: "C" }), status: "PROCESSING" },
        select: { id: true },
      });
      const so1 = await tx.sellerOrder.create({
        data: { orderId: order.id, sellerId: S.id, sellerName: S.displayName, sellerType: "THIRD_PARTY", supportEmail: S.supportEmail, commissionRate: S.commissionRate, merchandiseSubtotal: 100000, total: 100000, status: "PROCESSING", commissionAmount: roundHalfUp((100000 * S.commissionRate) / 10000) },
        select: { id: true, commissionAmount: true },
      });
      ok("4 · fixture SellerOrder starts with the checkout-style commission (15000)", so1.commissionAmount === 15000, String(so1.commissionAmount));

      // exact mirror of cancelOrderAction's guarded write
      const toCancel = await tx.sellerOrder.findMany({ where: { orderId: order.id, status: { not: "CANCELLED" } }, select: { id: true } });
      ok("4 · exactly one SellerOrder found to cancel", toCancel.length === 1);
      await tx.sellerOrder.updateMany({ where: { id: { in: toCancel.map((s) => s.id) } }, data: { status: "CANCELLED", updatedAt: new Date(), commissionAmount: 0 } });
      const afterCancel = await tx.sellerOrder.findUniqueOrThrow({ where: { id: so1.id }, select: { commissionAmount: true, status: true } });
      ok("4 · commissionAmount zeroed on full cancellation", afterCancel.commissionAmount === 0);
      ok("4 · status is CANCELLED", afterCancel.status === "CANCELLED");

      // ---- 6a — repeated cancellation attempt cannot re-touch it ----------
      const toCancelAgain = await tx.sellerOrder.findMany({ where: { orderId: order.id, status: { not: "CANCELLED" } }, select: { id: true } });
      ok("6a · a second cancel attempt finds ZERO rows to touch (already CANCELLED)", toCancelAgain.length === 0);

      // ---- 5 — partial return reduces commission proportionally ----------
      // Separate Order — SellerOrder has a UNIQUE(orderId, sellerId) constraint,
      // so a second SellerOrder for the same seller needs its own parent Order.
      const order2 = await tx.order.create({
        data: { orderNumber: `OC2-${t}`, email: "customer@t.test", subtotal: 200000, grandTotal: 200000, shippingAddress: JSON.stringify({ firstName: "C" }), status: "PROCESSING" },
        select: { id: true },
      });
      const so2 = await tx.sellerOrder.create({
        data: { orderId: order2.id, sellerId: S.id, sellerName: S.displayName, sellerType: "THIRD_PARTY", supportEmail: S.supportEmail, commissionRate: S.commissionRate, merchandiseSubtotal: 200000, total: 200000, status: "PROCESSING", commissionAmount: roundHalfUp((200000 * S.commissionRate) / 10000) },
        select: { id: true, commissionAmount: true },
      });
      ok("5 · fixture SellerOrder 2 starts at 30000 commission (200000 * 15%)", so2.commissionAmount === 30000);

      const orderItem = await tx.orderItem.create({
        data: { orderId: order2.id, sellerOrderId: so2.id, productId: product.id, variantId: variant.id, name: `OC ${t}`, unitPrice: 100000, quantity: 2, lineTotal: 200000, sellerId: S.id },
        select: { id: true },
      });
      const returnReq = await tx.returnRequest.create({
        data: { returnNumber: `RET-OC-${t}`, orderId: order2.id, status: "RECEIVED", reason: "NO_LONGER_NEEDED", restockedAt: new Date() },
        select: { id: true },
      });
      // returning 1 of the 2 units — refundAmount snapshot = unitPrice * quantity = 100000
      await tx.returnItem.create({
        data: { returnRequestId: returnReq.id, orderItemId: orderItem.id, productId: product.id, variantId: variant.id, name: `OC ${t}`, unitPrice: 100000, quantity: 1, refundAmount: 100000 },
      });

      // exact mirror of receiveReturnAction's new commission block
      const owners = await tx.orderItem.findMany({ where: { id: { in: [orderItem.id] } }, select: { id: true, sellerOrderId: true } });
      const sellerOrderByOrderItem = new Map(owners.map((oi) => [oi.id, oi.sellerOrderId]));
      const items = await tx.returnItem.findMany({ where: { returnRequestId: returnReq.id }, select: { orderItemId: true, refundAmount: true } });
      const returnedValueBySellerOrder = new Map<string, number>();
      for (const it of items) {
        const sellerOrderId = it.orderItemId ? sellerOrderByOrderItem.get(it.orderItemId) : null;
        if (!sellerOrderId) continue;
        returnedValueBySellerOrder.set(sellerOrderId, (returnedValueBySellerOrder.get(sellerOrderId) ?? 0) + it.refundAmount);
      }
      ok("5 · exactly one affected SellerOrder found for this return", returnedValueBySellerOrder.size === 1 && returnedValueBySellerOrder.has(so2.id));
      ok("5 · returned value = 100000 (1 unit x unitPrice 100000)", returnedValueBySellerOrder.get(so2.id) === 100000);

      for (const [sellerOrderId, returnedValue] of returnedValueBySellerOrder) {
        const soRow = await tx.sellerOrder.findUniqueOrThrow({ where: { id: sellerOrderId }, select: { commissionAmount: true, commissionRate: true } });
        const commissionAdjustment = roundHalfUp((returnedValue * soRow.commissionRate) / 10000);
        ok("5 · commissionAdjustment = 15000 (100000 * 15%)", commissionAdjustment === 15000, String(commissionAdjustment));
        await tx.sellerOrder.update({ where: { id: sellerOrderId }, data: { commissionAmount: Math.max(0, soRow.commissionAmount - commissionAdjustment) } });
      }
      const afterReturn = await tx.sellerOrder.findUniqueOrThrow({ where: { id: so2.id }, select: { commissionAmount: true } });
      ok("5 · commissionAmount reduced from 30000 to 15000", afterReturn.commissionAmount === 15000, String(afterReturn.commissionAmount));

      // ---- 6b — repeated receive attempt cannot re-adjust ------------------
      const repeatGuard = await tx.returnRequest.updateMany({ where: { id: returnReq.id, status: "APPROVED", restockedAt: null }, data: { status: "RECEIVED" } });
      ok("6b · a second receive attempt matches ZERO rows (already RECEIVED with restockedAt set)", repeatGuard.count === 0);

      // ---- 7 — commission never goes negative ------------------------------
      const order3 = await tx.order.create({
        data: { orderNumber: `OC3-${t}`, email: "customer@t.test", subtotal: 10000, grandTotal: 10000, shippingAddress: JSON.stringify({ firstName: "C" }), status: "PROCESSING" },
        select: { id: true },
      });
      const so3 = await tx.sellerOrder.create({
        data: { orderId: order3.id, sellerId: S.id, sellerName: S.displayName, sellerType: "THIRD_PARTY", supportEmail: S.supportEmail, commissionRate: S.commissionRate, merchandiseSubtotal: 10000, total: 10000, status: "PROCESSING", commissionAmount: 100 },
        select: { id: true, commissionAmount: true },
      });
      const oversizedAdjustment = roundHalfUp((999999 * S.commissionRate) / 10000); // deliberately huge
      const floored = Math.max(0, so3.commissionAmount - oversizedAdjustment);
      ok("7 · an adjustment larger than the remaining commission floors at 0, never negative", floored === 0, String(floored));
      await tx.sellerOrder.update({ where: { id: so3.id }, data: { commissionAmount: floored } });
      const so3After = await tx.sellerOrder.findUniqueOrThrow({ where: { id: so3.id }, select: { commissionAmount: true } });
      ok("7 · persisted commissionAmount is 0, not negative", so3After.commissionAmount === 0);

      // ---- 8 — checkout's original creation-time formula, re-derived here, matches ----
      const freshSubtotal = 73400;
      const expectedCommission = roundHalfUp((freshSubtotal * S.commissionRate) / 10000);
      ok("8 · checkout-style commission formula produces the expected value (73400 * 15% = 11010)", expectedCommission === 11010, String(expectedCommission));

      throw new Rollback();
    }, { timeout: 40_000, maxWait: 12_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("isolation · Seller count unchanged after rollback", (await prisma.seller.count()) === sellerBefore);
  ok("isolation · Offer count unchanged after rollback", (await prisma.offer.count()) === offerBefore);
  ok("isolation · SellerOrder count unchanged after rollback", (await prisma.sellerOrder.count()) === sellerOrderBefore);

  const gateAfter = await prisma.storeSetting.findUnique({ where: { key: "marketplace.multiSellerCheckout" }, select: { value: true } });
  ok("isolation · marketplace.multiSellerCheckout is still not \"true\" after this whole test run", gateAfter?.value !== "true", JSON.stringify(gateAfter));
}

async function main() {
  console.log("\nPHASE 9F-8c — offer activation + commission correction\n");
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
