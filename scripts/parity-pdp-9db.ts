/**
 * Phase 9D-B — PDP price parity gate.
 *
 * Proves the Offer-based PDP price is identical to the pre-9D-B
 * `Variant.price` / `Variant.compareAtPrice` (per-variant) and `Product.price`
 * (pre-selection) for the current catalogue. Uses the REAL pure buy-box rule.
 * Exit 1 on any mismatch — run before every deploy.
 *
 * Run:  npm run parity:9db
 */
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import {
  pickWinningOffer,
  computeCatalogCardPricing,
} from "../src/lib/marketplace/buy-box-rule";
import type { OfferCandidate, CardOffer } from "../src/lib/marketplace/types";

const shown = (price: number, compareAt: number | null) =>
  compareAt != null && compareAt > price ? compareAt : null;

export async function runParity(prisma: PrismaClient) {
  const products = await prisma.product.findMany({
    where: { status: "ACTIVE" },
    select: {
      id: true,
      slug: true,
      price: true,
      compareAtPrice: true,
      variants: {
        where: { status: "ACTIVE" },
        select: {
          id: true,
          sku: true,
          price: true,
          compareAtPrice: true,
          offers: {
            select: {
              id: true,
              status: true,
              price: true,
              compareAtPrice: true,
              createdAt: true,
              seller: { select: { type: true, status: true } },
              inventory: { select: { quantity: true, reserved: true } },
            },
          },
        },
      },
    },
  });

  const stockAware = (o: (typeof products)[number]["variants"][number]["offers"][number]): OfferCandidate => ({
    offerId: o.id,
    sellerId: "",
    sellerType: o.seller.type === "FIRST_PARTY" ? "FIRST_PARTY" : "THIRD_PARTY",
    sellerStatus: o.seller.status as OfferCandidate["sellerStatus"],
    offerStatus: o.status as OfferCandidate["offerStatus"],
    available: Math.max(0, (o.inventory?.quantity ?? 0) - (o.inventory?.reserved ?? 0)),
    price: o.price,
    createdAt: o.createdAt,
  });

  let activeVariants = 0;
  let vPriceMismatch = 0;
  let vCompareMismatch = 0;
  let pRangeMismatch = 0;
  let pdpVisualChanged = 0;
  let variantNoOffer = 0;
  const samples: unknown[] = [];

  for (const p of products) {
    let productVisualChanged = false;

    for (const v of p.variants) {
      activeVariants++;
      const winner = pickWinningOffer(v.offers.map(stockAware));
      if (!winner) {
        variantNoOffer++;
        // today the PDP shows Variant.price for this variant → NEW shows "unavailable"
        productVisualChanged = true;
        samples.push({ variant: v.sku, issue: "no winning offer — PDP would show 'unavailable' (today shows a price)" });
        continue;
      }
      const row = v.offers.find((o) => o.id === winner.offerId)!;
      if (row.price !== v.price) {
        vPriceMismatch++;
        productVisualChanged = true;
        samples.push({ variant: v.sku, offerPrice: row.price, variantPrice: v.price });
      }
      if ((row.compareAtPrice ?? null) !== (v.compareAtPrice ?? null)) {
        vCompareMismatch++;
        productVisualChanged = true;
        samples.push({ variant: v.sku, offerCompare: row.compareAtPrice, variantCompare: v.compareAtPrice });
      }
    }

    // pre-selection range (stock-blind, identical to the product card / 9D-A)
    const range = computeCatalogCardPricing(
      p.variants.map((v) => v.offers.map((o): CardOffer => ({ ...stockAware(o), compareAtPrice: o.compareAtPrice }))),
    );
    if (range.minPrice !== p.price) {
      pRangeMismatch++;
      productVisualChanged = true;
      samples.push({ product: p.slug, rangeMin: range.minPrice, productPrice: p.price });
    }
    const oldPreCompare = shown(p.price, p.compareAtPrice);
    const newPreCompare = range.minPrice != null ? range.minCompareAtPrice : shown(p.price, p.compareAtPrice);
    if ((newPreCompare ?? null) !== (oldPreCompare ?? null) || range.isFrom) {
      productVisualChanged = true;
      samples.push({ product: p.slug, oldPreCompare, newPreCompare, isFrom: range.isFrom });
    }

    if (productVisualChanged) pdpVisualChanged++;
  }

  const report = {
    activeProducts: products.length,
    activeVariants,
    "winningOffer.price vs Variant.price — mismatches": vPriceMismatch,
    "winningOffer.compareAtPrice vs Variant.compareAtPrice — mismatches": vCompareMismatch,
    "product-level PDP range vs Product.price — mismatches": pRangeMismatch,
    "variants with no winning offer": variantNoOffer,
    "products with a changed PDP visual price": `${pdpVisualChanged} / ${products.length}`,
    samples: samples.slice(0, 15),
  };
  console.log(JSON.stringify(report, null, 2));

  const failed = vPriceMismatch + vCompareMismatch + pRangeMismatch + pdpVisualChanged + variantNoOffer;
  if (failed > 0) {
    console.error(`\nPDP PARITY GATE FAILED — ${failed} issue(s).`);
    throw new Error("Phase 9D-B PDP parity gate failed.");
  }
  console.log("\nPDP PARITY GATE PASSED — Offer-based PDP price is identical to Variant.price / Product.price for every product & variant.");
  return report;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });
  runParity(prisma)
    .catch((e) => {
      console.error(e.message ?? e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
