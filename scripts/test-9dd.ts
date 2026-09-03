/**
 * Phase 9D-D — assertion runner (stock / availability via the Offer layer).
 *
 *   A. Pure resolveVariantAvailability — fixtures, no DB (§41)
 *   B. 1P inventory write-through — real rows, rolled back (§35)
 *   C. Transaction atomicity / rollback (§36)
 *   D. THIRD_PARTY isolation fixture (§37)
 *   E. N+1 check for the card/PLP stock path
 *
 * Run:  npm run test:9dd
 *       (node --env-file=.env --conditions=react-server --import tsx …)
 */
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { resolveVariantAvailability } from "../src/lib/marketplace/buy-box-rule";
import { adjustStock, setReorderPoint } from "../src/lib/inventory";
import {
  ensureFirstPartyOffer,
  syncFirstPartyOfferStock,
  syncFirstPartyOfferReorderPoint,
} from "../src/lib/admin/offer-sync";
import type { StockOfferCandidate } from "../src/lib/marketplace/types";

let pass = 0,
  fail = 0;
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
function so(over: Partial<StockOfferCandidate>): StockOfferCandidate {
  return {
    offerId: "o" + Math.random().toString(36).slice(2, 8),
    sellerId: "",
    sellerType: "FIRST_PARTY",
    sellerStatus: "APPROVED",
    offerStatus: "ACTIVE",
    available: 10,
    reorderPoint: 3,
    price: 1000,
    createdAt: D("2026-01-01T00:00:00Z"),
    ...over,
  };
}

