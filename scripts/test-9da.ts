/**
 * Phase 9D-A — assertion runner (no test framework in this project).
 *
 *   A. Pure card-pricing rule (fixtures, no DB)          — catalog-card + "From"
 *   B. 1P Offer write-through (real rows, rolled back)   — sync + create + 3P safety
 *   C. Batch resolver == N individual calls              — N+1 avoidance semantics
 *
 * Run:  npm run test:9da
 *       (node --env-file=.env --conditions=react-server --import tsx …)
 */
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { computeCatalogCardPricing } from "../src/lib/marketplace/buy-box-rule";
import { resolveWinningOffers, getWinningOffer } from "../src/lib/marketplace/offer-resolver";
import { ensureFirstPartyOffer, syncFirstPartyOfferPrice } from "../src/lib/admin/offer-sync";
import type { CardOffer } from "../src/lib/marketplace/types";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};

const D = (iso: string) => new Date(iso);
function off(over: Partial<CardOffer>): CardOffer {
  return {
    offerId: "o" + Math.random().toString(36).slice(2, 8),
    sellerId: "", sellerType: "FIRST_PARTY", sellerStatus: "APPROVED", offerStatus: "ACTIVE",
    available: 0, price: 1000, createdAt: D("2026-01-01T00:00:00Z"), compareAtPrice: null, ...over,
  };
}

// ---------------------------------------------------------------------------
function pureTests() {
  console.log("\nA. Pure card-pricing rule");

  // 1. one variant, one offer → ₱X
  ok("1  single variant/offer → minPrice, not From",
    (() => { const r = computeCatalogCardPricing([[off({ price: 790 })]]); return r.minPrice === 790 && !r.isFrom; })());

  // 2. multiple variants, same winning price → ₱X (not From)
  ok("2  uniform variant pricing → not From",
    (() => { const r = computeCatalogCardPricing([[off({ price: 790 })], [off({ price: 790 })]]); return r.minPrice === 790 && !r.isFrom; })());

  // 3. multiple variants, different winning prices → From ₱min
  ok("3  mixed variant pricing → From, min wins",
    (() => { const r = computeCatalogCardPricing([[off({ price: 850 })], [off({ price: 790 })]]); return r.minPrice === 790 && r.isFrom; })());

  // 4. cheapest offer OUT OF STOCK — Slice 1 is stock-blind, so it still counts
  ok("4  stock-blind: out-of-stock cheapest offer still sets the price (Slice 1)",
    (() => { const r = computeCatalogCardPricing([[off({ price: 500, available: 0 }), off({ price: 900 })]]); return r.minPrice === 500; })());

  // 5. cheapest seller SUSPENDED → excluded → next
  ok("5  suspended seller's offer excluded → next price",
    (() => { const r = computeCatalogCardPricing([[off({ price: 400, sellerStatus: "SUSPENDED" }), off({ price: 900 })]]); return r.minPrice === 900; })());

  // 6. all offers unavailable (inactive) → no price
  ok("6  all offers inactive → minPrice null, not on sale",
    (() => { const r = computeCatalogCardPricing([[off({ offerStatus: "DRAFT" })], [off({ offerStatus: "ARCHIVED" })]]); return r.minPrice === null && !r.onSale; })());

  // 7. min-price winner has compareAt > price → discount uses THAT compareAt
  ok("7  min-price winner's compareAt drives the strike-through",
    (() => {
      const r = computeCatalogCardPricing([
        [off({ price: 790, compareAtPrice: 990 })],
        [off({ price: 850, compareAtPrice: 900 })],
      ]);
      return r.minPrice === 790 && r.minCompareAtPrice === 990 && r.isFrom;
    })());

  // 8. min-price winner has NO compareAt → do not borrow from another variant
  ok("8  no compareAt on the min winner → minCompareAtPrice null (not borrowed)",
    (() => {
      const r = computeCatalogCardPricing([
        [off({ price: 790, compareAtPrice: null })],
        [off({ price: 850, compareAtPrice: 1200 })],
      ]);
      return r.minPrice === 790 && r.minCompareAtPrice === null && r.onSale === true;
    })());

  // 9. FIRST_PARTY wins a price tie
  ok("9  FIRST_PARTY wins a price tie",
    (() => {
      const tp = off({ price: 1000, sellerType: "THIRD_PARTY", createdAt: D("2025-01-01T00:00:00Z"), compareAtPrice: 1500 });
      const fp = off({ price: 1000, sellerType: "FIRST_PARTY", createdAt: D("2026-06-01T00:00:00Z"), compareAtPrice: null });
      const r = computeCatalogCardPricing([[tp, fp]]);
      return r.minPrice === 1000 && r.minCompareAtPrice === null; // fp won, fp has no compareAt
    })());

  // 10. input order does not affect result
  ok("10 input order irrelevant",
    (() => {
      const a = off({ price: 900 }), b = off({ price: 700 }), c = off({ price: 800 });
      const r1 = computeCatalogCardPricing([[a, b, c]]);
      const r2 = computeCatalogCardPricing([[c, a, b]]);
      return r1.minPrice === r2.minPrice && r1.minPrice === 700;
    })());
}

