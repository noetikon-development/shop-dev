/**
 * Phase 9E-3C-2 — assertion runner (offer-native checkout writer).
 *
 * `src/lib/checkout.ts` pulls in `next/navigation` (via auth) and can't load in
 * a standalone script, so the CHECKOUT-WRITER CORE below is REPLICATED from
 * `createOrderFromCart` and marked "keep in sync with src/lib/checkout.ts".
 * Every DB test runs inside ONE `prisma.$transaction` that builds fixtures,
 * runs the replicated writer, asserts, then throws to ROLL BACK — nothing
 * persists. The 9E-3C-1 schema is already applied to the shared DB, so no DDL
 * is applied here.
 *
 * Groups (spec §22):
 *   A  single Axiaro checkout -> 1 Order + 1 SellerOrder + N OrderItems
 *   B  Offer.price is the checkout price (not Variant.price)
 *   C  a Variant.price != Offer.price mismatch does NOT change the order price
 *   D  inactive Offer            -> abort, nothing created
 *   E  missing / mis-bound Offer -> abort
 *   F  inactive Seller           -> abort
 *   G  insufficient OfferInventory -> abort
 *   H  two distinct sellers      -> abort (SELLER)
 *   I  duplicate checkout        -> one Order (cart CONVERTED gate)
 *   J  SellerOrder == exactly 1
 *   K  OrderItems link to the SellerOrder
 *   L  OrderItems snapshot offerId / sellerId / commissionRate
 *   M  commissionRate == 0 for Axiaro
 *   N  CouponRedemption written once, discount allocated to the SellerOrder
 *   O  Cart converts only on success (abort leaves it ACTIVE)
 *   P  9E-3D-5: OfferInventory deducted; legacy Inventory UNCHANGED; zero SALE InventoryAdjustment
 *   Q  9E-3D-5: OfferInventory is the sole checkout gate (frozen Inventory ignored)
 *   R  reconciliation: grandTotal == SellerOrder.total == merch - disc + ship
 *   S  static: no Variant.price in the checkout price path; no resolveWinningOfferView;
 *      feature gate false; no seller/offer-count auto-enable
 *
 *   node --env-file=.env --import tsx scripts/test-9e3c2.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
class Rollback extends Error {}

function roundHalfUp(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

type WriterResult = { ok: true; orderId: string } | { ok: false; code: string };

// --- keep in sync with src/lib/checkout.ts createOrderFromCart -------------
async function runCheckoutCore(
  tx: Prisma.TransactionClient,
  args: { cartId: string; userId: string; userEmail: string; method: { id: string; code: string; name: string; rate: number }; freeThreshold: number; shipAddr: { id: string; phone: string } },
): Promise<WriterResult> {
  const cart = await tx.cart.findUnique({
    where: { id: args.cartId },
    include: {
      items: {
        orderBy: { createdAt: "asc" },
        include: {
          offer: {
            select: {
              id: true, status: true, price: true, compareAtPrice: true, variantId: true,
              seller: { select: { id: true, displayName: true, type: true, status: true, supportEmail: true, commissionRate: true } },
              inventory: { select: { quantity: true, reserved: true } },
            },
          },
          variant: { select: { id: true, sku: true, status: true, productId: true, product: { select: { id: true, slug: true, name: true, status: true } } } },
        },
      },
    },
  });
  if (!cart) return { ok: false, code: "EMPTY" };
  if (cart.status !== "ACTIVE") {
    // Mirrors createOrderFromCart: a cart that is already CONVERTED (double
    // submit) hands back the order that got created, not an error.
    const existing = await tx.order.findFirst({ where: { cartId: args.cartId }, select: { id: true } });
    return existing ? { ok: true, orderId: existing.id } : { ok: false, code: "ALREADY_ORDERED" };
  }
  if (cart.items.length === 0) return { ok: false, code: "EMPTY" };

  const sellerIds = new Set<string>();
  let seller: (typeof cart.items)[number]["offer"]["seller"] | null = null;
  const lines: { productId: string; variantId: string; offerId: string; sellerId: string; name: string; sku: string; unitPrice: number; quantity: number; lineTotal: number }[] = [];
  const problems: string[] = [];

  for (const item of cart.items) {
    const v = item.variant, p = v.product, o = item.offer;
    if (!o || !item.offerId || o.variantId !== item.variantId) { problems.push(p.name); continue; }
    if (p.status !== "ACTIVE" || v.status !== "ACTIVE" || o.status !== "ACTIVE" || o.seller.status !== "APPROVED") { problems.push(p.name); continue; }
    const available = o.inventory ? Math.max(0, o.inventory.quantity - o.inventory.reserved) : 0;
    if (!o.inventory || available < item.quantity) { problems.push(p.name); continue; }
    sellerIds.add(o.seller.id);
    seller = o.seller;
    lines.push({ productId: p.id, variantId: v.id, offerId: o.id, sellerId: o.seller.id, name: p.name, sku: v.sku, unitPrice: o.price, quantity: item.quantity, lineTotal: o.price * item.quantity });
  }
  if (problems.length > 0) return { ok: false, code: "STOCK" };
  if (lines.length === 0 || !seller) return { ok: false, code: "EMPTY" };
  if (sellerIds.size !== 1) return { ok: false, code: "SELLER" };
  const soSeller = seller;

  const subtotal = lines.reduce((n, l) => n + l.lineTotal, 0);
  const shippingFee = args.freeThreshold > 0 && subtotal >= args.freeThreshold ? 0 : Math.max(0, args.method.rate);
  const freeShippingApplied = args.freeThreshold > 0 && subtotal >= args.freeThreshold && args.method.rate > 0;
  const discountTotal = 0; // coupon path exercised separately in N
  const grandTotal = Math.max(0, subtotal + shippingFee - discountTotal);
  const sellerCommissionAmount = roundHalfUp((subtotal * soSeller.commissionRate) / 10000);
  const sellerOrderTotal = subtotal - discountTotal + shippingFee;

  const seq = await tx.$queryRawUnsafe<{ v: bigint }[]>(`SELECT nextval('order_number_seq') AS v`);
  const orderNumber = `AX-TEST-${seq[0].v}`;

  const converted = await tx.$executeRawUnsafe(`UPDATE "Cart" SET "status"='CONVERTED', "updatedAt"=now() WHERE "id"=$1 AND "status"='ACTIVE'`, args.cartId);
  if (converted === 0) return { ok: false, code: "ALREADY_ORDERED" };

  for (const l of lines) {
    // Phase 9E-3D-5: OfferInventory SALE commit ONLY — no Inventory mirror, no
    // InventoryAdjustment, no Variant.stock write. (keep in sync with
    // src/lib/checkout.ts + src/lib/marketplace/offer-inventory.ts)
    const locked = await tx.$queryRawUnsafe<{ id: string; quantity: number; reserved: number }[]>(`SELECT "id","quantity","reserved" FROM "OfferInventory" WHERE "offerId"=$1 FOR UPDATE`, l.offerId);
    const oi = locked[0];
    if (!oi || oi.quantity - l.quantity < 0 || oi.quantity - l.quantity < oi.reserved) throw new Rollback(); // -> STOCK
    await tx.offerInventory.update({ where: { id: oi.id }, data: { quantity: oi.quantity - l.quantity } });
    await tx.offerAdjustment.create({ data: { offerInventoryId: oi.id, previousQuantity: oi.quantity, delta: -l.quantity, newQuantity: oi.quantity - l.quantity, reason: "SALE", note: `Order ${orderNumber}` } });
  }

  const order = await tx.order.create({
    data: {
      orderNumber, userId: args.userId, cartId: args.cartId, email: args.userEmail, phone: args.shipAddr.phone,
      status: "PENDING_PAYMENT", paymentMethod: "NONE", paymentStatus: "PENDING",
      subtotal, shippingFee, discountTotal, grandTotal,
      shippingMethodId: args.method.id, shippingMethod: args.method.code, shippingMethodCode: args.method.code, shippingMethodName: args.method.name,
      addressId: args.shipAddr.id, billingAddressId: args.shipAddr.id, shippingAddress: "{}",
    },
    select: { id: true },
  });
  const so = await tx.sellerOrder.create({
    data: {
      orderId: order.id, sellerId: soSeller.id, sellerName: soSeller.displayName, sellerType: soSeller.type,
      supportEmail: soSeller.supportEmail, commissionRate: soSeller.commissionRate,
      shippingMethodCode: args.method.code, shippingMethodName: args.method.name, shippingFee,
      platformShippingSubsidy: 0, freeShippingApplied,
      merchandiseSubtotal: subtotal, discountAllocated: discountTotal, discountFundedBy: "PLATFORM",
      commissionAmount: sellerCommissionAmount, total: sellerOrderTotal,
      status: "PENDING_PAYMENT", settlementStatus: "PENDING_CAPTURE",
    },
    select: { id: true },
  });
  await tx.orderItem.createMany({
    data: lines.map((l) => ({
      orderId: order.id, sellerOrderId: so.id, productId: l.productId, variantId: l.variantId,
      offerId: l.offerId, sellerId: l.sellerId, commissionRate: soSeller.commissionRate,
      name: l.name, sku: l.sku, unitPrice: l.unitPrice, quantity: l.quantity, lineTotal: l.lineTotal,
    })),
  });
  const soCount = await tx.sellerOrder.count({ where: { orderId: order.id } });
  const linked = await tx.orderItem.count({ where: { orderId: order.id, sellerOrderId: so.id, sellerId: soSeller.id } });
  if (soCount !== 1 || linked !== lines.length) throw new Rollback();

  return { ok: true, orderId: order.id };
}

// --- fixtures -------------------------------------------------------------
async function mkVariant(tx: Prisma.TransactionClient, productId: string, sku: string, variantPrice: number, invQty: number) {
  const v = await tx.variant.create({ data: { productId, sku, price: variantPrice, status: "ACTIVE", stock: invQty }, select: { id: true } });
  await tx.inventory.create({ data: { variantId: v.id, sku, quantity: invQty, reserved: 0, reorderPoint: 3 } });
  return v.id;
}
async function mkOffer(tx: Prisma.TransactionClient, sellerId: string, variantId: string, offerPrice: number, offerQty: number, status = "ACTIVE") {
  const o = await tx.offer.create({ data: { sellerId, variantId, price: offerPrice, condition: "NEW", status, sellerSku: `os-${Math.random().toString(36).slice(2, 9)}` }, select: { id: true } });
  await tx.offerInventory.create({ data: { offerId: o.id, sellerSku: `oi-${Math.random().toString(36).slice(2, 9)}`, quantity: offerQty, reserved: 0, reorderPoint: 3 } });
  return o.id;
}
async function addLine(tx: Prisma.TransactionClient, cartId: string, variantId: string, offerId: string, qty: number, snap: number) {
  await tx.$executeRawUnsafe(
    `INSERT INTO "CartItem" ("id","cartId","variantId","offerId","quantity","priceSnapshot","createdAt","updatedAt") VALUES (gen_random_uuid()::text,$1,$2,$3,$4,$5,now(),now())`,
    cartId, variantId, offerId, qty, snap,
  );
}

async function dbTests() {
  const axiaro = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true, displayName: true, type: true, supportEmail: true, commissionRate: true } });
  const product = await prisma.product.findFirst({ where: { status: "ACTIVE" }, select: { id: true } });
  const method = await prisma.shippingMethod.findFirst({ where: { active: true }, select: { id: true, code: true, name: true, rate: true } });
  const anyUser = await prisma.user.findFirst({ select: { id: true, email: true } });
  if (!axiaro || !product || !method || !anyUser) return ok("(skipped — missing seller/product/method/user)", true);
  const sfx = "9e3c2-" + Date.now();

  try {
    await prisma.$transaction(async (tx) => {
      const addr = await tx.address.create({ data: { userId: anyUser.id, firstName: "T", lastName: "T", recipient: "T T", phone: "0900", line1: "1", city: "C", province: "P", postalCode: "0000", country: "PH" }, select: { id: true, phone: true } });
      const wargs = (cartId: string) => ({ cartId, userId: anyUser.id, userEmail: anyUser.email, method: method!, freeThreshold: 0, shipAddr: addr });
      // The partial unique index allows only one ACTIVE cart per user — free the
      // slot for the user-bound fixtures (rolled back with everything else).
      await tx.cart.updateMany({ where: { userId: anyUser.id, status: "ACTIVE" }, data: { status: "ABANDONED" } });

      // fixture 1: Variant.price 999 but Offer.price 1000 (mismatch) — B/C
      const v1 = await mkVariant(tx, product.id, `v1-${sfx}`, 999, 20);
      const o1 = await mkOffer(tx, axiaro.id, v1, 1000, 20);
      const v2 = await mkVariant(tx, product.id, `v2-${sfx}`, 500, 20);
      const o2 = await mkOffer(tx, axiaro.id, v2, 500, 20);

      // A/B/C/J/K/L/M/P/R — single Axiaro checkout, two lines
      const c1 = await tx.cart.create({ data: { userId: anyUser.id, status: "ACTIVE" }, select: { id: true } });
      // ensure no other ACTIVE cart collides
      await tx.cart.updateMany({ where: { userId: anyUser.id, status: "ACTIVE", id: { not: c1.id } }, data: { status: "ABANDONED" } });
      await addLine(tx, c1.id, v1, o1, 2, 1000);
      await addLine(tx, c1.id, v2, o2, 1, 500);
      const invBefore1 = (await tx.inventory.findUnique({ where: { variantId: v1 }, select: { quantity: true } }))!.quantity;
      const oiBefore1 = (await tx.offerInventory.findFirst({ where: { offerId: o1 }, select: { quantity: true } }))!.quantity;

      const r1 = await runCheckoutCore(tx, wargs(c1.id));
      ok("A  single Axiaro checkout succeeds", r1.ok === true);
      if (!r1.ok) throw new Rollback();

      const order1 = await tx.order.findUniqueOrThrow({ where: { id: r1.orderId }, include: { items: { orderBy: { unitPrice: "asc" } }, sellerOrders: { include: { items: true } } } });
      ok("J  exactly 1 SellerOrder", order1.sellerOrders.length === 1);
      const so1 = order1.sellerOrders[0];
      ok("K  every OrderItem links to that SellerOrder", order1.items.length === 2 && order1.items.every((it) => it.sellerOrderId === so1.id));
      ok("B  OrderItem.unitPrice == Offer.price (1000 / 500), NOT Variant.price (999 / 500)", order1.items[0].unitPrice === 500 && order1.items[1].unitPrice === 1000);
      ok("C  order subtotal from Offer.price: 2·1000 + 1·500 = 2500 (not 2·999+500=2498)", order1.subtotal === 2500 && so1.merchandiseSubtotal === 2500);
      ok("L  OrderItems snapshot offerId + sellerId", order1.items.every((it) => (it.offerId === o1 || it.offerId === o2) && it.sellerId === axiaro.id));
      ok("M  commissionRate 0 on SellerOrder + every OrderItem; commissionAmount 0", so1.commissionRate === 0 && so1.commissionAmount === 0 && order1.items.every((it) => it.commissionRate === 0));
      ok("R  grandTotal == SellerOrder.total == merch - disc + ship", order1.grandTotal === so1.total && so1.total === so1.merchandiseSubtotal - so1.discountAllocated + so1.shippingFee);
      ok("L  SellerOrder seller snapshot (name / type / supportEmail / fundedBy)", so1.sellerName === axiaro.displayName && so1.sellerType === "FIRST_PARTY" && so1.supportEmail === axiaro.supportEmail && so1.discountFundedBy === "PLATFORM");

      const invAfter1 = (await tx.inventory.findUnique({ where: { variantId: v1 }, select: { quantity: true } }))!.quantity;
      const oiAfter1 = (await tx.offerInventory.findFirst({ where: { offerId: o1 }, select: { quantity: true } }))!.quantity;
      ok("P  9E-3D-5: OfferInventory deducted by 2 for v1; legacy Inventory UNCHANGED", oiBefore1 - oiAfter1 === 2 && invBefore1 - invAfter1 === 0);
      const oiAdj = await tx.offerAdjustment.count({ where: { reason: "SALE", note: `Order ${order1.orderNumber}` } });
      const invAdj = await tx.inventoryAdjustment.count({ where: { reason: "SALE", note: `Order ${order1.orderNumber}` } });
      ok("P  one SALE OfferAdjustment per line; ZERO SALE InventoryAdjustment", oiAdj === 2 && invAdj === 0);

      // O — cart converted only on success
      const c1after = await tx.cart.findUniqueOrThrow({ where: { id: c1.id }, select: { status: true } });
      ok("O  cart -> CONVERTED after successful order", c1after.status === "CONVERTED");

      // I — duplicate checkout: no 2nd Order (cart already CONVERTED); the
      // caller gets the order that already exists.
      const rDup = await runCheckoutCore(tx, wargs(c1.id));
      ok("I  second checkout returns the existing order, creates no 2nd Order", rDup.ok === true && rDup.orderId === r1.orderId);
      ok("I  still exactly one Order + one SellerOrder for that cart", (await tx.order.count({ where: { cartId: c1.id } })) === 1 && (await tx.sellerOrder.count({ where: { orderId: r1.orderId } })) === 1);

      // D — inactive Offer aborts, nothing created, cart stays ACTIVE
      const v3 = await mkVariant(tx, product.id, `v3-${sfx}`, 700, 10);
      const o3 = await mkOffer(tx, axiaro.id, v3, 700, 10, "INACTIVE");
      const cD = await tx.cart.create({ data: { token: `tD-${sfx}`, status: "ACTIVE" }, select: { id: true } });
      await addLine(tx, cD.id, v3, o3, 1, 700);
      const rD = await runCheckoutCore(tx, wargs(cD.id));
      ok("D  inactive Offer -> abort (STOCK), no Order, cart still ACTIVE", rD.ok === false && rD.code === "STOCK" && (await tx.order.count({ where: { cartId: cD.id } })) === 0 && (await tx.cart.findUniqueOrThrow({ where: { id: cD.id }, select: { status: true } })).status === "ACTIVE");

      // E — mis-bound offer (offerId belongs to a different variant)
      const cE = await tx.cart.create({ data: { token: `tE-${sfx}`, status: "ACTIVE" }, select: { id: true } });
      await tx.$executeRawUnsafe(`INSERT INTO "CartItem" ("id","cartId","variantId","offerId","quantity","priceSnapshot","createdAt","updatedAt") VALUES (gen_random_uuid()::text,$1,$2,$3,1,500,now(),now())`, cE.id, v3, o2); // v3 line bound to o2 (v2's offer)
      const rE = await runCheckoutCore(tx, wargs(cE.id));
      ok("E  mis-bound Offer (wrong variant) -> abort, no Order", rE.ok === false && (await tx.order.count({ where: { cartId: cE.id } })) === 0);

      // F — inactive seller
      const sellerB = await tx.seller.create({ data: { type: "THIRD_PARTY", status: "SUSPENDED", displayName: "B", slug: `b-${sfx}`, supportEmail: "b@b.test" }, select: { id: true } });
      const v4 = await mkVariant(tx, product.id, `v4-${sfx}`, 300, 10);
      const o4 = await mkOffer(tx, sellerB.id, v4, 300, 10);
      const cF = await tx.cart.create({ data: { token: `tF-${sfx}`, status: "ACTIVE" }, select: { id: true } });
      await addLine(tx, cF.id, v4, o4, 1, 300);
      const rF = await runCheckoutCore(tx, wargs(cF.id));
      ok("F  suspended Seller -> abort, no Order", rF.ok === false && (await tx.order.count({ where: { cartId: cF.id } })) === 0);

      // G — insufficient OfferInventory
      const v5 = await mkVariant(tx, product.id, `v5-${sfx}`, 400, 10);
      const o5 = await mkOffer(tx, axiaro.id, v5, 400, 1); // only 1 in stock
      const cG = await tx.cart.create({ data: { token: `tG-${sfx}`, status: "ACTIVE" }, select: { id: true } });
      await addLine(tx, cG.id, v5, o5, 3, 400);
      const rG = await runCheckoutCore(tx, wargs(cG.id));
      ok("G  insufficient OfferInventory -> abort (STOCK), no Order", rG.ok === false && rG.code === "STOCK" && (await tx.order.count({ where: { cartId: cG.id } })) === 0);

      // H — two distinct sellers -> SELLER abort
      const sellerC = await tx.seller.create({ data: { type: "THIRD_PARTY", status: "APPROVED", displayName: "C", slug: `c-${sfx}`, supportEmail: "c@c.test" }, select: { id: true } });
      const v6 = await mkVariant(tx, product.id, `v6-${sfx}`, 600, 10);
      const o6 = await mkOffer(tx, sellerC.id, v6, 600, 10);
      const cH = await tx.cart.create({ data: { token: `tH-${sfx}`, status: "ACTIVE" }, select: { id: true } });
      await addLine(tx, cH.id, v2, o2, 1, 500); // Axiaro
      await addLine(tx, cH.id, v6, o6, 1, 600); // Seller C
      const rH = await runCheckoutCore(tx, wargs(cH.id));
      ok("H  two sellers -> abort with SELLER, no Order, cart still ACTIVE", rH.ok === false && rH.code === "SELLER" && (await tx.order.count({ where: { cartId: cH.id } })) === 0 && (await tx.cart.findUniqueOrThrow({ where: { id: cH.id }, select: { status: true } })).status === "ACTIVE");

      // N — coupon: discount allocated to the SellerOrder, one CouponRedemption
      const coupon = await tx.coupon.create({ data: { code: `TEST${seqSuffix(sfx)}`, type: "FIXED", value: 200, minSubtotal: 0, active: true }, select: { id: true, code: true, value: true, type: true } });
      const cN = await tx.cart.create({ data: { userId: anyUser.id, status: "ACTIVE", couponCode: coupon.code }, select: { id: true } });
      await tx.cart.updateMany({ where: { userId: anyUser.id, status: "ACTIVE", id: { not: cN.id } }, data: { status: "ABANDONED" } });
      await addLine(tx, cN.id, v2, o2, 2, 500); // subtotal 1000
      const rN = await runCheckoutCoreWithCoupon(tx, { ...wargs(cN.id), coupon: { id: coupon.id, code: coupon.code, value: coupon.value, type: coupon.type } });
      ok("N  coupon checkout succeeds", rN.ok === true);
      if (rN.ok) {
        const oN = await tx.order.findUniqueOrThrow({ where: { id: rN.orderId }, include: { sellerOrders: true, couponRedemption: true } });
        ok("N  discountTotal 200 on Order; discountAllocated 200 on the SellerOrder; funded by PLATFORM", oN.discountTotal === 200 && oN.sellerOrders[0].discountAllocated === 200 && oN.sellerOrders[0].discountFundedBy === "PLATFORM");
        ok("N  exactly one CouponRedemption for the order", oN.couponRedemption != null);
        ok("N  SellerOrder.total == merch - disc + ship == grandTotal", oN.sellerOrders[0].total === oN.sellerOrders[0].merchandiseSubtotal - 200 + oN.sellerOrders[0].shippingFee && oN.sellerOrders[0].total === oN.grandTotal);
      }

      // Q — 9E-3D-5: OfferInventory is the SOLE checkout gate. An order that
      //     OfferInventory can cover succeeds even when the now-frozen legacy
      //     Inventory row could not — and Inventory is left untouched.
      const v7 = await mkVariant(tx, product.id, `v7-${sfx}`, 800, 5);
      const o7 = await mkOffer(tx, axiaro.id, v7, 800, 50); // OfferInventory 50, Inventory only 5
      await tx.inventory.update({ where: { variantId: v7 }, data: { quantity: 1 } }); // frozen Inventory now 1
      const cQ = await tx.cart.create({ data: { token: `tQ-${sfx}`, status: "ACTIVE" }, select: { id: true } });
      await addLine(tx, cQ.id, v7, o7, 3, 800); // OfferInventory covers 3; legacy Inventory (1) does not
      const oiQBefore = (await tx.offerInventory.findFirst({ where: { offerId: o7 }, select: { quantity: true } }))!.quantity;
      const rQ = await runCheckoutCore(tx, wargs(cQ.id));
      const oiQAfter = (await tx.offerInventory.findFirst({ where: { offerId: o7 }, select: { quantity: true } }))!.quantity;
      const invQAfter = (await tx.inventory.findUnique({ where: { variantId: v7 }, select: { quantity: true } }))!.quantity;
      ok("Q  OfferInventory is the sole gate — checkout succeeds (OfferInv 50→47), frozen Inventory untouched at 1", rQ.ok === true && oiQBefore - oiQAfter === 3 && invQAfter === 1);

      throw new Rollback();
    }, { timeout: 45000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  const leaked = await prisma.variant.count({ where: { sku: { contains: sfx } } });
  const leakedOrders = await prisma.order.count({ where: { orderNumber: { contains: "AX-TEST-" } } });
  ok("ROLLBACK  no fixture variant leaked", leaked === 0, String(leaked));
  ok("ROLLBACK  no test order persisted", leakedOrders === 0, String(leakedOrders));
}

function seqSuffix(s: string) { return s.replace(/[^A-Z0-9]/gi, "").slice(-6).toUpperCase(); }

// coupon variant of the writer core (only the discount path differs)
async function runCheckoutCoreWithCoupon(
  tx: Prisma.TransactionClient,
  args: Parameters<typeof runCheckoutCore>[1] & { coupon: { id: string; code: string; value: number; type: string } },
): Promise<WriterResult> {
  // Minimal: reuse runCheckoutCore's validation by duplicating just enough.
  const cart = await tx.cart.findUniqueOrThrow({ where: { id: args.cartId }, include: { items: { include: { offer: { select: { id: true, status: true, price: true, variantId: true, seller: { select: { id: true, displayName: true, type: true, status: true, supportEmail: true, commissionRate: true } }, inventory: { select: { quantity: true, reserved: true } } } }, variant: { select: { id: true, sku: true, status: true, productId: true, product: { select: { id: true, slug: true, name: true, status: true } } } } } } } });
  const lines = cart.items.map((it) => ({ productId: it.variant.product.id, variantId: it.variant.id, offerId: it.offer.id, sellerId: it.offer.seller.id, name: it.variant.product.name, sku: it.variant.sku, unitPrice: it.offer.price, quantity: it.quantity, lineTotal: it.offer.price * it.quantity }));
  const soSeller = cart.items[0].offer.seller;
  const subtotal = lines.reduce((n, l) => n + l.lineTotal, 0);
  const shippingFee = args.freeThreshold > 0 && subtotal >= args.freeThreshold ? 0 : Math.max(0, args.method.rate);
  const discountTotal = Math.max(0, Math.min(args.coupon.value, subtotal));
  const grandTotal = Math.max(0, subtotal + shippingFee - discountTotal);
  const seq = await tx.$queryRawUnsafe<{ v: bigint }[]>(`SELECT nextval('order_number_seq') AS v`);
  const orderNumber = `AX-TEST-${seq[0].v}`;
  await tx.$executeRawUnsafe(`UPDATE "Cart" SET "status"='CONVERTED' WHERE "id"=$1 AND "status"='ACTIVE'`, args.cartId);
  await tx.$queryRawUnsafe(`SELECT "id" FROM "Coupon" WHERE "id"=$1 FOR UPDATE`, args.coupon.id);
  for (const l of lines) {
    // Phase 9E-3D-5: OfferInventory SALE commit ONLY.
    const oi = (await tx.$queryRawUnsafe<{ id: string; quantity: number; reserved: number }[]>(`SELECT "id","quantity","reserved" FROM "OfferInventory" WHERE "offerId"=$1 FOR UPDATE`, l.offerId))[0];
    await tx.offerInventory.update({ where: { id: oi.id }, data: { quantity: oi.quantity - l.quantity } });
    await tx.offerAdjustment.create({ data: { offerInventoryId: oi.id, previousQuantity: oi.quantity, delta: -l.quantity, newQuantity: oi.quantity - l.quantity, reason: "SALE", note: `Order ${orderNumber}` } });
  }
  const order = await tx.order.create({ data: { orderNumber, userId: args.userId, cartId: args.cartId, email: args.userEmail, phone: args.shipAddr.phone, status: "PENDING_PAYMENT", paymentMethod: "NONE", paymentStatus: "PENDING", subtotal, shippingFee, discountTotal, grandTotal, couponId: args.coupon.id, couponCode: args.coupon.code, discountType: args.coupon.type, discountValue: args.coupon.value, shippingMethodId: args.method.id, shippingMethod: args.method.code, shippingMethodCode: args.method.code, shippingMethodName: args.method.name, addressId: args.shipAddr.id, billingAddressId: args.shipAddr.id, shippingAddress: "{}" }, select: { id: true } });
  const so = await tx.sellerOrder.create({ data: { orderId: order.id, sellerId: soSeller.id, sellerName: soSeller.displayName, sellerType: soSeller.type, supportEmail: soSeller.supportEmail, commissionRate: soSeller.commissionRate, shippingMethodCode: args.method.code, shippingMethodName: args.method.name, shippingFee, platformShippingSubsidy: 0, freeShippingApplied: false, merchandiseSubtotal: subtotal, discountAllocated: discountTotal, discountFundedBy: "PLATFORM", commissionAmount: roundHalfUp((subtotal * soSeller.commissionRate) / 10000), total: subtotal - discountTotal + shippingFee, status: "PENDING_PAYMENT", settlementStatus: "PENDING_CAPTURE" }, select: { id: true } });
  await tx.orderItem.createMany({ data: lines.map((l) => ({ orderId: order.id, sellerOrderId: so.id, productId: l.productId, variantId: l.variantId, offerId: l.offerId, sellerId: l.sellerId, commissionRate: soSeller.commissionRate, name: l.name, sku: l.sku, unitPrice: l.unitPrice, quantity: l.quantity, lineTotal: l.lineTotal })) });
  await tx.couponRedemption.create({ data: { couponId: args.coupon.id, userId: args.userId, orderId: order.id, code: args.coupon.code, amount: discountTotal } });
  return { ok: true, orderId: order.id };
}

function staticChecks() {
  console.log("\nS. static — checkout price path, no rebind, feature gate");
  const checkout = readFileSync(new URL("../src/lib/checkout.ts", import.meta.url), "utf8");
  const flow = readFileSync(new URL("../src/components/checkout/checkout-flow.tsx", import.meta.url), "utf8");
  const registry = readFileSync(new URL("../src/lib/admin/settings-registry.ts", import.meta.url), "utf8");
  const offerInv = readFileSync(new URL("../src/lib/marketplace/offer-inventory.ts", import.meta.url), "utf8");

  // strip block + line comments so the regexes test CODE, not prose
  const code = checkout.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\/\/.*$/gm, "");
  const oiCode = offerInv.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\/\/.*$/gm, "");

  ok("S  createOrderFromCart no longer prices from v.price", !/unitPrice:\s*v\.price/.test(code) && !/v\.price\s*\*\s*item\.quantity/.test(code));
  ok("S  checkout price is the bound offer price (o.price)", /unitPrice:\s*o\.price/.test(code) && /o\.price\s*\*\s*item\.quantity/.test(code));
  ok("S  checkout does NOT call resolveWinningOfferView / re-pick the offer", !/resolveWinningOfferView\s*\(|pickWinningOffer\s*\(|getWinningOffer\s*\(|from ["']@\/lib\/marketplace\/(buy-box|offer-resolver)/.test(code));
  ok("S  9E-3D-5: checkout commits OfferInventory ONLY — commitOfferStockForSale, NO adjustStock / Inventory mirror", /commitOfferStockForSale\s*\(/.test(code) && !/adjustStock\s*\(/.test(code) && !/from ["']@\/lib\/inventory["']/.test(checkout));
  ok("S  single-seller gate present (sellerIds.size !== 1 -> SELLER)", /sellerIds\.size !== 1/.test(code) && /code: "SELLER"/.test(code));
  ok("S  exactly one SellerOrder asserted before commit", /soCount !== 1/.test(code));
  ok("S  checkout-flow treats SELLER like STOCK (back to bag)", /res\.code === "SELLER"/.test(flow));
  ok("S  offer-inventory writer touches OfferInventory only (no Inventory / Variant.stock)", !/tx\.inventory\.|prisma\.inventory\.|(FROM|UPDATE|INTO)\s+"Inventory"|"Variant"\s+SET/i.test(oiCode));
  ok("S  marketplace.multiSellerCheckout still NOT in SETTINGS_REGISTRY", !/marketplace\.multiSellerCheckout/.test(registry));
  ok("S  no seller/offer/SellerOrder-count auto-enables multi-seller in checkout", !/multiSellerCheckout/.test(code) && !/if\s*\([^)]*seller[^)]*count[^)]*>\s*1/i.test(code));
}

async function gateCheck() {
  const g = await prisma.storeSetting.findUnique({ where: { key: "marketplace.multiSellerCheckout" } });
  ok("GATE  marketplace.multiSellerCheckout == 'false'", g?.value === "false", g?.value ?? "<absent>");
}

async function run() {
  await dbTests();
  staticChecks();
  await gateCheck();
  console.log(`\n  ${pass} passed, ${fail} failed.`);
  if (fail > 0) throw new Error(`${fail} Phase 9E-3C-2 check(s) failed.`);
}

run()
  .then(() => console.log("All Phase 9E-3C-2 checks passed."))
  .catch((e) => { console.error(e.message ?? e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