// ---------------------------------------------------------------------------
function pureTests() {
  console.log("\nA. Pure resolveVariantAvailability");

  ok("A  single in-stock Axiaro offer → its available + reorderPoint",
    (() => { const r = resolveVariantAvailability([so({ available: 8, reorderPoint: 2 })]); return r.available === 8 && r.reorderPoint === 2; })());

  ok("B  no offers → { 0, 0 }",
    (() => { const r = resolveVariantAvailability([]); return r.available === 0 && r.reorderPoint === 0; })());

  ok("C  every offer out of stock → { 0, 0 } (never falls back to Variant.stock)",
    (() => { const r = resolveVariantAvailability([so({ available: 0 }), so({ available: 0, price: 800 })]); return r.available === 0 && r.reorderPoint === 0; })());

  ok("D  cheapest offer out of stock → next in-stock offer's availability",
    (() => { const r = resolveVariantAvailability([so({ price: 500, available: 0, reorderPoint: 9 }), so({ price: 900, available: 4, reorderPoint: 1 })]); return r.available === 4 && r.reorderPoint === 1; })());

  ok("E  cheapest seller SUSPENDED → next eligible offer's availability",
    (() => { const r = resolveVariantAvailability([so({ price: 400, sellerStatus: "SUSPENDED", available: 50 }), so({ price: 900, available: 6 })]); return r.available === 6; })());

  ok("F  DRAFT / INACTIVE offer ignored",
    (() => { const r = resolveVariantAvailability([so({ offerStatus: "DRAFT", available: 99 }), so({ price: 900, available: 5 })]); return r.available === 5; })());

  ok("G  two in-stock offers — cheaper wins even with LESS stock",
    (() => { const r = resolveVariantAvailability([so({ price: 700, available: 2, reorderPoint: 0 }), so({ price: 900, available: 40, reorderPoint: 10 })]); return r.available === 2 && r.reorderPoint === 0; })());

  ok("H  FIRST_PARTY wins a price tie → its availability + reorderPoint",
    (() => {
      const r = resolveVariantAvailability([
        so({ price: 900, sellerType: "THIRD_PARTY", createdAt: D("2025-01-01"), available: 30, reorderPoint: 7 }),
        so({ price: 900, sellerType: "FIRST_PARTY", createdAt: D("2026-06-01"), available: 12, reorderPoint: 4 }),
      ]);
      return r.available === 12 && r.reorderPoint === 4;
    })());

  ok("I  reorderPoint comes from the WINNING offer, not the min/max across offers",
    (() => { const r = resolveVariantAvailability([so({ price: 600, available: 5, reorderPoint: 1 }), so({ price: 999, available: 5, reorderPoint: 100 })]); return r.reorderPoint === 1; })());

  ok("J  input order irrelevant",
    (() => {
      const a = so({ price: 900, available: 9 }), b = so({ price: 700, available: 3 }), c = so({ price: 800, available: 4 });
      const r1 = resolveVariantAvailability([a, b, c]);
      const r2 = resolveVariantAvailability([c, a, b]);
      return r1.available === r2.available && r1.available === 3;
    })());

  ok("K  3P cheaper AND in stock → 3P availability (marketplace-correct)",
    (() => { const r = resolveVariantAvailability([so({ price: 1000, sellerType: "FIRST_PARTY", available: 20 }), so({ price: 850, sellerType: "THIRD_PARTY", available: 7 })]); return r.available === 7; })());

  ok("L  candidate available already nets reserved (available = 0 → excluded)",
    (() => { const r = resolveVariantAvailability([so({ price: 500, available: 0 }), so({ price: 900, available: 1 })]); return r.available === 1; })());

  ok("M  winner reorderPoint 0 → returned as 0 (not defaulted)",
    (() => { const r = resolveVariantAvailability([so({ available: 5, reorderPoint: 0 })]); return r.reorderPoint === 0; })());

  ok("N  single offer, available 1, reorderPoint 3 → LOW-stock band (available <= rp)",
    (() => { const r = resolveVariantAvailability([so({ available: 1, reorderPoint: 3 })]); return r.available === 1 && r.reorderPoint === 3; })());

  ok("O  all THIRD_PARTY, all suspended → { 0, 0 }",
    (() => { const r = resolveVariantAvailability([so({ sellerType: "THIRD_PARTY", sellerStatus: "SUSPENDED", available: 5 })]); return r.available === 0; })());

  ok("P  large catalogue-style list resolves the global cheapest in-stock offer",
    (() => {
      const r = resolveVariantAvailability([
        so({ price: 1200, available: 3 }), so({ price: 800, available: 0 }),
        so({ price: 950, available: 2 }), so({ price: 990, available: 8 }),
      ]);
      return r.available === 2; // 800 is oos, 950 is next cheapest in stock
    })());

  ok("Q  ARCHIVED offer + one ACTIVE in-stock → ACTIVE one's availability",
    (() => { const r = resolveVariantAvailability([so({ offerStatus: "ARCHIVED", available: 40 }), so({ available: 6 })]); return r.available === 6; })());
}

// ---------------------------------------------------------------------------
class Rollback extends Error {}

