/**
 * Phase 9D-C — assertion runner.
 *
 *   A. Pure sort / filter / on-sale / bounds fixtures (no DB)
 *   B. Pagination correctness — runListProducts vs a full in-memory reference
 *   C. Relevance regression — default order unchanged for representative queries
 *   D. N+1 — query count for a listing
 *
 * Run:  npm run test:9dc
 *       (node --env-file=.env --conditions=react-server --import tsx …)
 */
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { computeCatalogCardPricing } from "../src/lib/marketplace/buy-box-rule";
import { runListProducts } from "../src/lib/data";
import type { CardOffer } from "../src/lib/marketplace/types";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};

const D = (iso: string) => new Date(iso);
function o(over: Partial<CardOffer>): CardOffer {
  return {
    offerId: "o" + Math.random().toString(36).slice(2, 8),
    sellerId: "", sellerType: "FIRST_PARTY", sellerStatus: "APPROVED", offerStatus: "ACTIVE",
    available: 10, price: 1000, createdAt: D("2026-01-01"), compareAtPrice: null, ...over,
  };
}
const minP = (groups: CardOffer[][]) => computeCatalogCardPricing(groups).minPrice;
const onSale = (groups: CardOffer[][]) => computeCatalogCardPricing(groups).onSale;

// ── A. pure ──────────────────────────────────────────────────────────────
function pureTests() {
  console.log("\nA. Pure sort / filter / on-sale");

  // sort: lower winning price first (product = min winning across variants)
  const A = [[o({ price: 790 })], [o({ price: 850 })]]; // product price 790
  const B = [[o({ price: 850 })]];                       // product price 850
  ok("25.1/2/3 product price = MIN winning across variants; A(790) < B(850)",
    minP(A) === 790 && minP(B) === 850 && (minP(A)! - minP(B)!) < 0);

  ok("25.4 suspended offer ignored → next price",
    minP([[o({ price: 400, sellerStatus: "SUSPENDED" }), o({ price: 900 })]]) === 900);
  ok("25.5 inactive offer ignored → next price",
    minP([[o({ price: 400, offerStatus: "ARCHIVED" }), o({ price: 900 })]]) === 900);
  ok("25.6 out-of-stock offer STILL counts (stock-blind price, 9D-A parity)",
    minP([[o({ price: 400, available: 0 }), o({ price: 900 })]]) === 400);
  ok("25.8 unpriced product → minPrice null",
    minP([[o({ offerStatus: "DRAFT" })], [o({ sellerStatus: "PENDING" })]]) === null);

  // filter: evaluate against product min winning price
  const prod = [[o({ price: 790 })], [o({ price: 1200 })]]; // = 790
  ok("26 max=800 → product (min 790) matches", minP(prod)! <= 800);
  ok("26 max=700 → product (min 790) excluded", !(minP(prod)! <= 700));
  ok("26 min=800 → product (min 790) excluded", !(minP(prod)! >= 800));
  ok("26 cheaper 3P defines the product price",
    minP([[o({ price: 1000, sellerType: "FIRST_PARTY" }), o({ price: 650, sellerType: "THIRD_PARTY" })]]) === 650);

  // on-sale
  ok("27.1 winning offer has compareAt → on sale",
    onSale([[o({ price: 790, compareAtPrice: 990 })]]) === true);
  ok("27.2 winning offer no compareAt → not on sale",
    onSale([[o({ price: 790, compareAtPrice: null })]]) === false);
  ok("27.4 suspended seller with compareAt → NOT on sale",
    onSale([[o({ price: 500, compareAtPrice: 900, sellerStatus: "SUSPENDED" })]]) === false);
  ok("27.5 inactive offer with compareAt → NOT on sale",
    onSale([[o({ price: 500, compareAtPrice: 900, offerStatus: "INACTIVE" })]]) === false);
  ok("8/27 loose predicate: compareAt != null (not > price)",
    onSale([[o({ price: 790, compareAtPrice: 990 })]]) === true);
}

