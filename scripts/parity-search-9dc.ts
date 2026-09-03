/**
 * Phase 9D-C — search / listing price parity gate.
 *
 * Compares the Offer-derived price behaviour of `runListProducts` against a
 * reference that reproduces the pre-9D-C `Product.price` semantics. Exit 1 on
 * any difference — run before every deploy.
 *
 * Run:  npm run parity:9dc
 *       (node --env-file=.env --conditions=react-server --import tsx …)
 */
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { runListProducts } from "../src/lib/data";

export async function runParity(prisma: PrismaClient) {
  const issues: string[] = [];
  const note = (m: string) => issues.push(m);

  // ── reference data (old Product.price semantics) ────────────────────────
  const active = await prisma.product.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, slug: true, price: true, compareAtPrice: true, soldCount: true, ratingAvg: true },
  });
  const byId = new Map(active.map((p) => [p.id, p]));

  // 1. derived product price == Product.price  (via listing with a wide price sweep)
  const all = await runListProducts({ perPage: 1000 });
  let priceMismatch = 0;
  for (const c of all.products) {
    const ref = byId.get(c.id);
    if (!ref) { note(`product ${c.id} in listing but not ACTIVE ref`); continue; }
    if (c.price !== ref.price) { priceMismatch++; note(`price ${c.slug}: ${c.price} != ${ref.price}`); }
  }

  // 2. derived compareAt == today's shown compareAt (compareAt > price, else null)
  let compareMismatch = 0;
  for (const c of all.products) {
    const ref = byId.get(c.id)!;
    const oldShown = ref.compareAtPrice != null && ref.compareAtPrice > ref.price ? ref.compareAtPrice : null;
    if ((c.compareAtPrice ?? null) !== (oldShown ?? null)) {
      compareMismatch++; note(`compareAt ${c.slug}: ${c.compareAtPrice} != ${oldShown}`);
    }
  }

  // 3. on-sale membership == today (Product.compareAtPrice != null)
  const oldOnSaleIds = new Set(active.filter((p) => p.compareAtPrice != null).map((p) => p.id));
  const newOnSale = await runListProducts({ onSale: true, perPage: 1000 });
  const newOnSaleIds = new Set(newOnSale.products.map((p) => p.id));
  const onSaleDiff = [
    ...[...oldOnSaleIds].filter((x) => !newOnSaleIds.has(x)).map((x) => `only-old:${byId.get(x)?.slug}`),
    ...[...newOnSaleIds].filter((x) => !oldOnSaleIds.has(x)).map((x) => `only-new:${byId.get(x)?.slug}`),
  ];
  if (onSaleDiff.length) note(`on-sale membership: ${onSaleDiff.join(", ")}`);

  // 4/5. price-asc / price-desc order == Product.price DB order
  for (const dir of ["asc", "desc"] as const) {
    const ref = (
      await prisma.product.findMany({
        where: { status: "ACTIVE" },
        orderBy: [{ price: dir }],
        select: { id: true },
      })
    ).map((p) => p.id);
    const got = (await runListProducts({ sort: `price-${dir}` as "price-asc" | "price-desc", perPage: 1000 })).products.map((p) => p.id);
    if (JSON.stringify(ref) !== JSON.stringify(got)) {
      // find first divergence
      const i = ref.findIndex((x, k) => x !== got[k]);
      note(`price-${dir} order diverges at index ${i}: ref=${byId.get(ref[i])?.slug} got=${byId.get(got[i])?.slug}`);
    }
  }

  // 6. min/max filter membership == Product.price membership, over a sweep of thresholds
  const prices = [...new Set(active.map((p) => p.price))].sort((a, b) => a - b);
  const thresholds = [0, prices[0], prices[Math.floor(prices.length / 2)], prices[prices.length - 1], 99_999_999];
  let filterMismatch = 0;
  for (const min of thresholds) {
    for (const max of thresholds) {
      if (max < min) continue;
      const oldIds = new Set(active.filter((p) => p.price >= min && p.price <= max).map((p) => p.id));
      const gotIds = new Set((await runListProducts({ minPrice: min, maxPrice: max, perPage: 1000 })).products.map((p) => p.id));
      if (oldIds.size !== gotIds.size || [...oldIds].some((x) => !gotIds.has(x))) {
        filterMismatch++;
        note(`filter [${min},${max}]: old ${oldIds.size} vs new ${gotIds.size}`);
      }
    }
  }

  // 7. priceBounds == MIN/MAX Product.price (all ACTIVE).
  // (Category-scoped listings can't run outside a Next request — `loadCategoryRows`
  //  is `unstable_cache`d — so the category bounds path is covered by manual QA
  //  on the dev server. The derived-price logic is identical to the all-ACTIVE
  //  case verified here.)
  const refMin = Math.min(...active.map((p) => p.price));
  const refMax = Math.max(...active.map((p) => p.price));
  if (all.priceBounds.min !== refMin || all.priceBounds.max !== refMax) {
    note(`priceBounds (all): ${JSON.stringify(all.priceBounds)} != {min:${refMin},max:${refMax}}`);
  }

  // 8. default relevance order (no query, no price op) == Product default DB order
  const refRel = (
    await prisma.product.findMany({
      where: { status: "ACTIVE" },
      orderBy: [{ soldCount: "desc" }, { ratingAvg: "desc" }],
      select: { id: true },
    })
  ).map((p) => p.id);
  const gotRel = (await runListProducts({ perPage: 1000 })).products.map((p) => p.id);
  if (JSON.stringify(refRel) !== JSON.stringify(gotRel)) {
    const i = refRel.findIndex((x, k) => x !== gotRel[k]);
    note(`default order diverges at index ${i}: ref=${byId.get(refRel[i])?.slug} got=${byId.get(gotRel[i])?.slug}`);
  }

  // ── report ─────────────────────────────────────────────────────────────
  const report = {
    activeProducts: active.length,
    "derived price vs Product.price — mismatches": priceMismatch,
    "derived compareAt vs shown compareAt — mismatches": compareMismatch,
    "on-sale membership differences": onSaleDiff.length,
    "price-asc / price-desc order differences": issues.filter((i) => i.startsWith("price-asc") || i.startsWith("price-desc")).length,
    "min/max filter membership mismatches (over threshold sweep)": filterMismatch,
    "priceBounds mismatches": issues.filter((i) => i.includes("priceBounds")).length,
    "default relevance order differences": issues.filter((i) => i.startsWith("default order")).length,
    issues: issues.slice(0, 20),
  };
  console.log(JSON.stringify(report, null, 2));

  if (issues.length) {
    console.error(`\nSEARCH PARITY GATE FAILED — ${issues.length} issue(s).`);
    throw new Error("Phase 9D-C search parity gate failed.");
  }
  console.log("\nSEARCH PARITY GATE PASSED — offer-derived price sort / filter / bounds / on-sale are identical to Product.price for the current catalogue.");
  return report;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });
  runParity(prisma)
    .catch((e) => { console.error(e.message ?? e); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