async function writeThroughTests(prisma: PrismaClient) {
  console.log("\nB. 1P inventory write-through (rolled back)");
  const suffix = "9dd-" + Date.now();
  const axiaro = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
  ok("pre  Axiaro FIRST_PARTY seller exists", !!axiaro);
  if (!axiaro) return;
  const product = await prisma.product.findFirst({ where: { status: "ACTIVE" }, select: { id: true, costPrice: true } });
  if (!product) { ok("(skipped — no product)", true); return; }

  const actor = await prisma.user.findFirst({ select: { id: true } });

  try {
    await prisma.$transaction(async (tx) => {
      // Build a variant + Inventory (qty 10, reserved 2) + 1P Offer/OfferInventory.
      const v = await tx.variant.create({ data: { productId: product.id, sku: `X-${suffix}`, price: 1000, status: "ACTIVE", stock: 0 } });
      await tx.inventory.create({ data: { variantId: v.id, sku: `X-${suffix}`, quantity: 10, reserved: 2, reorderPoint: 3 } });
      await ensureFirstPartyOffer({ id: v.id, sku: `X-${suffix}`, price: 1000, compareAtPrice: null }, { productStatus: "ACTIVE", costPrice: product.costPrice }, tx);
      // ensureFirstPartyOffer copies the Inventory row → OfferInventory qty 10 / reserved 2.
      const oi0 = await tx.offerInventory.findFirst({ where: { offer: { variantId: v.id, sellerId: axiaro.id } } });
      ok("setup  OfferInventory seeded from Inventory (qty 10, reserved 2)", oi0?.quantity === 10 && oi0?.reserved === 2);

      // Historical 9D-D pattern (dual-write) — post-9E-3D-6 the two primitives
      // are used INDEPENDENTLY (adjustStock = legacy cancel/return only;
      // syncFirstPartyOfferStock = admin). Here we still exercise both to prove
      // they move by the same delta.
      const bundle = async (delta: number, reason: string) => {
        const r = await adjustStock({ variantId: v.id, delta, reason, actorUserId: actor?.id ?? null }, tx);
        if (r.ok) {
          const or = await syncFirstPartyOfferStock(v.id, delta, reason, null, actor?.id ?? null, tx);
          if (!or.ok) throw new Error(or.error);
        }
        return r;
      };

      // A. decrease 10 → 7
      await bundle(-3, "DAMAGE");
      let inv = await tx.inventory.findUnique({ where: { variantId: v.id } });
      let oi = await tx.offerInventory.findFirst({ where: { offer: { variantId: v.id, sellerId: axiaro.id } } });
      ok("A  decrease −3 → Inventory 7 AND OfferInventory 7", inv?.quantity === 7 && oi?.quantity === 7);

      // B. restock 7 → 12
      await bundle(5, "RESTOCK");
      inv = await tx.inventory.findUnique({ where: { variantId: v.id } });
      oi = await tx.offerInventory.findFirst({ where: { offer: { variantId: v.id, sellerId: axiaro.id } } });
      ok("B  restock +5 → Inventory 12 AND OfferInventory 12", inv?.quantity === 12 && oi?.quantity === 12);

      // C. sequential adjustments stay in lock-step
      await bundle(-1, "LOSS");
      await bundle(-1, "LOSS");
      inv = await tx.inventory.findUnique({ where: { variantId: v.id } });
      oi = await tx.offerInventory.findFirst({ where: { offer: { variantId: v.id, sellerId: axiaro.id } } });
      ok("C  two more −1 → both at 10", inv?.quantity === 10 && oi?.quantity === 10);

      // D. reorder point sync
      await setReorderPoint(v.id, 6, tx);
      await syncFirstPartyOfferReorderPoint(v.id, 6, tx);
      inv = await tx.inventory.findUnique({ where: { variantId: v.id } });
      oi = await tx.offerInventory.findFirst({ where: { offer: { variantId: v.id, sellerId: axiaro.id } } });
      ok("D  reorder point → Inventory 6 AND OfferInventory 6", inv?.reorderPoint === 6 && oi?.reorderPoint === 6);

      // E. reserved never touched by an on-hand adjustment
      ok("E  OfferInventory.reserved unchanged (still 2)", oi?.reserved === 2 && inv?.reserved === 2);

      // F. every quantity move recorded an OfferAdjustment (append-only history)
      const adjustments = await tx.offerAdjustment.findMany({
        where: { offerInventory: { offer: { variantId: v.id, sellerId: axiaro.id } } },
        orderBy: { createdAt: "asc" },
      });
      // 1 opening (MIGRATION_OPENING) + 4 quantity moves (−3, +5, −1, −1)
      const qtyMoves = adjustments.filter((a) => a.reason !== "MIGRATION_OPENING");
      ok("F  one OfferAdjustment per quantity move (4)", qtyMoves.length === 4,
        qtyMoves.map((a) => `${a.reason}:${a.delta}`).join(","));
      ok("F  deltas match (−3,+5,−1,−1) and newQuantity is consistent",
        qtyMoves.map((a) => a.delta).join(",") === "-3,5,-1,-1" &&
        qtyMoves.every((a) => a.newQuantity === a.previousQuantity + a.delta));

      // G. actor id preserved onto the OfferAdjustment
      ok("G  actorUserId preserved on OfferAdjustment", actor ? qtyMoves.every((a) => a.actorUserId === actor.id) : true);

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  const leaked = await prisma.variant.count({ where: { sku: { contains: suffix } } });
  ok("B  test rows rolled back", leaked === 0, `leaked ${leaked}`);
}

// ---------------------------------------------------------------------------
async function atomicityTests(prisma: PrismaClient) {
  console.log("\nC. Transaction atomicity / rollback (§36)");
  const suffix = "9dd-atom-" + Date.now();
  const axiaro = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
  const product = await prisma.product.findFirst({ where: { status: "ACTIVE" }, select: { id: true, costPrice: true } });
  if (!axiaro || !product) { ok("(skipped — no seller/product)", true); return; }

  let threw = false;
  try {
    await prisma.$transaction(async (tx) => {
      const v = await tx.variant.create({ data: { productId: product.id, sku: `Z-${suffix}`, price: 1000, status: "ACTIVE", stock: 0 } });
      await tx.inventory.create({ data: { variantId: v.id, sku: `Z-${suffix}`, quantity: 10, reserved: 0, reorderPoint: 3 } });
      await ensureFirstPartyOffer({ id: v.id, sku: `Z-${suffix}`, price: 1000, compareAtPrice: null }, { productStatus: "ACTIVE", costPrice: product.costPrice }, tx);

      // Force OfferInventory to drift BELOW Inventory so the next sync's invariant
      // guard fires: OfferInventory 1, Inventory 10, then bundle a −5.
      const oi = await tx.offerInventory.findFirst({ where: { offer: { variantId: v.id, sellerId: axiaro.id } } });
      await tx.offerInventory.update({ where: { id: oi!.id }, data: { quantity: 1 } });

      // Post-9E-3D-6: syncFirstPartyOfferStock RETURNS { ok:false } on an
      // invariant violation; the caller (the admin action) throws to roll back.
      const or = await syncFirstPartyOfferStock(v.id, -5, "DAMAGE", null, null, tx); // 1 + (−5) = −4 → { ok:false }
      if (!or.ok) throw new Error(or.error);
    });
  } catch {
    threw = true;
  }
  // Nothing should have persisted — the variant itself was rolled back.
  const v = await prisma.variant.findFirst({ where: { sku: `Z-${suffix}` }, select: { id: true } });
  ok("C  syncFirstPartyOfferStock returns { ok:false } on an invariant violation → caller throws", threw);
  ok("C  whole transaction rolled back (no variant, no OfferInventory move)", v === null,
    `variant ${v ? "leaked" : "gone"}`);
}

// ---------------------------------------------------------------------------
async function thirdPartyIsolationTest(prisma: PrismaClient) {
  console.log("\nD. THIRD_PARTY isolation fixture (§37)");
  const suffix = "9dd-3p-" + Date.now();
  const axiaro = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
  const product = await prisma.product.findFirst({ where: { status: "ACTIVE" }, select: { id: true, costPrice: true } });
  if (!axiaro || !product) { ok("(skipped — no seller/product)", true); return; }

  try {
    await prisma.$transaction(async (tx) => {
      const v = await tx.variant.create({ data: { productId: product.id, sku: `V-${suffix}`, price: 1000, status: "ACTIVE", stock: 0 } });
      await tx.inventory.create({ data: { variantId: v.id, sku: `V-${suffix}`, quantity: 10, reserved: 0, reorderPoint: 3 } });
      await ensureFirstPartyOffer({ id: v.id, sku: `V-${suffix}`, price: 1000, compareAtPrice: null }, { productStatus: "ACTIVE", costPrice: product.costPrice }, tx);

      // Seller B — THIRD_PARTY offer on the SAME variant, OfferInventory 20.
      const sellerB = await tx.seller.create({ data: { type: "THIRD_PARTY", status: "APPROVED", displayName: "Seller B", slug: `seller-b-${suffix}`, supportEmail: "b@example.test" } });
      const offerB = await tx.offer.create({ data: { sellerId: sellerB.id, variantId: v.id, price: 950, condition: "NEW", status: "ACTIVE", sellerSku: `B-${suffix}` } });
      await tx.offerInventory.create({ data: { offerId: offerB.id, sellerSku: `B-${suffix}`, quantity: 20, reserved: 0, reorderPoint: 5 } });

      const axiaroOi0 = await tx.offerInventory.findFirst({ where: { offer: { variantId: v.id, sellerId: axiaro.id } } });
      ok("setup  Axiaro OfferInventory 10, Seller B OfferInventory 20", axiaroOi0?.quantity === 10);

      // Axiaro admin decreases stock by 3.
      const r = await adjustStock({ variantId: v.id, delta: -3, reason: "DAMAGE" }, tx);
      if (r.ok) {
        const or = await syncFirstPartyOfferStock(v.id, -3, "DAMAGE", null, null, tx);
        if (!or.ok) throw new Error(or.error);
      }

      const axiaroOi = await tx.offerInventory.findFirst({ where: { offer: { variantId: v.id, sellerId: axiaro.id } } });
      const bOi = await tx.offerInventory.findFirst({ where: { offerId: offerB.id } });
      ok("§37  Axiaro OfferInventory 10 → 7", axiaroOi?.quantity === 7);
      ok("§37  Seller B OfferInventory 20 → 20 (untouched)", bOi?.quantity === 20);
      const bAdj = await tx.offerAdjustment.count({ where: { offerInventory: { offerId: offerB.id } } });
      ok("§37  no OfferAdjustment written against Seller B", bAdj === 0);

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  const leaked = await prisma.seller.count({ where: { slug: { contains: suffix } } });
  ok("D  fixture rolled back", leaked === 0, `leaked ${leaked}`);
}

// ---------------------------------------------------------------------------
async function n1Check(prisma: PrismaClient) {
  console.log("\nE. N+1 check — card/PLP stock path (nested offers.inventory select)");
  const queries: string[] = [];
  (prisma.$on as (e: "query", cb: (x: { query: string }) => void) => void)("query", (e) => queries.push(e.query));

  queries.length = 0;
  const rows = await prisma.product.findMany({
    where: { status: "ACTIVE" },
    select: {
      id: true,
      variants: {
        where: { status: "ACTIVE" },
        select: {
          id: true,
          offers: {
            select: {
              id: true, status: true, price: true, compareAtPrice: true, createdAt: true,
              seller: { select: { type: true, status: true } },
              inventory: { select: { quantity: true, reserved: true, reorderPoint: true } },
            },
          },
        },
      },
    },
  });
  const nProducts = rows.length;
  const nOffers = rows.reduce((n, p) => n + p.variants.reduce((m, v) => m + v.offers.length, 0), 0);
  const oiQ = queries.filter((q) => /"OfferInventory"/.test(q)).length;
  const offerQ = queries.filter((q) => /FROM\s+"Offer"/i.test(q)).length;
  console.log(JSON.stringify({ products: nProducts, offers: nOffers, totalQueries: queries.length, offerQueries: offerQ, offerInventoryQueries: oiQ }, null, 2));
  ok("E  OfferInventory loaded in <= 1 query for the whole listing", oiQ <= 1, `oi=${oiQ}`);
  ok("E  Offer loaded in <= 1 query for the whole listing", offerQ <= 1, `offer=${offerQ}`);
}

// ---------------------------------------------------------------------------
export async function run(prisma: PrismaClient) {
  pureTests();
  await writeThroughTests(prisma);
  await atomicityTests(prisma);
  await thirdPartyIsolationTest(prisma);
  await n1Check(prisma);
  console.log(`\n  ${pass} passed, ${fail} failed.`);
  if (fail > 0) throw new Error(`${fail} Phase 9D-D check(s) failed.`);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  const prisma = new PrismaClient({
    datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL,
    log: [{ level: "query", emit: "event" }],
  });
  run(prisma)
    .then(() => console.log("All Phase 9D-D checks passed."))
    .catch((e) => {
      console.error(e.message ?? e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