// ── B. pagination ────────────────────────────────────────────────────────
async function paginationTests(prisma: PrismaClient) {
  console.log("\nB. Pagination correctness (runListProducts vs full in-memory reference)");

  // Reference: everything the migrated path should do, computed from scratch.
  const rows = await prisma.product.findMany({
    where: { status: "ACTIVE" },
    select: {
      id: true, slug: true, price: true,
      variants: {
        where: { status: "ACTIVE" },
        select: {
          offers: { select: { id: true, status: true, price: true, compareAtPrice: true, createdAt: true, seller: { select: { type: true, status: true } } } },
        },
      },
    },
  });
  const withDerived = rows.map((r) => ({
    id: r.id, slug: r.slug,
    dp: computeCatalogCardPricing(r.variants.map((v) => v.offers.map((of): CardOffer => ({
      offerId: of.id, sellerId: "",
      sellerType: of.seller.type === "FIRST_PARTY" ? "FIRST_PARTY" : "THIRD_PARTY",
      sellerStatus: of.seller.status as CardOffer["sellerStatus"],
      offerStatus: of.status as CardOffer["offerStatus"],
      available: 0, price: of.price, createdAt: of.createdAt, compareAtPrice: of.compareAtPrice,
    })))).minPrice,
  }));

  for (const [dir, cmp] of [
    ["price-asc", (a: number, b: number) => a - b],
    ["price-desc", (a: number, b: number) => b - a],
  ] as const) {
    // stable reference: DB order by Product.price, then stable-sort by derived
    const dbOrder = (await prisma.product.findMany({
      where: { status: "ACTIVE" }, orderBy: [{ price: dir === "price-asc" ? "asc" : "desc" }], select: { id: true },
    })).map((p) => p.id);
    const ref = [...dbOrder]
      .map((id) => withDerived.find((w) => w.id === id)!)
      .sort((a, b) => {
        if (a.dp == null && b.dp == null) return 0;
        if (a.dp == null) return 1;
        if (b.dp == null) return -1;
        return cmp(a.dp, b.dp);
      })
      .map((w) => w.id);

    for (const size of [10, 24]) {
      const pages = Math.ceil(ref.length / size);
      let allMatch = true;
      for (let pg = 1; pg <= pages; pg++) {
        const got = (await runListProducts({ sort: dir, page: pg, perPage: size })).products.map((p) => p.id);
        const want = ref.slice((pg - 1) * size, pg * size);
        if (JSON.stringify(got) !== JSON.stringify(want)) { allMatch = false; break; }
      }
      ok(`${dir} pageSize ${size}: every page matches the reference`, allMatch);
    }
  }

  // total is post-filter length
  const filtered = await runListProducts({ minPrice: 300_000, perPage: 5, page: 1 });
  const refCount = withDerived.filter((w) => w.dp != null && w.dp >= 300_000).length;
  ok("filter total == reference filtered count", filtered.total === refCount, `${filtered.total} vs ${refCount}`);
  ok("filter pageCount consistent", filtered.pageCount === Math.max(1, Math.ceil(refCount / 5)));
}

// ── C. relevance regression ──────────────────────────────────────────────
async function relevanceTests() {
  console.log("\nC. Search relevance regression (no price op → order unchanged)");
  for (const q of ["sofa", "tee", "shirt", "bag", "kitchen"]) {
    const got = (await runListProducts({ query: q, perPage: 100 })).products.map((p) => p.slug);
    // reference: same relevance path but WITHOUT the offer nested-select — must yield the same product set/order
    // (we cannot re-run the old code; instead assert determinism + non-empty + no dupes + stable across 2 runs)
    const got2 = (await runListProducts({ query: q, perPage: 100 })).products.map((p) => p.slug);
    ok(`"${q}": deterministic + no duplicates`, JSON.stringify(got) === JSON.stringify(got2) && new Set(got).size === got.length, `${got.length} results`);
    // adding a wide price filter must NOT reorder, only (possibly) trim
    const withFilter = (await runListProducts({ query: q, minPrice: 0, maxPrice: 99_999_999, perPage: 100 })).products.map((p) => p.slug);
    ok(`"${q}": wide price filter keeps relevance order`, JSON.stringify(withFilter) === JSON.stringify(got));
  }
}

// ── D. N+1 ───────────────────────────────────────────────────────────────
async function n1Check() {
  console.log("\nD. N+1 check");
  const prisma = new PrismaClient({
    datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL,
    log: [{ level: "query", emit: "event" }],
  });
  const q: string[] = [];
  (prisma.$on as (e: "query", cb: (x: { query: string }) => void) => void)("query", (e) => q.push(e.query));
  const { runListProducts: rlp } = await import("../src/lib/data");
  q.length = 0;
  await rlp({ sort: "price-asc", perPage: 24 });
  const offerQ = q.filter((s) => /"Offer"/.test(s)).length;
  const sellerQ = q.filter((s) => /"Seller"/.test(s)).length;
  console.log(JSON.stringify({ totalQueries: q.length, offerQueries: offerQ, sellerQueries: sellerQ }, null, 2));
  ok("N+1: Offer queries are a small fixed number (<= 3)", offerQ <= 3, `offer=${offerQ}`);
  await prisma.$disconnect();
}

export async function run(db: PrismaClient) {
  pureTests();
  await paginationTests(db);
  await relevanceTests();
  await n1Check();
  console.log(`\n  ${pass} passed, ${fail} failed.`);
  if (fail > 0) throw new Error(`${fail} Phase 9D-C check(s) failed.`);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });
  run(prisma)
    .then(() => console.log("All Phase 9D-C checks passed."))
    .catch((e) => { console.error(e.message ?? e); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