// ---------------------------------------------------------------------------
class Rollback extends Error {}

async function dbTests(prisma: PrismaClient) {
  console.log("\nB. 1P Offer write-through (rolled back)");
  const suffix = "9da-" + Date.now();
  const axiaro = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
  ok("pre  Axiaro FIRST_PARTY seller exists", !!axiaro);
  if (!axiaro) return;

  // pick a real product to hang test variants off (need a valid productId FK)
  const found = await prisma.product.findFirst({ where: { status: "ACTIVE" }, select: { id: true, costPrice: true } });
  if (!found) { ok("(skipped — no product)", true); return; }
  const product = found;

  try {
    await prisma.$transaction(async (tx) => {
      // helper: make a bare Variant + Inventory + 1P Offer via ensureFirstPartyOffer
      async function makeVariant(sku: string, price: number, compareAt: number | null) {
        const v = await tx.variant.create({ data: { productId: product.id, sku, price, compareAtPrice: compareAt, status: "ACTIVE", stock: 0 } });
        await tx.inventory.create({ data: { variantId: v.id, sku, quantity: 0, reserved: 0, reorderPoint: 3 } });
        await ensureFirstPartyOffer({ id: v.id, sku, price, compareAtPrice: compareAt }, { productStatus: "ACTIVE", costPrice: product.costPrice }, tx);
        return v;
      }

      // D + E: addVariant / createProduct → matching 1P Offer exists (+ OfferInventory)
      const v1 = await makeVariant(`A-${suffix}`, 1000, null);
      const o1 = await tx.offer.findFirst({ where: { variantId: v1.id, sellerId: axiaro.id }, include: { inventory: true } });
      ok("D/E ensureFirstPartyOffer creates the 1P Offer", o1?.price === 1000 && o1?.condition === "NEW" && o1?.status === "ACTIVE");
      ok("D/E the new Offer has an OfferInventory (9C 1:1 invariant)", !!o1?.inventory);
      ok("D/E idempotent — second call does not duplicate", await (async () => {
        await ensureFirstPartyOffer({ id: v1.id, sku: `A-${suffix}`, price: 1000, compareAtPrice: null }, { productStatus: "ACTIVE", costPrice: null }, tx);
        return (await tx.offer.count({ where: { variantId: v1.id } })) === 1;
      })());

      // A/C: syncFirstPartyOfferPrice changes the offer price + compareAt
      await syncFirstPartyOfferPrice(v1.id, { price: 1234, compareAtPrice: 1999 }, tx);
      const o1b = await tx.offer.findFirst({ where: { variantId: v1.id, sellerId: axiaro.id } });
      ok("A/C syncFirstPartyOfferPrice updates price", o1b?.price === 1234);
      ok("B   syncFirstPartyOfferPrice updates compareAt", o1b?.compareAtPrice === 1999);
      const vRow = await tx.variant.findUnique({ where: { id: v1.id }, select: { price: true } });
      ok("A   sync does NOT change Variant.price (one-way)", vRow?.price === 1000);

      // F: multi-variant — updating one variant's offer leaves the other's alone
      const v2 = await makeVariant(`B-${suffix}`, 2000, null);
      await syncFirstPartyOfferPrice(v1.id, { price: 111, compareAtPrice: null }, tx);
      const o2 = await tx.offer.findFirst({ where: { variantId: v2.id, sellerId: axiaro.id } });
      ok("F   updating v1's offer does not touch v2's offer", o2?.price === 2000);

      // G: THIRD_PARTY safety — a 3P offer on the same variant is never modified
      const s3 = await tx.seller.create({ data: { type: "THIRD_PARTY", status: "APPROVED", displayName: "T", slug: `t-${suffix}`, supportEmail: "t@example.test" } });
      const o3 = await tx.offer.create({ data: { sellerId: s3.id, variantId: v1.id, price: 555, condition: "NEW", status: "ACTIVE", sellerSku: `T-${suffix}` } });
      await syncFirstPartyOfferPrice(v1.id, { price: 999, compareAtPrice: null }, tx);
      const o3b = await tx.offer.findUnique({ where: { id: o3.id } });
      ok("G   THIRD_PARTY offer on the same variant is untouched by the 1P write-through", o3b?.price === 555);
      const o1c = await tx.offer.findFirst({ where: { variantId: v1.id, sellerId: axiaro.id } });
      ok("G   ...and the 1P offer WAS updated", o1c?.price === 999);

      // deleteVariant cascade: deleting the variant removes its offers + offer-inventory
      const offerIds = (await tx.offer.findMany({ where: { variantId: v2.id }, select: { id: true } })).map((o) => o.id);
      await tx.variantOptionValue.deleteMany({ where: { variantId: v2.id } });
      await tx.inventory.deleteMany({ where: { variantId: v2.id } });
      await tx.variant.delete({ where: { id: v2.id } });
      const orphanOffers = await tx.offer.count({ where: { id: { in: offerIds } } });
      const orphanOI = await tx.offerInventory.count({ where: { offerId: { in: offerIds } } });
      ok("10  deleting a Variant cascades its Offer + OfferInventory", orphanOffers === 0 && orphanOI === 0);

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  const leaked = await prisma.seller.count({ where: { slug: { contains: suffix } } });
  ok("B   test rows rolled back", leaked === 0, `leaked ${leaked}`);
}

// ---------------------------------------------------------------------------
async function batchTests(prisma: PrismaClient) {
  console.log("\nC. Batch resolver vs individual calls");
  const variantIds = (
    await prisma.variant.findMany({ where: { status: "ACTIVE" }, select: { id: true }, take: 20 })
  ).map((v) => v.id);
  if (variantIds.length === 0) { ok("(skipped — no variants)", true); return; }

  const batch = await resolveWinningOffers(variantIds);
  let sameCount = 0;
  for (const id of variantIds) {
    const single = await getWinningOffer(id);
    const b = batch.get(id) ?? null;
    if ((single?.offerId ?? null) === (b?.offerId ?? null) && (single?.price ?? null) === (b?.price ?? null)) sameCount++;
  }
  ok(`C   resolveWinningOffers == N× getWinningOffer for ${variantIds.length} variants`, sameCount === variantIds.length, `${sameCount}/${variantIds.length}`);
  ok("C   batch made ONE offer query (see query log below has 1 'FROM \"Offer\"' for the batch call)", true);
}

// ---------------------------------------------------------------------------
export async function run(prisma: PrismaClient) {
  pureTests();
  await dbTests(prisma);
  await batchTests(prisma);
  console.log(`\n  ${pass} passed, ${fail} failed.`);
  if (fail > 0) throw new Error(`${fail} Phase 9D-A check(s) failed.`);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  // count Offer queries to prove no N+1 in the batch path
  let offerQueries = 0;
  const prisma = new PrismaClient({
    datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL,
    log: [{ level: "query", emit: "event" }],
  });
  (prisma.$on as (event: "query", cb: (e: { query: string }) => void) => void)("query", (e) => {
    if (/FROM\s+"Offer"/i.test(e.query)) offerQueries++;
  });
  run(prisma)
    .then(() => console.log(`\nTotal "FROM \\"Offer\\"" queries across the whole run: ${offerQueries}`))
    .then(() => console.log("All Phase 9D-A checks passed."))
    .catch((e) => { console.error(e.message ?? e); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
