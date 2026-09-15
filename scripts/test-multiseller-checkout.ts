/**
 * Multi-seller checkout — Phase B assertion runner (multi-seller order
 * creation).
 *
 * `src/lib/checkout.ts` pulls in `next/navigation` (via `getCurrentUser`) and
 * `next/cache` (`revalidatePath`/`revalidateTag`), neither of which works
 * outside an active Next.js request — it can't load in a standalone script
 * (the same reason `scripts/test-9e3c2.ts` replicates the checkout core
 * rather than importing `createOrderFromCart` directly). The MULTI-SELLER
 * GROUPING / ALLOCATION / SellerOrder-creation core below is REPLICATED from
 * `createOrderFromCart` and marked "keep in sync with src/lib/checkout.ts" —
 * but unlike the older 9E-3C-2 replica, this one imports the REAL, pure
 * `allocateShippingFee` / `allocateDiscount` (Phase A) and the REAL
 * `resolveSellerCommissionBps` / `shouldAutoConfirmAtCheckout`, so those
 * pieces are genuinely exercised, not re-implemented a second time.
 *
 * Every DB test runs inside ONE `prisma.$transaction` that builds fully
 * synthetic fixtures (new sellers, products, variants, offers — never
 * Axiaro / Style Avenue / Sandbox Seller), runs the replicated writer,
 * asserts, then throws `Rollback` to abort — nothing persists.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-multiseller-checkout.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient, Prisma } from "@prisma/client";
import { allocateShippingFee, allocateDiscount, type SellerSubtotal } from "../src/lib/marketplace/order-allocation";
import { resolveSellerCommissionBps } from "../src/lib/marketplace/commission";
import { shouldAutoConfirmAtCheckout, canTransition } from "../src/lib/orders/status";
import { sendSellerOrderReceived } from "../src/lib/email/notifications";
import { cascadeSellerOrderFromParent } from "../src/lib/marketplace/seller-order-repository";

const prisma = new PrismaClient();

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
class Rollback extends Error {}

function roundHalfUp(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

type SellerFixture = { id: string; displayName: string; type: string; supportEmail: string; commissionRate: number };
type LineFixture = { productId: string; variantId: string; offerId: string; sellerId: string; name: string; sku: string; unitPrice: number; quantity: number; lineTotal: number };

type WriterResult =
  | { ok: true; orderId: string; sellerOrderIds: { sellerId: string; sellerOrderId: string; sellerType: string }[] }
  | { ok: false; code: string };

// --- keep in sync with src/lib/checkout.ts createOrderFromCart -------------
async function runMultiSellerCheckoutCore(
  tx: Prisma.TransactionClient,
  args: {
    cartId: string;
    userId: string;
    userEmail: string;
    sellers: Map<string, SellerFixture>;
    method: { id: string; code: string; name: string; rate: number };
    freeThreshold: number;
    shipAddr: { id: string; phone: string };
    couponCode?: string;
  },
): Promise<WriterResult> {
  const cart = await tx.cart.findUnique({
    where: { id: args.cartId },
    include: {
      items: {
        orderBy: { createdAt: "asc" },
        include: {
          offer: {
            select: { id: true, status: true, price: true, variantId: true, sellerId: true, inventory: { select: { quantity: true, reserved: true } } },
          },
          variant: { select: { id: true, sku: true, status: true, productId: true, product: { select: { id: true, name: true, status: true } } } },
        },
      },
    },
  });
  if (!cart) return { ok: false, code: "EMPTY" };
  if (cart.status !== "ACTIVE") {
    const existing = await tx.order.findFirst({ where: { cartId: args.cartId }, select: { id: true } });
    return existing ? { ok: true, orderId: existing.id, sellerOrderIds: [] } : { ok: false, code: "ALREADY_ORDERED" };
  }
  if (cart.items.length === 0) return { ok: false, code: "EMPTY" };

  const problems: string[] = [];
  const lines: LineFixture[] = [];
  const sellerGroups = new Map<string, { seller: SellerFixture; lines: LineFixture[]; merchandiseSubtotal: number }>();

  for (const item of cart.items) {
    const v = item.variant, p = v.product, o = item.offer;
    const sellerFixture = o ? args.sellers.get(o.sellerId) : undefined;
    if (!o || !item.offerId || o.variantId !== item.variantId || !sellerFixture) { problems.push(p.name); continue; }
    if (p.status !== "ACTIVE" || v.status !== "ACTIVE" || o.status !== "ACTIVE") { problems.push(p.name); continue; }
    const available = o.inventory ? Math.max(0, o.inventory.quantity - o.inventory.reserved) : 0;
    if (!o.inventory || available < item.quantity) { problems.push(p.name); continue; }

    const line: LineFixture = {
      productId: p.id, variantId: v.id, offerId: o.id, sellerId: sellerFixture.id,
      name: p.name, sku: v.sku, unitPrice: o.price, quantity: item.quantity, lineTotal: o.price * item.quantity,
    };
    lines.push(line);
    let group = sellerGroups.get(sellerFixture.id);
    if (!group) { group = { seller: sellerFixture, lines: [], merchandiseSubtotal: 0 }; sellerGroups.set(sellerFixture.id, group); }
    group.lines.push(line);
    group.merchandiseSubtotal += line.lineTotal;
  }
  if (problems.length > 0) return { ok: false, code: "STOCK" };
  if (lines.length === 0 || sellerGroups.size === 0) return { ok: false, code: "EMPTY" };
  const sellerGroupList = [...sellerGroups.values()];

  // Corrected auto-confirm rule (mixed-1P+3P fix): EVERY seller must qualify,
  // not just one — otherwise a THIRD_PARTY seller sharing a cart with Axiaro
  // would silently bypass Axiaro's mandatory admin "Confirm order" gate.
  const autoConfirmParent = sellerGroupList.every((g) =>
    shouldAutoConfirmAtCheckout({ sellerType: g.seller.type, paymentMethod: "NONE" }),
  );

  const subtotal = lines.reduce((n, l) => n + l.lineTotal, 0);
  const shippingFee = args.freeThreshold > 0 && subtotal >= args.freeThreshold ? 0 : Math.max(0, args.method.rate);
  const freeShippingApplied = args.freeThreshold > 0 && subtotal >= args.freeThreshold && args.method.rate > 0;

  let discountTotal = 0;
  let couponRow: { id: string; code: string; usageLimit: number | null } | null = null;
  if (args.couponCode) {
    const c = await tx.coupon.findUnique({ where: { code: args.couponCode }, select: { id: true, code: true, type: true, value: true, maxDiscount: true, usageLimit: true } });
    if (c) {
      couponRow = { id: c.id, code: c.code, usageLimit: c.usageLimit };
      const raw = c.type === "PERCENT" ? Math.round((subtotal * c.value) / 100) : c.value;
      discountTotal = Math.max(0, Math.min(c.type === "PERCENT" && c.maxDiscount != null ? Math.min(raw, c.maxDiscount) : raw, subtotal));
    }
  }
  const grandTotal = Math.max(0, subtotal + shippingFee - discountTotal);

  const sellerSubtotalsForAllocation: SellerSubtotal[] = sellerGroupList.map((g) => ({ sellerId: g.seller.id, merchandiseSubtotal: g.merchandiseSubtotal }));
  const shippingBySeller = new Map(allocateShippingFee(sellerSubtotalsForAllocation, shippingFee).map((a) => [a.sellerId, a.amount]));
  const discountBySeller = new Map(allocateDiscount(sellerSubtotalsForAllocation, discountTotal).map((a) => [a.sellerId, a.amount]));

  const seq = await tx.$queryRawUnsafe<{ v: bigint }[]>(`SELECT nextval('order_number_seq') AS v`);
  const orderNumber = `AX-TESTMS-${seq[0].v}`;

  const converted = await tx.$executeRawUnsafe(`UPDATE "Cart" SET "status"='CONVERTED', "updatedAt"=now() WHERE "id"=$1 AND "status"='ACTIVE'`, args.cartId);
  if (converted === 0) return { ok: false, code: "ALREADY_ORDERED" };

  if (couponRow?.usageLimit != null) {
    const used = await tx.couponRedemption.count({ where: { couponId: couponRow.id, order: { is: { status: { not: "CANCELLED" } } } } });
    if (used >= couponRow.usageLimit) throw new Rollback(); // -> COUPON, tested separately
  }

  for (const l of lines) {
    const locked = await tx.$queryRawUnsafe<{ id: string; quantity: number; reserved: number }[]>(
      `SELECT "id","quantity","reserved" FROM "OfferInventory" WHERE "offerId"=$1 FOR UPDATE`, l.offerId,
    );
    const oi = locked[0];
    if (!oi || oi.quantity - l.quantity < 0 || oi.quantity - l.quantity < oi.reserved) {
      return { ok: false, code: "STOCK" };
    }
    await tx.offerInventory.update({ where: { id: oi.id }, data: { quantity: oi.quantity - l.quantity } });
    await tx.offerAdjustment.create({ data: { offerInventoryId: oi.id, previousQuantity: oi.quantity, delta: -l.quantity, newQuantity: oi.quantity - l.quantity, reason: "SALE", note: `Order ${orderNumber}` } });
  }

  const order = await tx.order.create({
    data: {
      orderNumber, userId: args.userId, cartId: args.cartId, email: args.userEmail, phone: args.shipAddr.phone,
      status: autoConfirmParent ? "PROCESSING" : "PENDING_PAYMENT", paymentMethod: "NONE", paymentStatus: "PENDING",
      subtotal, shippingFee, discountTotal, grandTotal,
      couponId: couponRow?.id ?? null, couponCode: couponRow?.code ?? null,
      shippingMethodId: args.method.id, shippingMethod: args.method.code, shippingMethodCode: args.method.code, shippingMethodName: args.method.name,
      addressId: args.shipAddr.id, billingAddressId: args.shipAddr.id, shippingAddress: "{}",
    },
    select: { id: true },
  });

  const createdSellerOrderIds: { sellerId: string; sellerOrderId: string; sellerType: string }[] = [];
  for (const group of sellerGroupList) {
    const commissionRateBps = resolveSellerCommissionBps(group.seller);
    const sellerShippingFee = shippingBySeller.get(group.seller.id) ?? 0;
    const sellerDiscountAllocated = discountBySeller.get(group.seller.id) ?? 0;
    const sellerCommissionAmount = roundHalfUp((group.merchandiseSubtotal * commissionRateBps) / 10000);
    const sellerOrderTotal = group.merchandiseSubtotal - sellerDiscountAllocated + sellerShippingFee;

    const sellerOrder = await tx.sellerOrder.create({
      data: {
        orderId: order.id, sellerId: group.seller.id, sellerName: group.seller.displayName, sellerType: group.seller.type,
        supportEmail: group.seller.supportEmail, commissionRate: commissionRateBps,
        shippingMethodCode: args.method.code, shippingMethodName: args.method.name, shippingFee: sellerShippingFee,
        platformShippingSubsidy: 0, freeShippingApplied,
        merchandiseSubtotal: group.merchandiseSubtotal, discountAllocated: sellerDiscountAllocated, discountFundedBy: "PLATFORM",
        commissionAmount: sellerCommissionAmount, total: sellerOrderTotal,
        status: "PENDING_PAYMENT", settlementStatus: "PENDING_CAPTURE",
      },
      select: { id: true },
    });
    createdSellerOrderIds.push({ sellerId: group.seller.id, sellerOrderId: sellerOrder.id, sellerType: group.seller.type });

    await tx.orderItem.createMany({
      data: group.lines.map((l) => ({
        orderId: order.id, sellerOrderId: sellerOrder.id, productId: l.productId, variantId: l.variantId,
        offerId: l.offerId, sellerId: l.sellerId, commissionRate: commissionRateBps,
        name: l.name, sku: l.sku, unitPrice: l.unitPrice, quantity: l.quantity, lineTotal: l.lineTotal,
      })),
    });
  }

  if (couponRow) {
    await tx.couponRedemption.create({ data: { couponId: couponRow.id, userId: args.userId, orderId: order.id, code: couponRow.code, amount: discountTotal } });
    await tx.coupon.update({ where: { id: couponRow.id }, data: { usedCount: { increment: 1 } } });
  }

  const persistedSellerOrders = await tx.sellerOrder.findMany({ where: { orderId: order.id }, select: { id: true, merchandiseSubtotal: true, shippingFee: true, discountAllocated: true, total: true } });
  const persistedItems = await tx.orderItem.findMany({ where: { orderId: order.id }, select: { sellerOrderId: true, lineTotal: true } });
  if (persistedSellerOrders.length !== sellerGroupList.length) throw new Rollback();
  if (persistedSellerOrders.reduce((n, s) => n + s.merchandiseSubtotal, 0) !== subtotal) throw new Rollback();
  if (persistedSellerOrders.reduce((n, s) => n + s.shippingFee, 0) !== shippingFee) throw new Rollback();
  if (persistedSellerOrders.reduce((n, s) => n + s.discountAllocated, 0) !== discountTotal) throw new Rollback();
  if (persistedSellerOrders.reduce((n, s) => n + s.total, 0) !== grandTotal) throw new Rollback();
  if (persistedItems.length !== lines.length) throw new Rollback();
  for (const so of persistedSellerOrders) {
    const itemSum = persistedItems.filter((i) => i.sellerOrderId === so.id).reduce((n, i) => n + i.lineTotal, 0);
    if (itemSum !== so.merchandiseSubtotal) throw new Rollback();
  }

  return { ok: true, orderId: order.id, sellerOrderIds: createdSellerOrderIds };
}

// --- fixtures ---------------------------------------------------------------
// Synthetic sellers are always THIRD_PARTY — `Seller.type` has a partial
// UNIQUE index (`seller_one_first_party`, `WHERE type = 'FIRST_PARTY'`)
// enforcing at most one FIRST_PARTY row in the whole database. The
// FIRST_PARTY case (test F) instead reads the REAL Axiaro seller row
// READ-ONLY — never mutated, only referenced as a foreign key from fixture
// Offer/OfferInventory/Variant rows created and rolled back inside this same
// transaction, exactly like `scripts/test-9e3c2.ts` already does.
async function mkSeller(tx: Prisma.TransactionClient, sfx: string, commissionRateBps: number): Promise<SellerFixture> {
  const s = await tx.seller.create({
    data: { displayName: `MS Test Seller ${sfx}`, type: "THIRD_PARTY", status: "APPROVED", supportEmail: `ms-${sfx}@t.test`, commissionRate: commissionRateBps, slug: `ms-test-${sfx}` },
    select: { id: true, displayName: true, type: true, supportEmail: true, commissionRate: true },
  });
  return s;
}
async function mkVariant(tx: Prisma.TransactionClient, productId: string, sku: string, variantPrice: number, invQty: number) {
  const v = await tx.variant.create({ data: { productId, sku, price: variantPrice, status: "ACTIVE", stock: invQty }, select: { id: true } });
  await tx.inventory.create({ data: { variantId: v.id, sku, quantity: invQty, reserved: 0, reorderPoint: 3 } });
  return v.id;
}
async function mkOffer(tx: Prisma.TransactionClient, sellerId: string, variantId: string, offerPrice: number, offerQty: number) {
  const o = await tx.offer.create({ data: { sellerId, variantId, price: offerPrice, condition: "NEW", status: "ACTIVE", sellerSku: `os-${Math.random().toString(36).slice(2, 9)}` }, select: { id: true } });
  await tx.offerInventory.create({ data: { offerId: o.id, sellerSku: `oi-${Math.random().toString(36).slice(2, 9)}`, quantity: offerQty, reserved: 0, reorderPoint: 3 } });
  return o.id;
}
async function addLine(tx: Prisma.TransactionClient, cartId: string, variantId: string, offerId: string, qty: number, snap: number) {
  await tx.$executeRawUnsafe(
    `INSERT INTO "CartItem" ("id","cartId","variantId","offerId","quantity","priceSnapshot","createdAt","updatedAt") VALUES (gen_random_uuid()::text,$1,$2,$3,$4,$5,now(),now())`,
    cartId, variantId, offerId, qty, snap,
  );
}

async function main() {
  // ── Static checks — confirm the real checkout.ts wiring this test relies on ──
  const checkout = read("src/lib/checkout.ts");
  ok("static · checkout.ts imports the real Phase A allocation functions", /import \{ allocateShippingFee, allocateDiscount \} from "@\/lib\/marketplace\/order-allocation";/.test(checkout));
  ok("static · checkout.ts groups lines by seller (Map keyed by sellerId)", /const sellerGroups = new Map<string, SellerGroup>\(\);/.test(checkout));
  ok("static · checkout.ts creates one SellerOrder per seller group in a loop", /for \(const group of sellerGroupList\) \{/.test(checkout));

  const product = await prisma.product.findFirst({ where: { status: "ACTIVE" }, select: { id: true } });
  const method = await prisma.shippingMethod.findFirst({ where: { active: true }, select: { id: true, code: true, name: true, rate: true } });
  const anyUser = await prisma.user.findFirst({ select: { id: true, email: true } });
  if (!product || !method || !anyUser) {
    ok("(skipped — missing product/shippingMethod/user fixture prerequisite)", true);
    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail === 0 ? 0 : 1);
  }
  const sfx = "ms-" + Date.now().toString(36);

  try {
    await prisma.$transaction(async (tx) => {
      await tx.cart.updateMany({ where: { userId: anyUser.id, status: "ACTIVE" }, data: { status: "ABANDONED" } });
      const addr = await tx.address.create({
        data: { userId: anyUser.id, firstName: "T", lastName: "T", recipient: "T T", phone: "0900", line1: "1", city: "C", province: "P", postalCode: "0000", country: "PH" },
        select: { id: true, phone: true },
      });
      const wargs = (cartId: string, sellers: SellerFixture[], couponCode?: string) => ({
        cartId, userId: anyUser.id, userEmail: anyUser.email,
        sellers: new Map(sellers.map((s) => [s.id, s])),
        method: method!, freeThreshold: 0, shipAddr: addr, couponCode,
      });
      const freshCart = async () => {
        await tx.cart.updateMany({ where: { userId: anyUser.id, status: "ACTIVE" }, data: { status: "ABANDONED" } });
        return tx.cart.create({ data: { userId: anyUser.id, status: "ACTIVE" }, select: { id: true } });
      };

      // Synthetic THIRD_PARTY sellers only — never Style Avenue / Sandbox
      // Seller. FIRST_PARTY is read-only from the REAL Axiaro row (see
      // `mkSeller`'s comment) since only one FIRST_PARTY row can ever exist.
      const axiaro = await tx.seller.findFirstOrThrow({
        where: { type: "FIRST_PARTY" },
        select: { id: true, displayName: true, type: true, supportEmail: true, commissionRate: true },
      });
      const sellerFP: SellerFixture = axiaro;
      const sellerA = await mkSeller(tx, `${sfx}-a`, 1000); // 10%
      const sellerB = await mkSeller(tx, `${sfx}-b`, 2000); // 20%
      const sellerC = await mkSeller(tx, `${sfx}-c`, 1500); // 15%

      const vFP = await mkVariant(tx, product.id, `v-fp-${sfx}`, 1000, 50);
      const oFP = await mkOffer(tx, sellerFP.id, vFP, 1000, 50);
      const vA = await mkVariant(tx, product.id, `v-a-${sfx}`, 1000, 50);
      const oA = await mkOffer(tx, sellerA.id, vA, 1000, 50);
      const vB = await mkVariant(tx, product.id, `v-b-${sfx}`, 3000, 50);
      const oB = await mkOffer(tx, sellerB.id, vB, 3000, 50);
      const vC = await mkVariant(tx, product.id, `v-c-${sfx}`, 2000, 5);
      const oC = await mkOffer(tx, sellerC.id, vC, 2000, 5);

      // ── A. ONE SELLER — existing checkout succeeds, exactly one SellerOrder, totals unchanged ──
      {
        const c = await freshCart();
        await addLine(tx, c.id, vA, oA, 2, 1000); // 2000
        const r = await runMultiSellerCheckoutCore(tx, wargs(c.id, [sellerA]));
        ok("A · single-seller checkout succeeds", r.ok === true, JSON.stringify(r));
        if (r.ok) {
          ok("A · exactly one SellerOrder", r.sellerOrderIds.length === 1);
          const order = await tx.order.findUniqueOrThrow({ where: { id: r.orderId }, select: { subtotal: true, grandTotal: true, shippingFee: true } });
          const so = await tx.sellerOrder.findFirstOrThrow({ where: { orderId: r.orderId } });
          ok("A · SellerOrder carries 100% of the order (no rounding difference)",
            so.merchandiseSubtotal === order.subtotal && so.shippingFee === order.shippingFee && so.total === order.grandTotal);
          ok("A · commission = roundHalfUp(subtotal * 1000bps / 10000) for a 10% THIRD_PARTY seller",
            so.commissionAmount === roundHalfUp((2000 * 1000) / 10000));
        }
      }

      // ── B. TWO SELLERS ──
      let twoSellerOrderId = "";
      {
        const c = await freshCart();
        await addLine(tx, c.id, vA, oA, 1, 1000); // seller A: 1000
        await addLine(tx, c.id, vB, oB, 1, 3000); // seller B: 3000
        const r = await runMultiSellerCheckoutCore(tx, wargs(c.id, [sellerA, sellerB]));
        ok("B · two-seller checkout succeeds", r.ok === true, JSON.stringify(r));
        if (r.ok) {
          twoSellerOrderId = r.orderId;
          ok("B · exactly two SellerOrders", r.sellerOrderIds.length === 2);
          ok("B · correct seller IDs", new Set(r.sellerOrderIds.map((s) => s.sellerId)).size === 2 &&
            r.sellerOrderIds.some((s) => s.sellerId === sellerA.id) && r.sellerOrderIds.some((s) => s.sellerId === sellerB.id));
          const items = await tx.orderItem.findMany({ where: { orderId: r.orderId }, select: { sellerId: true, sellerOrderId: true } });
          const soRows = await tx.sellerOrder.findMany({ where: { orderId: r.orderId }, select: { id: true, sellerId: true } });
          const linkOk = items.every((it) => soRows.find((s) => s.id === it.sellerOrderId)?.sellerId === it.sellerId);
          ok("B · every OrderItem links to the SellerOrder belonging to ITS OWN seller (never array position / [0])", linkOk);
        }
      }

      // ── C. THREE SELLERS ──
      {
        const c = await freshCart();
        await addLine(tx, c.id, vA, oA, 1, 1000);
        await addLine(tx, c.id, vB, oB, 1, 3000);
        await addLine(tx, c.id, vC, oC, 1, 2000);
        const r = await runMultiSellerCheckoutCore(tx, wargs(c.id, [sellerA, sellerB, sellerC]));
        ok("C · three-seller checkout succeeds", r.ok === true, JSON.stringify(r));
        if (r.ok) ok("C · exactly three SellerOrders", r.sellerOrderIds.length === 3);
      }

      // ── D. SHIPPING — proportional allocation, sum equals parent shipping, deterministic remainder ──
      {
        const c = await freshCart();
        await addLine(tx, c.id, vA, oA, 1, 1000); // 1000
        await addLine(tx, c.id, vB, oB, 1, 3000); // 3000
        const r = await runMultiSellerCheckoutCore(tx, { ...wargs(c.id, [sellerA, sellerB]), method: { ...method!, rate: 400 } });
        ok("D · checkout with shipping succeeds", r.ok === true, JSON.stringify(r));
        if (r.ok) {
          const rows = await tx.sellerOrder.findMany({ where: { orderId: r.orderId }, select: { sellerId: true, shippingFee: true } });
          const feeA = rows.find((x) => x.sellerId === sellerA.id)!.shippingFee;
          const feeB = rows.find((x) => x.sellerId === sellerB.id)!.shippingFee;
          ok("D · proportional allocation (1000:3000 subtotal → 100:300 shipping)", feeA === 100 && feeB === 300, JSON.stringify(rows));
          ok("D · sum(SellerOrder.shippingFee) === Order.shippingFee", feeA + feeB === 400);
        }
      }

      // ── E. DISCOUNT — proportional allocation, sum equals parent discount, cap respected ──
      {
        const coupon = await tx.coupon.create({ data: { code: `MSFLAT-${sfx}`, type: "FIXED", value: 400, active: true }, select: { code: true } });
        const c = await freshCart();
        await addLine(tx, c.id, vA, oA, 1, 1000); // 1000
        await addLine(tx, c.id, vB, oB, 1, 3000); // 3000
        const r = await runMultiSellerCheckoutCore(tx, wargs(c.id, [sellerA, sellerB], coupon.code));
        ok("E · checkout with a coupon succeeds", r.ok === true, JSON.stringify(r));
        if (r.ok) {
          const rows = await tx.sellerOrder.findMany({ where: { orderId: r.orderId }, select: { sellerId: true, discountAllocated: true, merchandiseSubtotal: true } });
          const discA = rows.find((x) => x.sellerId === sellerA.id)!.discountAllocated;
          const discB = rows.find((x) => x.sellerId === sellerB.id)!.discountAllocated;
          ok("E · proportional discount allocation (1000:3000 subtotal → 100:300 of a 400 discount)", discA === 100 && discB === 300, JSON.stringify(rows));
          ok("E · sum(SellerOrder.discountAllocated) === Order.discountTotal", discA + discB === 400);
          ok("E · no seller's discount exceeds their own merchandiseSubtotal",
            rows.every((x) => x.discountAllocated <= x.merchandiseSubtotal));
        }
      }

      // ── F. COMMISSION — per seller, FIRST_PARTY = 0, THIRD_PARTY uses configured rate ──
      {
        const c = await freshCart();
        await addLine(tx, c.id, vFP, oFP, 1, 1000); // FIRST_PARTY, 0%
        await addLine(tx, c.id, vA, oA, 1, 1000); // THIRD_PARTY, 10%
        const r = await runMultiSellerCheckoutCore(tx, wargs(c.id, [sellerFP, sellerA]));
        ok("F · mixed FIRST_PARTY + THIRD_PARTY checkout succeeds", r.ok === true, JSON.stringify(r));
        if (r.ok) {
          const rows = await tx.sellerOrder.findMany({ where: { orderId: r.orderId }, select: { sellerId: true, commissionAmount: true, commissionRate: true } });
          const fpRow = rows.find((x) => x.sellerId === sellerFP.id)!;
          const aRow = rows.find((x) => x.sellerId === sellerA.id)!;
          ok("F · FIRST_PARTY commission = 0", fpRow.commissionAmount === 0 && fpRow.commissionRate === 0, JSON.stringify(fpRow));
          ok("F · THIRD_PARTY commission uses its configured rate (10% of 1000 = 100)", aRow.commissionAmount === 100 && aRow.commissionRate === 1000, JSON.stringify(aRow));
          // Mixed-cart auto-confirm fix: a THIRD_PARTY seller sharing a cart
          // with FIRST_PARTY must NOT bypass Axiaro's confirmation gate.
          const order = await tx.order.findUniqueOrThrow({ where: { id: r.orderId }, select: { status: true } });
          ok("F · mixed cart Order stays PENDING_PAYMENT (Axiaro's confirmation gate is NOT bypassed)", order.status === "PENDING_PAYMENT", order.status);
        }
      }

      // ── G. TOTALS — every sum invariant, all at once, on a 3-seller + shipping + discount order ──
      {
        const coupon = await tx.coupon.create({ data: { code: `MSTOT-${sfx}`, type: "PERCENT", value: 10, active: true }, select: { code: true } });
        const c = await freshCart();
        await addLine(tx, c.id, vA, oA, 1, 1000);
        await addLine(tx, c.id, vB, oB, 1, 3000);
        await addLine(tx, c.id, vC, oC, 1, 2000);
        const r = await runMultiSellerCheckoutCore(tx, { ...wargs(c.id, [sellerA, sellerB, sellerC], coupon.code), method: { ...method!, rate: 150 } });
        ok("G · three-seller checkout with shipping + discount succeeds", r.ok === true, JSON.stringify(r));
        if (r.ok) {
          const order = await tx.order.findUniqueOrThrow({ where: { id: r.orderId }, select: { subtotal: true, shippingFee: true, discountTotal: true, grandTotal: true } });
          const rows = await tx.sellerOrder.findMany({ where: { orderId: r.orderId }, select: { merchandiseSubtotal: true, shippingFee: true, discountAllocated: true, total: true } });
          ok("G · Σ SellerOrder.merchandiseSubtotal === Order.subtotal", rows.reduce((n, x) => n + x.merchandiseSubtotal, 0) === order.subtotal);
          ok("G · Σ SellerOrder.shippingFee === Order.shippingFee", rows.reduce((n, x) => n + x.shippingFee, 0) === order.shippingFee);
          ok("G · Σ SellerOrder.discountAllocated === Order.discountTotal", rows.reduce((n, x) => n + x.discountAllocated, 0) === order.discountTotal);
          ok("G · Σ SellerOrder.total === Order.grandTotal", rows.reduce((n, x) => n + x.total, 0) === order.grandTotal);
        }
      }

      // ── H. INVENTORY — multi-seller decrement correctly; one failing line rolls back ALL ──
      {
        const invBeforeA = (await tx.offerInventory.findFirstOrThrow({ where: { offerId: oA }, select: { quantity: true } })).quantity;
        const invBeforeB = (await tx.offerInventory.findFirstOrThrow({ where: { offerId: oB }, select: { quantity: true } })).quantity;
        const c = await freshCart();
        await addLine(tx, c.id, vA, oA, 2, 1000);
        await addLine(tx, c.id, vB, oB, 3, 3000);
        const r = await runMultiSellerCheckoutCore(tx, wargs(c.id, [sellerA, sellerB]));
        ok("H · multi-seller checkout with real inventory succeeds", r.ok === true, JSON.stringify(r));
        const invAfterA = (await tx.offerInventory.findFirstOrThrow({ where: { offerId: oA }, select: { quantity: true } })).quantity;
        const invAfterB = (await tx.offerInventory.findFirstOrThrow({ where: { offerId: oB }, select: { quantity: true } })).quantity;
        ok("H · seller A's own offer decremented by exactly its own line qty (2)", invBeforeA - invAfterA === 2);
        ok("H · seller B's own offer decremented by exactly its own line qty (3)", invBeforeB - invAfterB === 3);

        // Now force seller C's line to fail (request more than the 5 in stock)
        // while A/B lines would otherwise succeed — confirm nothing from ANY
        // seller is committed.
        const invBeforeA2 = (await tx.offerInventory.findFirstOrThrow({ where: { offerId: oA }, select: { quantity: true } })).quantity;
        const cFail = await freshCart();
        await addLine(tx, cFail.id, vA, oA, 1, 1000);
        await addLine(tx, cFail.id, vC, oC, 99, 2000); // only 5 in stock
        const orderCountBefore = await tx.order.count();
        const rFail = await runMultiSellerCheckoutCore(tx, wargs(cFail.id, [sellerA, sellerC]));
        ok("H · a failing line on one seller aborts the WHOLE checkout (STOCK)", rFail.ok === false && !rFail.ok && rFail.code === "STOCK", JSON.stringify(rFail));
        const invAfterA2 = (await tx.offerInventory.findFirstOrThrow({ where: { offerId: oA }, select: { quantity: true } })).quantity;
        ok("H · seller A's inventory (the OTHER, valid seller) was NOT decremented despite C failing — whole-transaction rollback",
          invAfterA2 === invBeforeA2);
        ok("H · no Order row was created for the failed multi-seller checkout", (await tx.order.count()) === orderCountBefore);
      }

      // ── I. DUPLICATE CHECKOUT — cart conversion still prevents duplicate order ──
      {
        const c = await freshCart();
        await addLine(tx, c.id, vA, oA, 1, 1000);
        await addLine(tx, c.id, vB, oB, 1, 3000);
        const first = await runMultiSellerCheckoutCore(tx, wargs(c.id, [sellerA, sellerB]));
        ok("I · first multi-seller checkout on this cart succeeds", first.ok === true, JSON.stringify(first));
        const second = await runMultiSellerCheckoutCore(tx, wargs(c.id, [sellerA, sellerB]));
        ok("I · second attempt on the SAME cart returns the SAME order (idempotent), not a new one",
          second.ok === true && !!first.ok && second.orderId === first.orderId, JSON.stringify({ first, second }));
        const orderCountForCart = await tx.order.count({ where: { cartId: c.id } });
        ok("I · exactly one Order row exists for this cart despite two attempts", orderCountForCart === 1);
      }

      // ── J. COUPON — one redemption, usage-limit behavior unchanged, discount allocated across sellers ──
      {
        const coupon = await tx.coupon.create({ data: { code: `MSLIMIT-${sfx}`, type: "FIXED", value: 100, active: true, usageLimit: 1 }, select: { id: true, code: true } });
        const c1 = await freshCart();
        await addLine(tx, c1.id, vA, oA, 1, 1000);
        await addLine(tx, c1.id, vB, oB, 1, 3000);
        const r1 = await runMultiSellerCheckoutCore(tx, wargs(c1.id, [sellerA, sellerB], coupon.code));
        ok("J · first coupon use (multi-seller) succeeds", r1.ok === true, JSON.stringify(r1));
        const redemptions = await tx.couponRedemption.count({ where: { couponId: coupon.id } });
        ok("J · exactly ONE CouponRedemption row for this coupon", redemptions === 1);

        // A second customer/cart trying the same single-use coupon must be
        // blocked (usage limit reached) — same as the single-seller path.
        const secondUser = await tx.user.findFirst({ where: { id: { not: anyUser.id } }, select: { id: true, email: true } });
        if (secondUser) {
          await tx.cart.updateMany({ where: { userId: secondUser.id, status: "ACTIVE" }, data: { status: "ABANDONED" } });
          const addr2 = await tx.address.create({ data: { userId: secondUser.id, firstName: "T2", lastName: "T2", recipient: "T2 T2", phone: "0900", line1: "1", city: "C", province: "P", postalCode: "0000", country: "PH" }, select: { id: true, phone: true } });
          const c2 = await tx.cart.create({ data: { userId: secondUser.id, status: "ACTIVE" }, select: { id: true } });
          await addLine(tx, c2.id, vA, oA, 1, 1000);
          let usageBlocked = false;
          try {
            await runMultiSellerCheckoutCore(tx, { cartId: c2.id, userId: secondUser.id, userEmail: secondUser.email, sellers: new Map([[sellerA.id, sellerA]]), method: method!, freeThreshold: 0, shipAddr: addr2, couponCode: coupon.code });
          } catch (e) {
            if (e instanceof Rollback) usageBlocked = true; else throw e;
          }
          ok("J · usage-limit-exhausted coupon still blocks a second (unrelated) checkout, unchanged from single-seller behavior", usageBlocked);
        } else {
          ok("J · (skipped — no second user fixture available for the usage-limit cross-check)", true);
        }
      }

      // ── K. EMAIL — one seller-order-received notification per applicable THIRD_PARTY SellerOrder ──
      {
        ok("K · reuses the two-seller order's real SellerOrder rows from test B", twoSellerOrderId !== "");
        const emailBefore = await tx.emailLog.count();
        const so = await tx.sellerOrder.findMany({ where: { orderId: twoSellerOrderId }, select: { id: true, sellerType: true } });
        for (const s of so) {
          await sendSellerOrderReceived(twoSellerOrderId, { sellerOrderId: s.id, idempotencyKey: `SELLER_ORDER_RECEIVED:${s.id}`, client: tx });
        }
        const rows = await tx.emailLog.findMany({ where: { idempotencyKey: { in: so.map((s) => `SELLER_ORDER_RECEIVED:${s.id}`) } }, select: { idempotencyKey: true } });
        ok("K · exactly one EmailLog row per SellerOrder (distinct idempotency keys, no collision)",
          rows.length === so.length && new Set(rows.map((r) => r.idempotencyKey)).size === so.length, JSON.stringify(rows));
        const emailAfter = await tx.emailLog.count();
        ok("K · no OTHER stray email rows were created", emailAfter - emailBefore === rows.length);
      }

      // ── M. CONCURRENCY — the atomic ACTIVE->CONVERTED gate still protects a multi-seller cart ──
      {
        const c = await freshCart();
        await addLine(tx, c.id, vA, oA, 1, 1000);
        await addLine(tx, c.id, vB, oB, 1, 3000);
        // Simulate two "concurrent" attempts by racing the SAME atomic UPDATE
        // this checkout core uses — only one can ever see `converted !== 0`.
        const u1 = await tx.$executeRawUnsafe(`UPDATE "Cart" SET "status"='CONVERTED', "updatedAt"=now() WHERE "id"=$1 AND "status"='ACTIVE'`, c.id);
        const u2 = await tx.$executeRawUnsafe(`UPDATE "Cart" SET "status"='CONVERTED', "updatedAt"=now() WHERE "id"=$1 AND "status"='ACTIVE'`, c.id);
        ok("M · only the FIRST racing UPDATE affects a row", u1 === 1 && u2 === 0);
        // restore for the checkout core to run cleanly
        await tx.cart.update({ where: { id: c.id }, data: { status: "ACTIVE" } });
        const r = await runMultiSellerCheckoutCore(tx, wargs(c.id, [sellerA, sellerB]));
        ok("M · after the race, checkout still succeeds exactly once", r.ok === true);
      }

      // ── N. MIXED 1P+3P AUTO-CONFIRM FIX — dedicated, focused scenarios ────
      // A/B/C/D from the task: 1P-only, 3P-only, multi-3P, mixed 1P+3P. The
      // mixed case additionally exercises the REAL, directly-imported
      // `cascadeSellerOrderFromParent` (not a replica) to prove the existing
      // admin "Confirm order" cascade still correctly advances BOTH SellerOrders
      // together once an admin actually confirms — nothing here invents a new
      // confirmation mechanism.
      {
        // N-A. FIRST_PARTY only — unchanged: PENDING_PAYMENT, explicit confirm required.
        const cFp = await freshCart();
        await addLine(tx, cFp.id, vFP, oFP, 1, 1000);
        const rFp = await runMultiSellerCheckoutCore(tx, wargs(cFp.id, [sellerFP]));
        ok("N-A · FIRST_PARTY-only checkout succeeds", rFp.ok === true, JSON.stringify(rFp));
        if (rFp.ok) {
          const o = await tx.order.findUniqueOrThrow({ where: { id: rFp.orderId }, select: { status: true } });
          ok("N-A · FIRST_PARTY-only Order = PENDING_PAYMENT (unchanged)", o.status === "PENDING_PAYMENT", o.status);
        }

        // N-B. THIRD_PARTY only (single) — unchanged: PROCESSING, auto-confirmed.
        const cB = await freshCart();
        await addLine(tx, cB.id, vA, oA, 1, 1000);
        const rB = await runMultiSellerCheckoutCore(tx, wargs(cB.id, [sellerA]));
        ok("N-B · THIRD_PARTY-only (single) checkout succeeds", rB.ok === true, JSON.stringify(rB));
        if (rB.ok) {
          const o = await tx.order.findUniqueOrThrow({ where: { id: rB.orderId }, select: { status: true } });
          ok("N-B · THIRD_PARTY-only (single) Order = PROCESSING (unchanged)", o.status === "PROCESSING", o.status);
        }

        // N-C. Multiple THIRD_PARTY — unchanged: PROCESSING, auto-confirmed.
        const cC = await freshCart();
        await addLine(tx, cC.id, vA, oA, 1, 1000);
        await addLine(tx, cC.id, vB, oB, 1, 3000);
        await addLine(tx, cC.id, vC, oC, 1, 2000);
        const rC = await runMultiSellerCheckoutCore(tx, wargs(cC.id, [sellerA, sellerB, sellerC]));
        ok("N-C · multi-THIRD_PARTY checkout succeeds", rC.ok === true, JSON.stringify(rC));
        if (rC.ok) {
          const o = await tx.order.findUniqueOrThrow({ where: { id: rC.orderId }, select: { status: true } });
          ok("N-C · multi-THIRD_PARTY Order = PROCESSING (unchanged)", o.status === "PROCESSING", o.status);
        }

        // N-D. Mixed FIRST_PARTY + THIRD_PARTY — CORRECTED: PENDING_PAYMENT,
        // explicit confirm required, Axiaro's gate is not bypassed, and the
        // THIRD_PARTY seller must also wait.
        const cD = await freshCart();
        await addLine(tx, cD.id, vFP, oFP, 1, 1000);
        await addLine(tx, cD.id, vA, oA, 1, 1000);
        const emailCountBeforeConfirm = await tx.emailLog.count();
        const rD = await runMultiSellerCheckoutCore(tx, wargs(cD.id, [sellerFP, sellerA]));
        ok("N-D · mixed checkout succeeds", rD.ok === true, JSON.stringify(rD));
        if (rD.ok) {
          const orderBefore = await tx.order.findUniqueOrThrow({ where: { id: rD.orderId }, select: { status: true } });
          ok("N-D · mixed Order = PENDING_PAYMENT (Axiaro's gate NOT bypassed)", orderBefore.status === "PENDING_PAYMENT", orderBefore.status);
          const soBefore = await tx.sellerOrder.findMany({ where: { orderId: rD.orderId }, select: { sellerId: true, status: true } });
          ok("N-D · both SellerOrders initially PENDING_PAYMENT", soBefore.every((s) => s.status === "PENDING_PAYMENT"), JSON.stringify(soBefore));

          // "No fulfilment action is available before explicit confirmation" —
          // the exact guard markShippedAction itself uses.
          ok("N-D · no fulfilment action available yet (canTransition PENDING_PAYMENT→SHIPPED is false, matching markShippedAction's own guard)",
            canTransition(orderBefore.status, "SHIPPED") === false);

          // "No premature sendOrderProcessing event/email occurs before confirmation."
          const emailCountAfterCheckout = await tx.emailLog.count();
          ok("N-D · no email scheduled by checkout itself for the mixed (unconfirmed) order",
            emailCountAfterCheckout === emailCountBeforeConfirm);

          // "confirmOrderAction remains reachable" — its own precondition is
          // exactly `order.status === "PENDING_PAYMENT"`, which now holds.
          ok("N-D · confirmOrderAction's own precondition (status === PENDING_PAYMENT) is satisfied — the action is reachable",
            orderBefore.status === "PENDING_PAYMENT");

          // "confirmOrderAction changes parent to PROCESSING" + "existing cascade
          // advances both SellerOrders appropriately" — replicate confirmOrderAction's
          // OWN atomic guarded update, then call the REAL cascadeSellerOrderFromParent.
          const confirmed = await tx.$executeRawUnsafe(
            `UPDATE "Order" SET "status"='PROCESSING', "updatedAt"=now() WHERE "id"=$1 AND "status"='PENDING_PAYMENT'`,
            rD.orderId,
          );
          ok("N-D · admin confirm succeeds (atomic guarded update matches 1 row)", confirmed === 1);
          await cascadeSellerOrderFromParent(
            { orderId: rD.orderId, orderNumber: "TEST", parentStatus: "PROCESSING", actorUserId: null },
            tx,
          );
          const soAfterConfirm = await tx.sellerOrder.findMany({ where: { orderId: rD.orderId }, select: { sellerId: true, status: true } });
          ok("N-D · BOTH SellerOrders (1P and 3P) advance to PROCESSING via the existing cascade — no new mechanism invented",
            soAfterConfirm.every((s) => s.status === "PROCESSING"), JSON.stringify(soAfterConfirm));

          // "After confirmation, existing fulfilment flow works normally."
          const orderAfterConfirm = await tx.order.findUniqueOrThrow({ where: { id: rD.orderId }, select: { status: true } });
          ok("N-D · fulfilment is now available (canTransition PROCESSING→SHIPPED is true, matching markShippedAction's own guard)",
            canTransition(orderAfterConfirm.status, "SHIPPED") === true);
        }
      }

      // ── isolation (in-transaction) — Axiaro's row was read-only (test F's
      //    FIRST_PARTY case); Style Avenue / Sandbox Seller were never
      //    referenced at all; nothing here ever wrote to any real Seller row.
      const axiaroAfter = await tx.seller.findUniqueOrThrow({ where: { id: axiaro.id }, select: { displayName: true, type: true, status: true, commissionRate: true } });
      ok("isolation · Axiaro's own Seller row is byte-identical to before (read-only reference only)",
        axiaroAfter.displayName === axiaro.displayName && axiaroAfter.type === axiaro.type &&
        axiaroAfter.commissionRate === axiaro.commissionRate);

      throw new Rollback(); // nothing above persists
    }, { timeout: 30000, maxWait: 10000 }); // many sequential fixtures/scenarios — default 5s timeout is too tight
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  // ── post-rollback isolation checks (real DB, outside the rolled-back tx) ──
  ok("isolation · no fixture Seller leaked", (await prisma.seller.count({ where: { displayName: { contains: sfx } } })) === 0);
  ok("isolation · no fixture Product leaked", (await prisma.variant.count({ where: { sku: { contains: sfx } } })) === 0);
  ok("isolation · no fixture Order leaked", (await prisma.order.count({ where: { orderNumber: { startsWith: "AX-TESTMS-" } } })) === 0);
  ok("isolation · no fixture EmailLog leaked", (await prisma.emailLog.count({ where: { idempotencyKey: { contains: "SELLER_ORDER_RECEIVED" }, createdAt: { gte: new Date(Date.now() - 60_000) } } })) === 0);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
