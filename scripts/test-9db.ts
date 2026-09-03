/**
 * Phase 9D-B — assertion runner (PDP price via the Offer layer).
 *
 *   A. Pure resolution — the 15 PDP price cases (fixtures, no DB)
 *   B. loadProductBySlug — real DTO shape + N+1 check
 *
 * Run:  npm run test:9db
 */
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { pickWinningOffer, computeCatalogCardPricing } from "../src/lib/marketplace/buy-box-rule";
import type { OfferCandidate, CardOffer } from "../src/lib/marketplace/types";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};

const D = (iso: string) => new Date(iso);
function cand(over: Partial<OfferCandidate>): OfferCandidate {
  return {
    offerId: "o" + Math.random().toString(36).slice(2, 8),
    sellerId: "", sellerType: "FIRST_PARTY", sellerStatus: "APPROVED", offerStatus: "ACTIVE",
    available: 10, price: 1000, createdAt: D("2026-01-01T00:00:00Z"), ...over,
  };
}
function card(over: Partial<CardOffer>): CardOffer {
  return { ...cand(over), compareAtPrice: over.compareAtPrice ?? null };
}
/** PDP per-variant resolution = full stock-aware buy-box rule. */
function pdpVariantPrice(offers: (OfferCandidate & { compareAtPrice?: number | null })[]) {
  const w = pickWinningOffer(offers);
  if (!w) return { price: null as number | null, compareAtPrice: null as number | null };
  const row = offers.find((o) => o.offerId === w.offerId)!;
  return { price: row.price, compareAtPrice: row.compareAtPrice ?? null };
}

function pureTests() {
  console.log("\nA. Pure PDP price resolution");

  // 1. selected variant + one Axiaro offer → offer price
  ok("1  selected variant, one Axiaro offer → offer price",
    pdpVariantPrice([card({ price: 790 })]).price === 790);

  // 2. selected variant + multiple eligible → buy-box price (lowest)
  ok("2  multiple eligible offers → lowest wins",
    pdpVariantPrice([card({ price: 900 }), card({ price: 750, sellerType: "THIRD_PARTY" })]).price === 750);

  // 3. 3P cheaper than Axiaro → 3P
  ok("3  3P cheaper than Axiaro → 3P price",
    pdpVariantPrice([card({ price: 1000, sellerType: "FIRST_PARTY" }), card({ price: 850, sellerType: "THIRD_PARTY" })]).price === 850);

  // 4. Axiaro ties 3P → Axiaro
  ok("4  Axiaro ties 3P on price → Axiaro wins",
    pdpVariantPrice([
      card({ price: 900, sellerType: "THIRD_PARTY", createdAt: D("2025-01-01") }),
      card({ price: 900, sellerType: "FIRST_PARTY", createdAt: D("2026-06-01") }),
    ]).price === 900 &&
    pdpVariantPrice([
      card({ price: 900, sellerType: "THIRD_PARTY", compareAtPrice: 1500 }),
      card({ price: 900, sellerType: "FIRST_PARTY", compareAtPrice: null }),
    ]).compareAtPrice === null); // fp won → its (null) compareAt

  // 5. winning offer out of stock → next eligible (STOCK-AWARE for PDP)
  ok("5  cheapest offer out of stock → next eligible price",
    pdpVariantPrice([card({ price: 500, available: 0 }), card({ price: 900, available: 3 })]).price === 900);

  // 6. winning seller suspended → next eligible
  ok("6  cheapest seller suspended → next eligible price",
    pdpVariantPrice([card({ price: 400, sellerStatus: "SUSPENDED" }), card({ price: 900 })]).price === 900);

  // 7. no eligible offer → null (no fallback)
  ok("7  no eligible offer → null (STATE B — no price fallback)",
    pdpVariantPrice([card({ offerStatus: "DRAFT" }), card({ available: 0 })]).price === null);

  // 8. no variant selected → product-level minimum winning price (stock-blind range)
  ok("8  pre-selection → min winning price across variants",
    computeCatalogCardPricing([[card({ price: 850 })], [card({ price: 790 })]]).minPrice === 790);

  // 9. uniform variant pricing → bare price, not From
  ok("9  uniform variant pricing → not From",
    (() => { const r = computeCatalogCardPricing([[card({ price: 790 })], [card({ price: 790 })]]); return r.minPrice === 790 && !r.isFrom; })());

  // 10. mixed variant pricing → From ₱min
  ok("10 mixed variant pricing → isFrom + min",
    (() => { const r = computeCatalogCardPricing([[card({ price: 990 })], [card({ price: 790 })]]); return r.minPrice === 790 && r.isFrom; })());

  // 11. min-price winner has compareAt → displayed
  ok("11 min-price winner's compareAt displayed",
    (() => {
      const r = computeCatalogCardPricing([[card({ price: 790, compareAtPrice: 990 })], [card({ price: 850, compareAtPrice: 900 })]]);
      return r.minPrice === 790 && r.minCompareAtPrice === 990;
    })());

  // 12. min-price winner has no compareAt → not borrowed
  ok("12 no compareAt on min winner → not borrowed",
    (() => {
      const r = computeCatalogCardPricing([[card({ price: 790, compareAtPrice: null })], [card({ price: 850, compareAtPrice: 1200 })]]);
      return r.minPrice === 790 && r.minCompareAtPrice === null;
    })());

  // selected-variant compareAt comes from the winner
  ok("11b selected variant compareAt = winner's compareAt",
    pdpVariantPrice([card({ price: 790, compareAtPrice: 990 })]).compareAtPrice === 990);
  ok("12b selected variant, winner has no compareAt → null",
    pdpVariantPrice([card({ price: 790, compareAtPrice: null })]).compareAtPrice === null);
}

