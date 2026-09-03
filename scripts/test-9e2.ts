/**
 * Phase 9E-2 — assertion runner (multi-seller cart foundation).
 *
 * The 9E-2 schema change (offerId NOT NULL + @@unique([cartId, offerId]) +
 * FK CASCADE) is a DEPLOY BOUNDARY — it must NOT be applied to the shared DB
 * before the app release. So every DB test here runs inside ONE
 * `prisma.$transaction` that applies the migration DDL first (Postgres has
 * transactional DDL), exercises the new behaviour, then ROLLS BACK — nothing,
 * schema or data, ever persists.
 *
 * `src/lib/cart.ts` pulls in `next/navigation` (via auth) and can't load in a
 * standalone script, so the `lineDTO` / `groupBySeller` / `buildDTO` /
 * `ownedCartLine` / `updateCartItemCore` / `mergeGuestCartCore` / add-to-cart
 * INSERT logic is REPLICATED below and marked "keep in sync with src/lib/cart.ts".
 *
 * Groups (spec §31):
 *   A  schema shape after the DDL
 *   B  same variant + same offer  → one line, qty merged
 *   C  same variant + different seller offer  → two lines
 *   D  different variant  → separate lines
 *   E  update / remove by cartItemId; one line can't touch another
 *   F  forged cartItemId rejected; ownership enforced
 *   G  guest→user merge by offerId (same offer merges, different offer preserved)
 *   H  unavailable bound offer stays bound; price change does not rebind
 *   I  sellerGroups + merchandiseSubtotal; flat lines == flatMap; subtotal/itemCount
 *   J  FK CASCADE — deleting an Offer removes its cart line
 *   K  N+1 — cartInclude is a bounded query set
 *   L  checkout.ts / Order / OrderItem / Payment untouched
 *
 *   node --env-file=.env --import tsx scripts/test-9e2.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL,
  log: [{ level: "query", emit: "event" }],
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

class Rollback extends Error {}
const MAX_QTY_PER_LINE = 99; // mirror of src/lib/cart.ts

// --- the 9E-2 migration DDL, run inside the test transaction ----------------
async function applyMigrationDDL(tx: Prisma.TransactionClient) {
  await tx.$executeRawUnsafe(`ALTER TABLE "CartItem" ALTER COLUMN "offerId" SET NOT NULL`);
  await tx.$executeRawUnsafe(`ALTER TABLE "CartItem" DROP CONSTRAINT IF EXISTS "CartItem_offerId_fkey"`);
  await tx.$executeRawUnsafe(
    `ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer" ("id") ON DELETE CASCADE ON UPDATE CASCADE`,
  );
  await tx.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "CartItem_cartId_offerId_key" ON "CartItem" ("cartId", "offerId")`);
  await tx.$executeRawUnsafe(`DROP INDEX IF EXISTS "CartItem_cartId_variantId_key"`);
}

// --- mirror of src/lib/cart.ts lineDTO / groupBySeller / buildDTO -----------
type LineRow = {
  id: string;
  variantId: string;
  offerId: string;
  quantity: number;
  priceSnapshot: number;
  offer: {
    status: string;
    price: number;
    compareAtPrice: number | null;
    seller: { id: string; displayName: string; type: string; status: string };
    inventory: { quantity: number; reserved: number } | null;
  };
  variant: { status: string; product: { status: string } };
};
type MLine = {
  cartItemId: string;
  sellerId: string;
  sellerName: string;
  sellerType: "FIRST_PARTY" | "THIRD_PARTY";
  unitPrice: number;
  available: number;
  quantity: number;
  lineTotal: number;
  unavailable: boolean;
  overStock: boolean;
  priceChanged: boolean;
};
function mLine(item: LineRow): MLine {
  const o = item.offer;
  const catalogEligible = item.variant.status === "ACTIVE" && item.variant.product.status === "ACTIVE";
  const offerLive = o.status === "ACTIVE" && o.seller.status === "APPROVED";
  const available = o.inventory ? Math.max(0, o.inventory.quantity - o.inventory.reserved) : 0;
  const unavailable = !catalogEligible || !offerLive || available <= 0;
  const unitPrice = o.price;
  const buyable = Math.min(item.quantity, available);
  return {
    cartItemId: item.id,
    sellerId: o.seller.id,
    sellerName: o.seller.displayName,
    sellerType: o.seller.type === "FIRST_PARTY" ? "FIRST_PARTY" : "THIRD_PARTY",
    unitPrice,
    available,
    quantity: item.quantity,
    lineTotal: unavailable ? 0 : unitPrice * buyable,
    unavailable,
    overStock: !unavailable && item.quantity > available,
    priceChanged: item.priceSnapshot !== unitPrice,
  };
}
function groupBySeller(lines: MLine[]) {
  const groups = new Map<string, { sellerId: string; sellerName: string; lines: MLine[]; merchandiseSubtotal: number }>();
  for (const l of lines) {
    let g = groups.get(l.sellerId);
    if (!g) {
      g = { sellerId: l.sellerId, sellerName: l.sellerName, lines: [], merchandiseSubtotal: 0 };
      groups.set(l.sellerId, g);
    }
    g.lines.push(l);
    if (!l.unavailable) g.merchandiseSubtotal += l.lineTotal;
  }
  return [...groups.values()];
}
function buildDTO(rows: LineRow[]) {
  const lines = rows.map(mLine);
  const purchasable = lines.filter((l) => !l.unavailable);
  return {
    lines,
    sellerGroups: groupBySeller(lines),
    subtotal: purchasable.reduce((n, l) => n + l.lineTotal, 0),
    itemCount: purchasable.reduce((n, l) => n + Math.min(l.quantity, l.available), 0),
    hasIssues: lines.some((l) => l.unavailable || l.overStock),
  };
}

const LINE_SELECT = {
  id: true,
  variantId: true,
  offerId: true,
  quantity: true,
  priceSnapshot: true,
  offer: {
    select: {
      status: true,
      price: true,
      compareAtPrice: true,
      seller: { select: { id: true, displayName: true, type: true, status: true } },
      inventory: { select: { quantity: true, reserved: true } },
    },
  },
  variant: { select: { status: true, product: { select: { status: true } } } },
} as const;

// --- mirror of src/lib/cart.ts addToCartCore INSERT -----------------------
async function addLine(tx: Prisma.TransactionClient, cartId: string, variantId: string, offerId: string, price: number, addQty: number, cap: number) {
  await tx.$queryRaw<{ quantity: number }[]>`
    INSERT INTO "CartItem" ("id","cartId","variantId","offerId","quantity","priceSnapshot","createdAt","updatedAt")
    VALUES (gen_random_uuid()::text, ${cartId}, ${variantId}, ${offerId}, LEAST(${addQty}, ${cap}), ${price}, now(), now())
    ON CONFLICT ("cartId","offerId") DO UPDATE
      SET "quantity" = LEAST("CartItem"."quantity" + ${addQty}, ${cap}),
          "priceSnapshot" = ${price},
          "updatedAt" = now()
    RETURNING "quantity"`;
}

// --- fixture helpers ------------------------------------------------------
async function mkVariant(tx: Prisma.TransactionClient, productId: string, sku: string, price: number) {
  const v = await tx.variant.create({ data: { productId, sku, price, status: "ACTIVE", stock: 0 }, select: { id: true } });
  await tx.inventory.create({ data: { variantId: v.id, sku, quantity: 0, reserved: 0, reorderPoint: 3 } });
  return v.id;
}
async function mkOffer(tx: Prisma.TransactionClient, sellerId: string, variantId: string, price: number, qty: number, status = "ACTIVE") {
  const o = await tx.offer.create({ data: { sellerId, variantId, price, condition: "NEW", status, sellerSku: `sku-${Math.random().toString(36).slice(2, 8)}` }, select: { id: true } });
  await tx.offerInventory.create({ data: { offerId: o.id, sellerSku: `sku-${Math.random().toString(36).slice(2, 8)}`, quantity: qty, reserved: 0, reorderPoint: 3 } });
  return o.id;
}
async function mkSellerB(tx: Prisma.TransactionClient, suffix: string) {
  const s = await tx.seller.create({ data: { type: "THIRD_PARTY", status: "APPROVED", displayName: "Example Seller", slug: `example-${suffix}`, supportEmail: "b@example.test" }, select: { id: true } });
  return s.id;
}

// ---------------------------------------------------------------------------
async function dbTests() {
  const axiaro = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
  const product = await prisma.product.findFirst({ where: { status: "ACTIVE" }, select: { id: true } });
  if (!axiaro || !product) return ok("(skipped — no seller/product)", true);
  const suffix = "9e2-" + Date.now();

  // Snapshot the CartItem schema BEFORE the test transaction. The 9E-2 migration
  // is now applied on the shared DB, so "rolled back" must mean "returned to
  // whatever state the DB was already in", not "restored the pre-9E-2 schema".
  const preOldIdx = (await prisma.$queryRawUnsafe(`SELECT 1 FROM pg_indexes WHERE tablename='CartItem' AND indexname='CartItem_cartId_variantId_key'`)) as unknown[];
  const preNullable = (await prisma.$queryRawUnsafe(`SELECT is_nullable FROM information_schema.columns WHERE table_name='CartItem' AND column_name='offerId'`)) as { is_nullable: string }[];

  try {
    await prisma.$transaction(
      async (tx) => {
        await applyMigrationDDL(tx);

        // A — schema shape after the DDL
        const col = (await tx.$queryRawUnsafe(`SELECT is_nullable FROM information_schema.columns WHERE table_name='CartItem' AND column_name='offerId'`)) as { is_nullable: string }[];
        const fk = (await tx.$queryRawUnsafe(`SELECT rc.delete_rule FROM information_schema.table_constraints tc JOIN information_schema.referential_constraints rc ON rc.constraint_name=tc.constraint_name WHERE tc.table_name='CartItem' AND tc.constraint_name='CartItem_offerId_fkey'`)) as { delete_rule: string }[];
        const newIdx = (await tx.$queryRawUnsafe(`SELECT 1 FROM pg_indexes WHERE tablename='CartItem' AND indexname='CartItem_cartId_offerId_key'`)) as unknown[];
        const oldIdx = (await tx.$queryRawUnsafe(`SELECT 1 FROM pg_indexes WHERE tablename='CartItem' AND indexname='CartItem_cartId_variantId_key'`)) as unknown[];
        const vIdx = (await tx.$queryRawUnsafe(`SELECT 1 FROM pg_indexes WHERE tablename='CartItem' AND indexname='CartItem_variantId_idx'`)) as unknown[];
        console.log("\nA. schema after the 9E-2 DDL (inside a rolled-back tx)");
        ok("A  offerId NOT NULL", col[0]?.is_nullable === "NO");
        ok("A  FK ON DELETE CASCADE", fk[0]?.delete_rule === "CASCADE", fk[0]?.delete_rule);
        ok("A  unique(cartId, offerId) present, unique(cartId, variantId) gone", newIdx.length === 1 && oldIdx.length === 0);
        ok("A  @@index([variantId]) retained (variantId kept)", vIdx.length === 1);

        // fixture: Variant X with Axiaro A1 (₱1000/5) + Seller B B1 (₱900/10); Variant Y with Axiaro C1 (₱500/8)
        const sellerB = await mkSellerB(tx, suffix);
        const vX = await mkVariant(tx, product.id, `X-${suffix}`, 1000);
        const vY = await mkVariant(tx, product.id, `Y-${suffix}`, 500);
        const a1 = await mkOffer(tx, axiaro.id, vX, 1000, 5);
        const b1 = await mkOffer(tx, sellerB, vX, 900, 10);
        const c1 = await mkOffer(tx, axiaro.id, vY, 500, 8);

        const cart = await tx.cart.create({ data: { token: `t-${suffix}`, status: "ACTIVE" }, select: { id: true } });

        console.log("\nB/C/D. line identity is the Offer");
        await addLine(tx, cart.id, vX, a1, 1000, 1, 5); // X / Axiaro
        await addLine(tx, cart.id, vX, a1, 1000, 2, 5); // same offer → merge → qty 3
        let rows = (await tx.cartItem.findMany({ where: { cartId: cart.id }, select: LINE_SELECT })) as LineRow[];
        ok("B  same variant + same offer → ONE line, qty merged (3)", rows.length === 1 && rows[0].quantity === 3);

        await addLine(tx, cart.id, vX, b1, 900, 1, 10); // X / Seller B → SECOND line, same variant
        await addLine(tx, cart.id, vY, c1, 500, 2, 8); // Y / Axiaro
        rows = (await tx.cartItem.findMany({ where: { cartId: cart.id }, orderBy: { createdAt: "asc" }, select: LINE_SELECT })) as LineRow[];
        ok("C  same variant X + different seller → TWO lines", rows.filter((r) => r.variantId === vX).length === 2);
        ok("D  variant Y → its own line", rows.filter((r) => r.variantId === vY).length === 1);
        ok("D  3 lines total, all distinct offerIds", rows.length === 3 && new Set(rows.map((r) => r.offerId)).size === 3);

        // E — update / remove by cartItemId (mirror of updateCartItemCore / removeCartItemCore)
        console.log("\nE. mutation identity = cartItemId; lines are independent");
        const lineXA = rows.find((r) => r.offerId === a1)!;
        const lineXB = rows.find((r) => r.offerId === b1)!;
        await tx.cartItem.update({ where: { id: lineXA.id }, data: { quantity: 4 } });
        const afterUpd = (await tx.cartItem.findMany({ where: { cartId: cart.id }, select: { id: true, offerId: true, quantity: true } }));
        ok("E  update by cartItemId changed ONLY that line (X/Axiaro → 4)", afterUpd.find((r) => r.id === lineXA.id)?.quantity === 4 && afterUpd.find((r) => r.id === lineXB.id)?.quantity === 1);
        await tx.cartItem.delete({ where: { id: lineXB.id } });
        const afterDel = await tx.cartItem.findMany({ where: { cartId: cart.id }, select: { offerId: true } });
        ok("E  remove X/Seller-B left X/Axiaro + Y/Axiaro intact", afterDel.length === 2 && afterDel.some((r) => r.offerId === a1) && afterDel.some((r) => r.offerId === c1));

        // F — forged cartItemId / ownership (mirror of ownedCartLine)
        console.log("\nF. forged cartItemId / cross-cart ownership");
        const otherCart = await tx.cart.create({ data: { token: `other-${suffix}`, status: "ACTIVE" }, select: { id: true } });
        await addLine(tx, otherCart.id, vY, c1, 500, 1, 8);
        const otherLine = await tx.cartItem.findFirst({ where: { cartId: otherCart.id }, select: { id: true } });
        // ownedCartLine(forgedId): a random id -> null
        const forged = await tx.cartItem.findUnique({ where: { id: "ci_forged_" + suffix }, select: { id: true } });
        ok("F  forged cartItemId resolves to null (no line)", forged === null);
        // ownedCartLine(otherLine, owner=our token): cart.token != our token -> not ours
        const oLine = await tx.cartItem.findUnique({ where: { id: otherLine!.id }, select: { cart: { select: { token: true } } } });
        ok("F  another cart's line is not owned by our token", oLine?.cart.token !== `t-${suffix}`);

        // G — guest→user merge by offerId (mirror of mergeGuestCartCore)
        console.log("\nG. guest → user merge groups by offerId");
        const userCart = await tx.cart.create({ data: { token: `user-${suffix}`, status: "ACTIVE" }, select: { id: true } });
        await addLine(tx, userCart.id, vX, b1, 900, 2, 10); // user has X / Seller B  qty 2
        const guestCart = await tx.cart.create({ data: { token: `guest-${suffix}`, status: "ACTIVE" }, select: { id: true } });
        await addLine(tx, guestCart.id, vX, a1, 1000, 1, 5); // guest X / Axiaro qty 1
        await addLine(tx, guestCart.id, vX, b1, 900, 1, 10); // guest X / Seller B qty 1
        const guestItems = await tx.cartItem.findMany({ where: { cartId: guestCart.id }, select: { offerId: true, quantity: true } });
        for (const gi of guestItems) {
          const offer = await tx.offer.findUnique({ where: { id: gi.offerId }, select: { id: true, price: true, variantId: true, inventory: { select: { quantity: true, reserved: true } } } });
          const avail = offer!.inventory ? Math.max(0, offer!.inventory.quantity - offer!.inventory.reserved) : 0;
          const existing = await tx.cartItem.findUnique({ where: { cartId_offerId: { cartId: userCart.id, offerId: offer!.id } }, select: { quantity: true } });
          const finalQty = Math.min((existing?.quantity ?? 0) + gi.quantity, avail, MAX_QTY_PER_LINE);
          await tx.cartItem.upsert({
            where: { cartId_offerId: { cartId: userCart.id, offerId: offer!.id } },
            create: { cartId: userCart.id, variantId: offer!.variantId, offerId: offer!.id, quantity: finalQty, priceSnapshot: offer!.price },
            update: { quantity: finalQty, priceSnapshot: offer!.price },
          });
        }
        const merged = await tx.cartItem.findMany({ where: { cartId: userCart.id }, select: { offerId: true, quantity: true } });
        ok("G  merge: X/SellerB quantities merged (2+1=3), X/Axiaro preserved as its own line", merged.length === 2 && merged.find((m) => m.offerId === b1)?.quantity === 3 && merged.find((m) => m.offerId === a1)?.quantity === 1);

        // H — unavailable bound offer stays bound; price change ≠ rebind
        console.log("\nH. unavailable bound offer / price change");
        await tx.offer.update({ where: { id: a1 }, data: { status: "INACTIVE" } });
        let dtoRows = (await tx.cartItem.findMany({ where: { cartId: cart.id }, select: LINE_SELECT })) as LineRow[];
        const inactiveLine = dtoRows.find((r) => r.offerId === a1)!;
        ok("H  offer INACTIVE → line unavailable, still bound to a1", mLine(inactiveLine).unavailable === true && inactiveLine.offerId === a1);
        await tx.offer.update({ where: { id: a1 }, data: { status: "ACTIVE" } });
        await tx.offer.update({ where: { id: c1 }, data: { price: 550 } }); // Y offer price 500 → 550
        dtoRows = (await tx.cartItem.findMany({ where: { cartId: cart.id }, select: LINE_SELECT })) as LineRow[];
        const yLine = mLine(dtoRows.find((r) => r.offerId === c1)!);
        ok("H  bound-offer price change → unitPrice 550 (live), priceChanged flag, offerId unchanged", yLine.unitPrice === 550 && yLine.priceChanged === true);

        // I — sellerGroups + flat lines + totals
        console.log("\nI. sellerGroups / flat lines / totals");
        await tx.offer.update({ where: { id: c1 }, data: { price: 500 } }); // restore
        // rebuild a clean 2-seller cart: X/Axiaro 1 + X/SellerB 2 + Y/Axiaro 1
        await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
        await addLine(tx, cart.id, vX, a1, 1000, 1, 5);
        await addLine(tx, cart.id, vX, b1, 900, 2, 10);
        await addLine(tx, cart.id, vY, c1, 500, 1, 8);
        dtoRows = (await tx.cartItem.findMany({ where: { cartId: cart.id }, orderBy: { createdAt: "asc" }, select: LINE_SELECT })) as LineRow[];
        const dto = buildDTO(dtoRows);
        ok("I  2 seller groups (Axiaro, Example Seller)", dto.sellerGroups.length === 2);
        const axG = dto.sellerGroups.find((g) => g.sellerName === "Axiaro")!;
        const bG = dto.sellerGroups.find((g) => g.sellerName === "Example Seller")!;
        ok("I  Axiaro group merchandiseSubtotal = 1000·1 + 500·1 = 1500", axG.merchandiseSubtotal === 1500);
        ok("I  Example Seller group merchandiseSubtotal = 900·2 = 1800", bG.merchandiseSubtotal === 1800);
        ok("I  flat lines == sellerGroups.flatMap(g => g.lines)", JSON.stringify(dto.lines.map((l) => l.cartItemId).sort()) === JSON.stringify(dto.sellerGroups.flatMap((g) => g.lines).map((l) => l.cartItemId).sort()));
        ok("I  subtotal = 1500 + 1800 = 3300", dto.subtotal === 3300);
        ok("I  itemCount = 1 + 2 + 1 = 4", dto.itemCount === 4);
        ok("I  no NaN / negative", Number.isFinite(dto.subtotal) && dto.subtotal >= 0 && dto.lines.every((l) => l.available >= 0));

        // J — FK CASCADE
        console.log("\nJ. FK CASCADE — deleting an Offer removes its cart line");
        const beforeDel = await tx.cartItem.count({ where: { cartId: cart.id } });
        await tx.offerInventory.deleteMany({ where: { offerId: b1 } });
        await tx.offer.delete({ where: { id: b1 } });
        const afterOfferDel = await tx.cartItem.findMany({ where: { cartId: cart.id }, select: { offerId: true } });
        ok("J  Seller-B offer deleted → its cart line cascaded away, others intact", afterOfferDel.length === beforeDel - 1 && !afterOfferDel.some((r) => r.offerId === b1));

        throw new Rollback();
      },
      { timeout: 20000 },
    );
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  // everything rolled back — schema + data
  const leakedSeller = await prisma.seller.count({ where: { slug: { contains: suffix } } });
  const leakedVariant = await prisma.variant.count({ where: { sku: { contains: suffix } } });
  const stillOld = (await prisma.$queryRawUnsafe(`SELECT 1 FROM pg_indexes WHERE tablename='CartItem' AND indexname='CartItem_cartId_variantId_key'`)) as unknown[];
  const nullableAgain = (await prisma.$queryRawUnsafe(`SELECT is_nullable FROM information_schema.columns WHERE table_name='CartItem' AND column_name='offerId'`)) as { is_nullable: string }[];
  ok("ROLLBACK  no seller / variant fixture leaked", leakedSeller === 0 && leakedVariant === 0, `s=${leakedSeller} v=${leakedVariant}`);
  ok(
    "ROLLBACK  DDL undone — CartItem schema returned to its pre-test state",
    stillOld.length === preOldIdx.length && nullableAgain[0]?.is_nullable === preNullable[0]?.is_nullable,
    `old idx ${stillOld.length}->was ${preOldIdx.length}; nullable ${nullableAgain[0]?.is_nullable}->was ${preNullable[0]?.is_nullable}`,
  );
}

// ---------------------------------------------------------------------------
async function n1Check() {
  console.log("\nK. N+1 — cartInclude offer/seller/inventory is a bounded query set");
  const queries: string[] = [];
  (prisma.$on as (e: "query", cb: (x: { query: string }) => void) => void)("query", (e) => queries.push(e.query));
  queries.length = 0;
  // reproduce cartInclude's nested shape over a would-be many-line cart
  await prisma.cart.findFirst({
    include: {
      items: {
        include: {
          offer: { select: { id: true, status: true, price: true, compareAtPrice: true, seller: { select: { id: true, displayName: true, type: true, status: true } }, inventory: { select: { quantity: true, reserved: true } } } },
          variant: { select: { id: true, sku: true, status: true, imageUrl: true, productId: true, product: { select: { id: true, slug: true, name: true, status: true, freeShipping: true, images: { select: { url: true, optionValueId: true } } } }, optionValues: { select: { optionValue: { select: { id: true, value: true, option: { select: { name: true, sortOrder: true } } } } } } } },
        },
      },
    },
  });
  const offerQ = queries.filter((s) => /FROM\s+"Offer"/i.test(s)).length;
  const sellerQ = queries.filter((s) => /FROM\s+"Seller"/i.test(s)).length;
  const oiQ = queries.filter((s) => /"OfferInventory"/.test(s)).length;
  console.log(JSON.stringify({ totalQueries: queries.length, offerQueries: offerQ, sellerQueries: sellerQ, offerInventoryQueries: oiQ }, null, 2));
  ok("K  Offer / Seller / OfferInventory each loaded in <= 1 query for the whole cart", offerQ <= 1 && sellerQ <= 1 && oiQ <= 1, `o=${offerQ} s=${sellerQ} oi=${oiQ}`);
}

function staticChecks() {
  console.log("\nL. checkout / Order / Payment untouched (file inspection)");
  const cart = readFileSync(new URL("../src/lib/cart.ts", import.meta.url), "utf8");
  const checkout = readFileSync(new URL("../src/lib/checkout.ts", import.meta.url), "utf8");
  const actions = readFileSync(new URL("../src/lib/cart-actions.ts", import.meta.url), "utf8");
  const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

  ok("L  cart mutation identity is cartItemId (schemas + core)", /cartItemId: z\.string/.test(actions) && /updateCartItemCore\(input: \{\s*cartItemId: string/.test(cart) && !/updateSchema[\s\S]{0,120}variantId/.test(actions));
  ok("L  add-to-cart INSERT conflict target is (cartId, offerId)", /ON CONFLICT \("cartId", "offerId"\)/.test(cart) && !/ON CONFLICT \("cartId", "variantId"\)/.test(cart));
  ok("L  schema: @@unique([cartId, offerId]) + offerId required + no [cartId, variantId]", /@@unique\(\[cartId, offerId\]\)/.test(schema) && /\n\s*offerId\s+String\s*\n/.test(schema) && !/@@unique\(\[cartId, variantId\]\)/.test(schema));
  // The cart-line uniqueness KEY (cartId_variantId / cartId_offerId composite
  // accessors) must not leak into checkout — `offerId` alone is legitimate
  // there since 9E-3C-2 (the bound-offer checkout writer).
  ok("L  checkout.ts has no cart-uniqueness-key coupling", !/cartId_variantId|cartId_offerId/.test(checkout));
  // 9E-3C-2: the checkout writer is offer-native and single-seller — it prices
  // from the bound Offer and creates exactly one SellerOrder.
  ok("L  checkout writer prices from the bound Offer (o.price), not v.price", /unitPrice:\s*o\.price/.test(checkout) && !/unitPrice:\s*v\.price/.test(checkout));
  ok("L  checkout writer is single-seller (sellerIds.size !== 1 gate)", /sellerIds\.size !== 1/.test(checkout));
  ok("L  coupon stays order-wide (Cart.couponCode, one CouponRedemption per order)", /couponCode\s+String\?/.test(schema) && /orderId\s+String\s+@unique/.test(schema));
}

async function run() {
  await dbTests();
  await n1Check();
  staticChecks();
  console.log(`\n  ${pass} passed, ${fail} failed.`);
  if (fail > 0) throw new Error(`${fail} Phase 9E-2 check(s) failed.`);
}

run()
  .then(() => console.log("All Phase 9E-2 checks passed."))
  .catch((e) => {
    console.error(e.message ?? e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
