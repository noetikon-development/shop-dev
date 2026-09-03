/**
 * Phase 9D-D — stock / availability parity gate.
 *
 * Proves the Offer-derived availability now shown on the storefront (winning
 * stock-bearing 1P `OfferInventory`) is identical to the pre-9D-D
 * `Variant.stock` / `Inventory` for the current 1P catalogue. Exit 1 on any
 * mismatch — run before every deploy.
 *
 *   §32  OfferInventory.quantity  == Inventory.quantity
 *   §33  OfferInventory.reserved  == Inventory.reserved
 *        OfferInventory available  == Inventory.quantity - reserved
 *        OfferInventory.reorderPoint == Inventory.reorderPoint
 *   §33  offer available          == Variant.stock
 *   §33  per-variant stock status (offer)  == per-variant stock status (Variant.stock)
 *   §34  product.inStock / product.stockStatus (derived) == (Variant.stock reference)
 *   §42  PLP ?stock=1 membership  == { products with a Variant.stock > 0 }
 *
 * Run:  npm run parity:9dd
 *       (node --env-file=.env --conditions=react-server --import tsx …)
 */
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { pickWinningOffer, resolveVariantAvailability } from "../src/lib/marketplace/buy-box-rule";
import { stockStatusFromAvailable, rollupStatus } from "../src/lib/inventory-status";
import type { StockOfferCandidate } from "../src/lib/marketplace/types";
import { runListProducts } from "../src/lib/data";

