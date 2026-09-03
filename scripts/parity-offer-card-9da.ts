/**
 * Phase 9D-A — product-card price parity gate.
 *
 * Proves the Offer-based product-card price is byte-identical to the pre-9D-A
 * `Product.price` / `Product.compareAtPrice` for the current catalogue. Uses the
 * REAL pure functions from src/lib/marketplace/buy-box-rule.ts. Exit 1 on any
 * mismatch — run before every deploy.
 *
 * Run:  npm run parity:9da
 */
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import {
  isEligibleForDisplayPrice,
  compareCandidates,
  computeCatalogCardPricing,
} from "../src/lib/marketplace/buy-box-rule";
import type { CardOffer } from "../src/lib/marketplace/types";

function discountShown(price: number, compareAt: number | null): number | null {
  return compareAt != null && compareAt > price ? compareAt : null;
}

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
            },
          },
        },
      },
    },
  });

  let activeVariants = 0;
  let vPriceMismatch = 0;
  let vCompareMismatch = 0;
  let pMinPriceMismatch = 0;
  let visualPriceChanged = 0;
  let noWinner = 0;
  const samples: unknown[] = [];

  for (const p of products) {
    const groups: CardOffer[][] = [];
    for (const v of p.variants) {
      activeVariants++;
      const cands: CardOffer[] = v.offers.map((o) => ({
        offerId: o.id,
        sellerId: "",
        sellerType: o.seller.type === "FIRST_PARTY" ? "FIRST_PARTY" : "THIRD_PARTY",
        sellerStatus: o.seller.status as CardOffer["sellerStatus"],
        offerStatus: o.status as CardOffer["offerStatus"],
        available: 0,
        price: o.price,
        createdAt: o.createdAt,
        compareAtPrice: o.compareAtPrice,
      }));
      groups.push(cands);

      const winner = cands.filter(isEligibleForDisplayPrice).sort(compareCandidates)[0] ?? null;
      if (!winner) {
        noWinner++;
        samples.push({ variant: v.sku, issue: "no display winner" });
        continue;
      }
      if (winner.price !== v.price) {
        vPriceMismatch++;
        samples.push({ variant: v.sku, winnerPrice: winner.price, variantPrice: v.price });
      }
      if ((winner.compareAtPrice ?? null) !== (v.compareAtPrice ?? null)) {
        vCompareMismatch++;
        samples.push({ variant: v.sku, winnerCompare: winner.compareAtPrice, variantCompare: v.compareAtPrice });
      }
    }

    const pricing = computeCatalogCardPricing(groups);

    if (pricing.minPrice !== p.price) {
      pMinPriceMismatch++;
      samples.push({ product: p.slug, minPrice: pricing.minPrice, productPrice: p.price });
    }

    // Visual parity: old card showed {price: Product.price, compareAt: shown-if-> , no "From"}.
    const oldPrice = p.price;
    const oldCompare = discountShown(p.price, p.compareAtPrice);
    const newPrice = pricing.minPrice ?? p.price;
    const newCompare = pricing.minPrice != null ? pricing.minCompareAtPrice : discountShown(p.price, p.compareAtPrice);
    if (newPrice !== oldPrice || (newCompare ?? null) !== (oldCompare ?? null) || pricing.isFrom) {
      visualPriceChanged++;
      samples.push({ product: p.slug, oldPrice, newPrice, oldCompare, newCompare, isFrom: pricing.isFrom });
    }
  }

  const report = {
    activeProducts: products.length,
    activeVariants,
    "winningOffer.price vs Variant.price — mismatches": vPriceMismatch,
    "winningOffer.compareAtPrice vs Variant.compareAtPrice — mismatches": vCompareMismatch,
    "product min winning price vs Product.price — mismatches": pMinPriceMismatch,
    "products with a changed VISUAL card price": `${visualPriceChanged} / ${products.length}`,
    "products with no display winner": noWinner,
    samples: samples.slice(0, 15),
  };
  console.log(JSON.stringify(report, null, 2));

  const failed = vPriceMismatch + vCompareMismatch + pMinPriceMismatch + visualPriceChanged + noWinner;
  if (failed > 0) {
    console.error(`\nPARITY GATE FAILED — ${failed} issue(s).`);
    throw new Error("Phase 9D-A card-price parity gate failed.");
  }
  console.log("\nPARITY GATE PASSED — Offer-based card price is identical to Product.price for every product.");
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
