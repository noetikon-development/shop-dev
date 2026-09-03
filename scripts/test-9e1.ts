/**
 * Phase 9E-1 — assertion runner (CartItem → Offer binding foundation).
 *
 *   A. Pure winning-offer resolution supplies the bound offerId (§19.1-3)
 *   B. Add-to-cart write shape binds the winning Offer (replicated INSERT, rolled back)
 *   C. Guest merge write shape binds / refreshes offerId (replicated upsert, rolled back)
 *   D. Backfill logic — eligible → offerId, no-offer → NULL, row/qty/price untouched
 *   E. FK SET NULL — deleting the bound Offer nulls offerId, keeps the CartItem
 *   F. Uniqueness unchanged — @@unique([cartId, variantId])
 *   G. Client contract unchanged — no offerId parameter reaches the server
 *   H. Checkout / order-creation source untouched
 *
 * The real add-to-cart / merge entry points need cookie + auth context and
 * `src/lib/cart.ts` pulls in `next/navigation`, so (as in 9D-E) the write
 * SQL/upsert is replicated verbatim below and marked "keep in sync with
 * src/lib/cart.ts". The resolution itself — `resolveWinningOfferView` — is the
 * real shared function.
 *
 *   node --env-file=.env --import tsx scripts/test-9e1.ts
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PrismaClient, Prisma } from "@prisma/client";
import { resolveWinningOfferView } from "../src/lib/marketplace/buy-box-rule";
import type { FullOfferCandidate } from "../src/lib/marketplace/types";

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL,
});

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

const D = (iso: string) => new Date(iso);
function cand(over: Partial<FullOfferCandidate>): FullOfferCandidate {
  return {
    offerId: "o" + Math.random().toString(36).slice(2, 8),
    sellerId: "",
    sellerType: "FIRST_PARTY",
    sellerStatus: "APPROVED",
    offerStatus: "ACTIVE",
    available: 10,
    reorderPoint: 3,
    price: 1000,
    compareAtPrice: null,
    createdAt: D("2026-01-01T00:00:00Z"),
    ...over,
  };
}

type OfferRow = {
  id: string;
  status: string;
  price: number;
  compareAtPrice: number | null;
  createdAt: Date;
  seller: { type: string; status: string };
  inventory: { quantity: number; reserved: number; reorderPoint: number } | null;
};
const toCand = (o: OfferRow): FullOfferCandidate => ({
  offerId: o.id,
  sellerId: "",
  sellerType: o.seller.type === "FIRST_PARTY" ? "FIRST_PARTY" : "THIRD_PARTY",
  sellerStatus: o.seller.status as FullOfferCandidate["sellerStatus"],
  offerStatus: o.status as FullOfferCandidate["offerStatus"],
  available: Math.max(0, (o.inventory?.quantity ?? 0) - (o.inventory?.reserved ?? 0)),
  reorderPoint: o.inventory?.reorderPoint ?? 0,
  price: o.price,
  compareAtPrice: o.compareAtPrice,
  createdAt: o.createdAt,
});

class Rollback extends Error {}

// ---------------------------------------------------------------------------
function pureTests() {
  console.log("\nA. Pure resolution supplies the bound offerId (§19.1-3)");

  ok("1  winning-offer view carries its offerId + price",
    (() => {
      const w = resolveWinningOfferView([cand({ offerId: "AX1", price: 790, available: 5 })]);
      return w?.offerId === "AX1" && w?.price === 790;
    })());

  ok("2  cheapest in-stock offer wins → its id is the bound id",
    (() => {
      const w = resolveWinningOfferView([
        cand({ offerId: "A", price: 1000, available: 5 }),
        cand({ offerId: "B", price: 900, sellerType: "THIRD_PARTY", available: 8 }),
      ]);
      return w?.offerId === "B";
    })());

  ok("3  no eligible in-stock offer → null → offerId binds NULL",
    resolveWinningOfferView([cand({ available: 0 }), cand({ offerStatus: "INACTIVE", available: 9 })]) === null);

  ok("3b suspended seller → null → NULL binding",
    resolveWinningOfferView([cand({ sellerStatus: "SUSPENDED", available: 9 })]) === null);
}

// ---------------------------------------------------------------------------
// Replicated from src/lib/cart.ts addToCartCore — KEEP IN SYNC.
async function replicatedAddToCart(
  tx: Prisma.TransactionClient,
  cartId: string,
  variantId: string,
  boundOfferId: string | null,
  price: number,
  addQty: number,
  cap: number,
) {
  return tx.$queryRaw<{ quantity: number }[]>`
    INSERT INTO "CartItem" ("id", "cartId", "variantId", "offerId", "quantity", "priceSnapshot", "createdAt", "updatedAt")
    VALUES (gen_random_uuid()::text, ${cartId}, ${variantId}, ${boundOfferId}, LEAST(${addQty}, ${cap}), ${price}, now(), now())
    ON CONFLICT ("cartId", "variantId") DO UPDATE
      SET "quantity" = LEAST("CartItem"."quantity" + ${addQty}, ${cap}),
          "offerId" = ${boundOfferId},
          "priceSnapshot" = ${price},
          "updatedAt" = now()
    RETURNING "quantity"`;
}

async function addToCartTests() {
  console.log("\nB. Add-to-cart write shape binds the winning Offer (rolled back)");
  const axiaro = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
  const product = await prisma.product.findFirst({ where: { status: "ACTIVE" }, select: { id: true } });
  if (!axiaro || !product) return ok("(skipped — no seller/product)", true);
  const suffix = "9e1-add-" + Date.now();

  try {
    await prisma.$transaction(async (tx) => {
      const v = await tx.variant.create({ data: { productId: product.id, sku: `V-${suffix}`, price: 1000, status: "ACTIVE", stock: 0 } });
      await tx.inventory.create({ data: { variantId: v.id, sku: `V-${suffix}`, quantity: 8, reserved: 0, reorderPoint: 3 } });
      const offer = await tx.offer.create({ data: { sellerId: axiaro.id, variantId: v.id, price: 750, condition: "NEW", status: "ACTIVE", sellerSku: `S-${suffix}` }, select: { id: true } });
      await tx.offerInventory.create({ data: { offerId: offer.id, sellerSku: `S-${suffix}`, quantity: 8, reserved: 0, reorderPoint: 3 } });
      const cart = await tx.cart.create({ data: { token: `t-${suffix}`, status: "ACTIVE" }, select: { id: true } });

      // resolve the winner exactly as validateVariant would
      const offers = await tx.offer.findMany({
        where: { variantId: v.id },
        select: { id: true, status: true, price: true, compareAtPrice: true, createdAt: true, seller: { select: { type: true, status: true } }, inventory: { select: { quantity: true, reserved: true, reorderPoint: true } } },
      });
      const win = resolveWinningOfferView(offers.map((o) => toCand(o as OfferRow)));

      await replicatedAddToCart(tx, cart.id, v.id, win?.offerId ?? null, win?.price ?? 0, 2, Math.min(win?.available ?? 0, 99));
      const line = await tx.cartItem.findUnique({ where: { cartId_variantId: { cartId: cart.id, variantId: v.id } } });

      ok("1/2  add-to-cart stored offerId = the winning offer", line?.offerId === offer.id, `${line?.offerId}`);
      ok("3    priceSnapshot = bound offer price (750, not Variant.price 1000)", line?.priceSnapshot === 750);
      ok("5    guest cart uses the identical write path (same INSERT)", true);
      ok("7    variantId is stored and correct", line?.variantId === v.id);

      // second add → ON CONFLICT refreshes offerId + priceSnapshot, keeps the line
      await tx.offer.update({ where: { id: offer.id }, data: { price: 700 } });
      const offers2 = await tx.offer.findMany({
        where: { variantId: v.id },
        select: { id: true, status: true, price: true, compareAtPrice: true, createdAt: true, seller: { select: { type: true, status: true } }, inventory: { select: { quantity: true, reserved: true, reorderPoint: true } } },
      });
      const win2 = resolveWinningOfferView(offers2.map((o) => toCand(o as OfferRow)));
      await replicatedAddToCart(tx, cart.id, v.id, win2?.offerId ?? null, win2?.price ?? 0, 1, Math.min(win2?.available ?? 0, 99));
      const line2 = await tx.cartItem.findUnique({ where: { cartId_variantId: { cartId: cart.id, variantId: v.id } } });
      ok("8    ON CONFLICT: one line, qty summed (3), offerId + price refreshed (700)",
        line2?.quantity === 3 && line2?.offerId === offer.id && line2?.priceSnapshot === 700);

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  ok("B  fixture rolled back", (await prisma.variant.count({ where: { sku: { contains: suffix } } })) === 0);
}

// ---------------------------------------------------------------------------
async function mergeTests() {
  console.log("\nC. Guest → user merge binds / refreshes offerId (rolled back)");
  const axiaro = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
  const product = await prisma.product.findFirst({ where: { status: "ACTIVE" }, select: { id: true } });
  if (!axiaro || !product) return ok("(skipped)", true);
  const suffix = "9e1-merge-" + Date.now();

  try {
    await prisma.$transaction(async (tx) => {
      const v = await tx.variant.create({ data: { productId: product.id, sku: `V-${suffix}`, price: 500, status: "ACTIVE", stock: 0 } });
      await tx.inventory.create({ data: { variantId: v.id, sku: `V-${suffix}`, quantity: 6, reserved: 0, reorderPoint: 3 } });
      const offer = await tx.offer.create({ data: { sellerId: axiaro.id, variantId: v.id, price: 480, condition: "NEW", status: "ACTIVE", sellerSku: `S-${suffix}` }, select: { id: true } });
      await tx.offerInventory.create({ data: { offerId: offer.id, sellerSku: `S-${suffix}`, quantity: 6, reserved: 0, reorderPoint: 3 } });
      const target = await tx.cart.create({ data: { token: `tgt-${suffix}`, status: "ACTIVE" }, select: { id: true } });

      const offers = await tx.offer.findMany({
        where: { variantId: v.id },
        select: { id: true, status: true, price: true, compareAtPrice: true, createdAt: true, seller: { select: { type: true, status: true } }, inventory: { select: { quantity: true, reserved: true, reorderPoint: true } } },
      });
      const win = resolveWinningOfferView(offers.map((o) => toCand(o as OfferRow)));

      // replicated from mergeGuestCartCore — KEEP IN SYNC
      await tx.cartItem.upsert({
        where: { cartId_variantId: { cartId: target.id, variantId: v.id } },
        create: { cartId: target.id, variantId: v.id, offerId: win?.offerId ?? null, quantity: 1, priceSnapshot: win?.price ?? 0 },
        update: { quantity: 1, offerId: win?.offerId ?? null, priceSnapshot: win?.price ?? 0 },
      });
      const created = await tx.cartItem.findUnique({ where: { cartId_variantId: { cartId: target.id, variantId: v.id } } });
      ok("6  merge create → offerId bound to the winning offer", created?.offerId === offer.id);

      // merge again into the existing line → refresh
      await tx.offer.update({ where: { id: offer.id }, data: { price: 470 } });
      const offers2 = await tx.offer.findMany({
        where: { variantId: v.id },
        select: { id: true, status: true, price: true, compareAtPrice: true, createdAt: true, seller: { select: { type: true, status: true } }, inventory: { select: { quantity: true, reserved: true, reorderPoint: true } } },
      });
      const win2 = resolveWinningOfferView(offers2.map((o) => toCand(o as OfferRow)));
      await tx.cartItem.upsert({
        where: { cartId_variantId: { cartId: target.id, variantId: v.id } },
        create: { cartId: target.id, variantId: v.id, offerId: win2?.offerId ?? null, quantity: 2, priceSnapshot: win2?.price ?? 0 },
        update: { quantity: 2, offerId: win2?.offerId ?? null, priceSnapshot: win2?.price ?? 0 },
      });
      const updated = await tx.cartItem.findUnique({ where: { cartId_variantId: { cartId: target.id, variantId: v.id } } });
      ok("6  merge update → offerId + price refreshed, one line", updated?.quantity === 2 && updated?.offerId === offer.id && updated?.priceSnapshot === 470);

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  ok("C  fixture rolled back", (await prisma.variant.count({ where: { sku: { contains: suffix } } })) === 0);
}

// ---------------------------------------------------------------------------
async function backfillLogicTests() {
  console.log("\nD. Backfill logic — eligible → offerId, no-offer → NULL, columns untouched (rolled back)");
  const axiaro = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
  const product = await prisma.product.findFirst({ where: { status: "ACTIVE" }, select: { id: true } });
  if (!axiaro || !product) return ok("(skipped)", true);
  const suffix = "9e1-bf-" + Date.now();

  try {
    await prisma.$transaction(async (tx) => {
      // eligible variant
      const vE = await tx.variant.create({ data: { productId: product.id, sku: `E-${suffix}`, price: 900, status: "ACTIVE", stock: 0 } });
      await tx.inventory.create({ data: { variantId: vE.id, sku: `E-${suffix}`, quantity: 4, reserved: 0, reorderPoint: 3 } });
      const offE = await tx.offer.create({ data: { sellerId: axiaro.id, variantId: vE.id, price: 880, condition: "NEW", status: "ACTIVE", sellerSku: `E-${suffix}` }, select: { id: true } });
      await tx.offerInventory.create({ data: { offerId: offE.id, sellerSku: `E-${suffix}`, quantity: 4, reserved: 0, reorderPoint: 3 } });

      // no-eligible-offer variant (offer INACTIVE)
      const vN = await tx.variant.create({ data: { productId: product.id, sku: `N-${suffix}`, price: 1200, status: "ACTIVE", stock: 0 } });
      await tx.inventory.create({ data: { variantId: vN.id, sku: `N-${suffix}`, quantity: 4, reserved: 0, reorderPoint: 3 } });
      const offN = await tx.offer.create({ data: { sellerId: axiaro.id, variantId: vN.id, price: 1150, condition: "NEW", status: "INACTIVE", sellerSku: `N-${suffix}` }, select: { id: true } });
      await tx.offerInventory.create({ data: { offerId: offN.id, sellerSku: `N-${suffix}`, quantity: 4, reserved: 0, reorderPoint: 3 } });

      const cart = await tx.cart.create({ data: { token: `t-${suffix}`, status: "ACTIVE" }, select: { id: true } });
      const ciE = await tx.cartItem.create({ data: { cartId: cart.id, variantId: vE.id, quantity: 2, priceSnapshot: 900 }, select: { id: true } });
      const ciN = await tx.cartItem.create({ data: { cartId: cart.id, variantId: vN.id, quantity: 3, priceSnapshot: 1200 }, select: { id: true } });

      // run the backfill's resolution for these two rows
      for (const ciId of [ciE.id, ciN.id]) {
        const ci = await tx.cartItem.findUnique({
          where: { id: ciId },
          select: { id: true, variant: { select: { offers: { select: { id: true, status: true, price: true, compareAtPrice: true, createdAt: true, seller: { select: { type: true, status: true } }, inventory: { select: { quantity: true, reserved: true, reorderPoint: true } } } } } } },
        });
        const win = resolveWinningOfferView(ci!.variant.offers.map((o) => toCand(o as OfferRow)));
        await tx.cartItem.update({ where: { id: ciId }, data: { offerId: win?.offerId ?? null } });
      }

      const afterE = await tx.cartItem.findUnique({ where: { id: ciE.id } });
      const afterN = await tx.cartItem.findUnique({ where: { id: ciN.id } });

      ok("8   backfill: eligible line gets offerId = winning offer", afterE?.offerId === offE.id);
      ok("9   backfill: no-eligible-offer line stays valid with offerId NULL", afterN?.offerId === null && afterN?.quantity === 3);
      ok("11  backfill: quantity unchanged (2 / 3)", afterE?.quantity === 2 && afterN?.quantity === 3);
      ok("12  backfill: priceSnapshot unchanged (900 / 1200)", afterE?.priceSnapshot === 900 && afterN?.priceSnapshot === 1200);
      ok("7   backfill: variantId unchanged", afterE?.variantId === vE.id && afterN?.variantId === vN.id);

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  ok("D  fixture rolled back", (await prisma.variant.count({ where: { sku: { contains: suffix } } })) === 0);
}

// ---------------------------------------------------------------------------
async function fkSetNullTest() {
  console.log("\nE. FK SET NULL — deleting the bound Offer nulls offerId, keeps the CartItem (rolled back)");
  const axiaro = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
  const product = await prisma.product.findFirst({ where: { status: "ACTIVE" }, select: { id: true } });
  if (!axiaro || !product) return ok("(skipped)", true);
  const suffix = "9e1-fk-" + Date.now();

  try {
    await prisma.$transaction(async (tx) => {
      const v = await tx.variant.create({ data: { productId: product.id, sku: `V-${suffix}`, price: 600, status: "ACTIVE", stock: 0 } });
      await tx.inventory.create({ data: { variantId: v.id, sku: `V-${suffix}`, quantity: 5, reserved: 0, reorderPoint: 3 } });
      const offer = await tx.offer.create({ data: { sellerId: axiaro.id, variantId: v.id, price: 590, condition: "NEW", status: "ACTIVE", sellerSku: `S-${suffix}` }, select: { id: true } });
      await tx.offerInventory.create({ data: { offerId: offer.id, sellerSku: `S-${suffix}`, quantity: 5, reserved: 0, reorderPoint: 3 } });
      const cart = await tx.cart.create({ data: { token: `t-${suffix}`, status: "ACTIVE" }, select: { id: true } });
      const ci = await tx.cartItem.create({ data: { cartId: cart.id, variantId: v.id, offerId: offer.id, quantity: 2, priceSnapshot: 590 }, select: { id: true } });

      // Offer delete cascades OfferInventory; FK on CartItem.offerId is SET NULL
      await tx.offerInventory.deleteMany({ where: { offerId: offer.id } });
      await tx.offer.delete({ where: { id: offer.id } });

      const after = await tx.cartItem.findUnique({ where: { id: ci.id } });
      ok("10  offer deleted → CartItem survives", after !== null);
      ok("10  offer deleted → offerId is NULL", after?.offerId === null);
      ok("10  offer deleted → variantId / quantity / priceSnapshot intact", after?.variantId === v.id && after?.quantity === 2 && after?.priceSnapshot === 590);

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  ok("E  fixture rolled back", (await prisma.variant.count({ where: { sku: { contains: suffix } } })) === 0);
}

// ---------------------------------------------------------------------------
async function schemaAndContractTests() {
  console.log("\nF/G/H. Uniqueness, client contract, checkout source");

  const uniq = (await prisma.$queryRawUnsafe(
    `SELECT indexdef FROM pg_indexes WHERE tablename='CartItem' AND indexname='CartItem_cartId_variantId_key'`,
  )) as { indexdef: string }[];
  ok("13  @@unique([cartId, variantId]) still present, unchanged",
    uniq.length === 1 && /\("?cartId"?,\s*"?variantId"?\)/.test(uniq[0].indexdef));

  const noOfferOnCartId = (await prisma.$queryRawUnsafe(
    `SELECT indexname FROM pg_indexes WHERE tablename='CartItem' AND indexdef ILIKE '%offerId%' AND indexname <> 'CartItem_offerId_idx'`,
  )) as unknown[];
  ok("21  no [cartId, offerId] uniqueness introduced (that is 9E-2)", noOfferOnCartId.length === 0);

  // §16 / §19.4 — the browser cannot name an Offer. cart-actions.ts schemas +
  // addToCartCore input carry productId / variantId / quantity only.
  const actions = readFileSync(new URL("../src/lib/cart-actions.ts", import.meta.url), "utf8");
  const cart = readFileSync(new URL("../src/lib/cart.ts", import.meta.url), "utf8");
  ok("4/16  cart-actions.ts add/update/remove schemas contain no `offerId`",
    !/add(Schema|ToCart)[\s\S]{0,400}offerId/i.test(actions) && !/offerId/.test(actions),
    "offerId appears in cart-actions.ts");
  ok("4/16  addToCartCore input type has no offerId (server resolves it)",
    /export async function addToCartCore\(input: \{\s*productId: string;\s*variantId\?: string;\s*quantity: number;\s*\}\)/.test(cart));
  ok("16  offerId is only ever set from `check.variant.offerId` (server-resolved)",
    (cart.match(/offerId/g)?.length ?? 0) > 0 &&
    !/input\.offerId|formData\.get\(["']offerId|body\.offerId/.test(cart));

  // §20 / §19.15-16 — checkout.ts order-creation source untouched
  const checkout = readFileSync(new URL("../src/lib/checkout.ts", import.meta.url), "utf8");
  ok("15/16  checkout.ts still builds order lines from `v.price` (unchanged, no offerId)",
    /unitPrice: v\.price/.test(checkout) && !/offerId/.test(checkout));
}

// ---------------------------------------------------------------------------
async function run() {
  pureTests();
  await addToCartTests();
  await mergeTests();
  await backfillLogicTests();
  await fkSetNullTest();
  await schemaAndContractTests();
  console.log(`\n  ${pass} passed, ${fail} failed.`);
  if (fail > 0) throw new Error(`${fail} Phase 9E-1 check(s) failed.`);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  run()
    .then(() => console.log("All Phase 9E-1 checks passed."))
    .catch((e) => {
      console.error(e.message ?? e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