export async function runParity(prisma: PrismaClient) {
  const issues: string[] = [];
  const note = (m: string) => issues.push(m);

  const products = await prisma.product.findMany({
    where: { status: "ACTIVE" },
    select: {
      id: true,
      slug: true,
      variants: {
        where: { status: "ACTIVE" },
        select: {
          id: true,
          sku: true,
          stock: true,
          inventory: { select: { quantity: true, reserved: true, reorderPoint: true } },
          offers: {
            select: {
              id: true,
              status: true,
              price: true,
              createdAt: true,
              seller: { select: { type: true, status: true } },
              inventory: { select: { quantity: true, reserved: true, reorderPoint: true } },
            },
          },
        },
      },
    },
  });

  type OfferRow = (typeof products)[number]["variants"][number]["offers"][number];
  const toStock = (o: OfferRow): StockOfferCandidate => ({
    offerId: o.id,
    sellerId: "",
    sellerType: o.seller.type === "FIRST_PARTY" ? "FIRST_PARTY" : "THIRD_PARTY",
    sellerStatus: o.seller.status as StockOfferCandidate["sellerStatus"],
    offerStatus: o.status as StockOfferCandidate["offerStatus"],
    available: Math.max(0, (o.inventory?.quantity ?? 0) - (o.inventory?.reserved ?? 0)),
    reorderPoint: o.inventory?.reorderPoint ?? 0,
    price: o.price,
    createdAt: o.createdAt,
  });

  let activeVariants = 0;
  let oiQtyMismatch = 0;
  let oiReservedMismatch = 0;
  let oiReorderMismatch = 0;
  let availVsVariantStock = 0;
  let statusMismatch = 0;
  let inStockMismatch = 0;
  let productStatusMismatch = 0;
  const samples: unknown[] = [];

  for (const p of products) {
    // Reference (pre-9D-D): per-variant available = Inventory.quantity - reserved,
    // mirrored to Variant.stock. Product rollup over that.
    const refStatuses = p.variants.map((v) =>
      stockStatusFromAvailable(v.stock, v.inventory?.reorderPoint ?? 0),
    );
    const refInStock = p.variants.some((v) => v.stock > 0);
    const refRollup = rollupStatus(refStatuses);

    const derivedStatuses: ReturnType<typeof stockStatusFromAvailable>[] = [];
    let derivedTotal = 0;

    for (const v of p.variants) {
      activeVariants++;
      const candidates = v.offers.map(toStock);
      // The 1P NEW OfferInventory row (what the write-through keeps in step).
      const oi = v.offers.find((o) => o.seller.type === "FIRST_PARTY")?.inventory ?? null;
      const inv = v.inventory;

      if (oi && inv) {
        if (oi.quantity !== inv.quantity) {
          oiQtyMismatch++;
          note(`OI.quantity ${v.sku}: ${oi.quantity} != Inventory ${inv.quantity}`);
        }
        if (oi.reserved !== inv.reserved) {
          oiReservedMismatch++;
          note(`OI.reserved ${v.sku}: ${oi.reserved} != Inventory ${inv.reserved}`);
        }
        if (oi.reorderPoint !== inv.reorderPoint) {
          oiReorderMismatch++;
          note(`OI.reorderPoint ${v.sku}: ${oi.reorderPoint} != Inventory ${inv.reorderPoint}`);
        }
      } else if (!oi) {
        oiQtyMismatch++;
        note(`no FIRST_PARTY OfferInventory for ${v.sku}`);
      }

      const { available, reorderPoint } = resolveVariantAvailability(candidates);
      const winner = pickWinningOffer(candidates);
      // Reference available for THIS variant: Variant.stock, but only when an
      // offer would actually be display-eligible ignoring stock — otherwise the
      // storefront already showed unavailable pre-9D-D too. For the current 1P
      // catalogue every ACTIVE variant has an ACTIVE Axiaro offer, so this is
      // just Variant.stock.
      const refAvail = winner ? v.stock : (v.stock > 0 ? v.stock : 0);
      if (available !== refAvail) {
        availVsVariantStock++;
        note(`available ${v.sku}: offer ${available} != Variant.stock ${refAvail}`);
        samples.push({ variant: v.sku, offerAvailable: available, variantStock: v.stock });
      }

      derivedTotal += available;
      derivedStatuses.push(stockStatusFromAvailable(available, reorderPoint));
    }

    // per-variant status parity
    p.variants.forEach((v, i) => {
      if (derivedStatuses[i] !== refStatuses[i]) {
        statusMismatch++;
        note(`status ${v.sku}: ${derivedStatuses[i]} != ${refStatuses[i]}`);
      }
    });

    const derivedInStock = derivedTotal > 0;
    const derivedRollup = rollupStatus(derivedStatuses);
    if (derivedInStock !== refInStock) {
      inStockMismatch++;
      note(`product.inStock ${p.slug}: ${derivedInStock} != ${refInStock}`);
    }
    if (derivedRollup !== refRollup) {
      productStatusMismatch++;
      note(`product.stockStatus ${p.slug}: ${derivedRollup} != ${refRollup}`);
    }
  }

  // §42 — PLP in-stock filter membership (all-ACTIVE scope; category scope is
  // covered by manual QA since loadCategoryRows is unstable_cache'd).
  const refInStockIds = new Set(
    products.filter((p) => p.variants.some((v) => v.stock > 0)).map((p) => p.id),
  );
  const gotInStock = await runListProducts({ inStock: true, perPage: 1000 });
  const gotIds = new Set(gotInStock.products.map((p) => p.id));
  const membershipDiff = [
    ...[...refInStockIds].filter((x) => !gotIds.has(x)).map((x) => `only-ref:${x}`),
    ...[...gotIds].filter((x) => !refInStockIds.has(x)).map((x) => `only-got:${x}`),
  ];
  if (membershipDiff.length) note(`PLP ?stock=1 membership: ${membershipDiff.join(", ")}`);

  const report = {
    activeProducts: products.length,
    activeVariants,
    "OfferInventory.quantity vs Inventory.quantity — mismatches": oiQtyMismatch,
    "OfferInventory.reserved vs Inventory.reserved — mismatches": oiReservedMismatch,
    "OfferInventory.reorderPoint vs Inventory.reorderPoint — mismatches": oiReorderMismatch,
    "offer available vs Variant.stock — mismatches": availVsVariantStock,
    "per-variant stock status — mismatches": statusMismatch,
    "product.inStock — mismatches": inStockMismatch,
    "product.stockStatus — mismatches": productStatusMismatch,
    "PLP ?stock=1 membership differences": membershipDiff.length,
    issues: issues.slice(0, 20),
  };
  console.log(JSON.stringify(report, null, 2));

  if (issues.length) {
    console.error(`\nSTOCK PARITY GATE FAILED — ${issues.length} issue(s).`);
    throw new Error("Phase 9D-D stock parity gate failed.");
  }
  console.log(
    "\nSTOCK PARITY GATE PASSED — offer-derived availability / stock status / in-stock filter are identical to Variant.stock / Inventory for the current catalogue.",
  );
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