async function dbTests(prisma: PrismaClient) {
  console.log("\nB. Real-data resolution (reproduces loadProductBySlug's per-variant + range logic)");

  for (const slug of ["clean-line-tee", "aro-3-seat-sofa", "carryall-canvas-tote"]) {
    const p = await prisma.product.findFirst({
      where: { slug, status: "ACTIVE" },
      select: {
        slug: true, price: true, compareAtPrice: true,
        variants: {
          where: { status: "ACTIVE" },
          select: {
            sku: true, price: true, compareAtPrice: true, stock: true,
            offers: {
              select: {
                id: true, status: true, price: true, compareAtPrice: true, createdAt: true,
                seller: { select: { type: true, status: true } },
                inventory: { select: { quantity: true, reserved: true } },
              },
            },
          },
        },
      },
    });
    if (!p) { ok(`(${slug} not found)`, false); continue; }

    const toCand = (o: (typeof p.variants)[number]["offers"][number]): OfferCandidate => ({
      offerId: o.id, sellerId: "",
      sellerType: o.seller.type === "FIRST_PARTY" ? "FIRST_PARTY" : "THIRD_PARTY",
      sellerStatus: o.seller.status as OfferCandidate["sellerStatus"],
      offerStatus: o.status as OfferCandidate["offerStatus"],
      available: Math.max(0, (o.inventory?.quantity ?? 0) - (o.inventory?.reserved ?? 0)),
      price: o.price, createdAt: o.createdAt,
    });

    const perVariant = p.variants.map((v) => pdpVariantPrice(v.offers.map((o) => ({ ...toCand(o), compareAtPrice: o.compareAtPrice }))));
    ok(`${slug}: every ACTIVE variant resolves an offer price (not null)`,
      perVariant.every((r) => typeof r.price === "number"));
    ok(`${slug}: variant offerPrice === Variant.price`,
      p.variants.every((v, i) => perVariant[i].price === v.price),
      p.variants.filter((v, i) => perVariant[i].price !== v.price).map((v) => v.sku).join(","));
    ok(`${slug}: variant offerCompareAt === Variant.compareAtPrice`,
      p.variants.every((v, i) => (perVariant[i].compareAtPrice ?? null) === (v.compareAtPrice ?? null)));

    const range = computeCatalogCardPricing(
      p.variants.map((v) => v.offers.map((o): CardOffer => ({ ...toCand(o), compareAtPrice: o.compareAtPrice }))),
    );
    ok(`${slug}: pre-selection range.minPrice === Product.price`, range.minPrice === p.price,
      `${range.minPrice} vs ${p.price}`);
    ok(`${slug}: range not "From" (uniform catalogue)`, range.isFrom === false);
    ok(`${slug}: Variant.stock untouched (ints >= 0)`,
      p.variants.every((v) => Number.isInteger(v.stock) && v.stock >= 0));
  }
}

async function n1Check(prisma: PrismaClient) {
  console.log("\nB. N+1 check (loadProductBySlug nested include)");
  const queries: string[] = [];
  (prisma.$on as (e: "query", cb: (x: { query: string }) => void) => void)("query", (e) => queries.push(e.query));

  // reproduce loadProductBySlug's include for aro-3-seat-sofa (multi-variant)
  queries.length = 0;
  const p = await prisma.product.findFirst({
    where: { slug: "aro-3-seat-sofa", status: "ACTIVE" },
    include: {
      category: { select: { slug: true, name: true } },
      images: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] },
      options: { orderBy: { sortOrder: "asc" }, include: { values: { orderBy: { sortOrder: "asc" } } } },
      variants: {
        include: {
          optionValues: { select: { optionValueId: true } },
          inventory: { select: { reorderPoint: true } },
          offers: {
            select: {
              id: true, status: true, price: true, compareAtPrice: true, createdAt: true,
              seller: { select: { type: true, status: true } },
              inventory: { select: { quantity: true, reserved: true } },
            },
          },
        },
      },
    },
  });
  const nVariants = p?.variants.length ?? 0;
  const nOffers = p?.variants.reduce((n, v) => n + v.offers.length, 0) ?? 0;
  const offerQ = queries.filter((q) => /FROM\s+"(public"\.")?"?Offer"/i.test(q) || /"Offer"/.test(q)).length;
  const sellerQ = queries.filter((q) => /"Seller"/.test(q)).length;
  const oiQ = queries.filter((q) => /"OfferInventory"/.test(q)).length;
  console.log(JSON.stringify({
    variants: nVariants, offers: nOffers,
    totalQueriesForThePdpLoad: queries.length,
    offerQueries: offerQ, sellerQueries: sellerQ, offerInventoryQueries: oiQ,
    n1: offerQ <= 1 && sellerQ <= 1 && oiQ <= 1 ? "NOT DETECTED" : "DETECTED",
  }, null, 2));
  ok("N+1: <= 1 query each for Offer / Seller / OfferInventory", offerQ <= 1 && sellerQ <= 1 && oiQ <= 1,
    `offer=${offerQ} seller=${sellerQ} oi=${oiQ}`);
}

export async function run(prisma: PrismaClient) {
  pureTests();
  await dbTests(prisma);
  await n1Check(prisma);
  console.log(`\n  ${pass} passed, ${fail} failed.`);
  if (fail > 0) throw new Error(`${fail} Phase 9D-B check(s) failed.`);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  const prisma = new PrismaClient({
    datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL,
    log: [{ level: "query", emit: "event" }],
  });
  run(prisma)
    .then(() => console.log("All Phase 9D-B checks passed."))
    .catch((e) => { console.error(e.message ?? e); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
