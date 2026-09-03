/**
 * Phase 9D-E — cart price / availability parity gate.
 *
 * Proves the cart's now-Offer-derived line price, compare-at and availability
 * are identical to the pre-9D-E `Variant.price` / `Variant.compareAtPrice` /
 * `Inventory` for the current 1P catalogue, line-total and subtotal included.
 * Exit 1 on any mismatch — run before every deploy.
 *
 * The cart's live resolution is the pure `resolveWinningOfferView` (the SAME
 * function `src/lib/cart.ts` `lineDTO` / `validateVariant` call). This gate
 * feeds every ACTIVE variant through it and compares against the old source,
 * then re-derives the `lineDTO` / `buildDTO` arithmetic (kept in
 * `mirrorLine` / `mirrorTotals` below — MUST match src/lib/cart.ts) over a
 * spread of representative carts.
 *
 * Run:  npm run parity:9de
 */
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { resolveWinningOfferView } from "../src/lib/marketplace/buy-box-rule";
import type { FullOfferCandidate, WinningOfferView } from "../src/lib/marketplace/types";

type AnyOffer = {
  id: string;
  status: string;
  price: number;
  compareAtPrice: number | null;
  createdAt: Date;
  seller: { type: string; status: string };
  inventory: { quantity: number; reserved: number; reorderPoint: number } | null;
};
const toCand = (o: AnyOffer): FullOfferCandidate => ({
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

// --- Mirror of src/lib/cart.ts `lineDTO` / `buildDTO` arithmetic -------------
// Keep in exact sync with cart.ts. The commercial DECISION (which offer wins,
// its price / availability) is `resolveWinningOfferView` — the real code; only
// this wrapper maths is reproduced.
type MirrorLine = { unitPrice: number; compareAtPrice: number | null; available: number; lineTotal: number; unavailable: boolean; overStock: boolean };
function mirrorLine(win: WinningOfferView | null, catalogEligible: boolean, quantity: number, priceSnapshot: number): MirrorLine {
  const available = win?.available ?? 0;
  const unavailable = !catalogEligible || win === null || available <= 0;
  const unitPrice = win?.price ?? priceSnapshot;
  const buyable = Math.min(quantity, available);
  return {
    unitPrice,
    compareAtPrice: win?.compareAtPrice ?? null,
    available,
    lineTotal: unavailable ? 0 : unitPrice * buyable,
    unavailable,
    overStock: !unavailable && quantity > available,
  };
}
function mirrorTotals(lines: { l: MirrorLine; quantity: number }[]) {
  const purchasable = lines.filter((x) => !x.l.unavailable);
  return {
    subtotal: purchasable.reduce((n, x) => n + x.l.lineTotal, 0),
    itemCount: purchasable.reduce((n, x) => n + Math.min(x.quantity, x.l.available), 0),
  };
}

export async function runParity(prisma: PrismaClient) {
  const issues: string[] = [];
  const note = (m: string) => issues.push(m);

  // ── §30 — per-variant price / compare-at / availability ──────────────────
  const variants = await prisma.variant.findMany({
    where: { status: "ACTIVE" },
    select: {
      id: true,
      sku: true,
      price: true,
      compareAtPrice: true,
      status: true,
      product: { select: { status: true } },
      inventory: { select: { quantity: true, reserved: true } },
      offers: {
        select: {
          id: true,
          status: true,
          price: true,
          compareAtPrice: true,
          createdAt: true,
          seller: { select: { type: true, status: true } },
          inventory: { select: { quantity: true, reserved: true, reorderPoint: true } },
        },
      },
    },
  });

  let priceMismatch = 0;
  let compareMismatch = 0;
  let availMismatch = 0;
  let lineMismatch = 0;

  const cartInputs: { win: WinningOfferView | null; catalogEligible: boolean; quantity: number; snapshot: number; ref: MirrorLine }[] = [];
  let qtyRot = 1;

  for (const v of variants) {
    const win = resolveWinningOfferView(v.offers.map(toCand));
    const refAvail = Math.max(0, (v.inventory?.quantity ?? 0) - (v.inventory?.reserved ?? 0));
    if (!win) {
      note(`no winning offer for ${v.sku} (Variant.price ${v.price}, ref available ${refAvail})`);
      priceMismatch++;
      continue;
    }
    if (win.price !== v.price) { priceMismatch++; note(`price ${v.sku}: offer ${win.price} != Variant ${v.price}`); }
    if ((win.compareAtPrice ?? null) !== (v.compareAtPrice ?? null)) { compareMismatch++; note(`compareAt ${v.sku}: offer ${win.compareAtPrice} != Variant ${v.compareAtPrice}`); }
    if (win.available !== refAvail) { availMismatch++; note(`available ${v.sku}: offer ${win.available} != Inventory ${refAvail}`); }

    // §31 — line + total parity. NEW line via the mirror; REFERENCE line via the
    // pre-9D-E source (Variant.price + Inventory).
    const catalogEligible = v.status === "ACTIVE" && v.product.status === "ACTIVE";
    const quantity = ((qtyRot++ % 3) + 1); // 1,2,3,1,2,3…
    const snapshot = v.price;
    const newLine = mirrorLine(win, catalogEligible, quantity, snapshot);

    const refAvailable = refAvail;
    const refUnavailable = !catalogEligible || refAvailable <= 0;
    const refUnit = v.price;
    const refBuyable = Math.min(quantity, refAvailable);
    const refLine: MirrorLine = {
      unitPrice: refUnit,
      compareAtPrice: v.compareAtPrice,
      available: refAvailable,
      lineTotal: refUnavailable ? 0 : refUnit * refBuyable,
      unavailable: refUnavailable,
      overStock: !refUnavailable && quantity > refAvailable,
    };
    if (JSON.stringify(newLine) !== JSON.stringify(refLine)) {
      lineMismatch++;
      note(`line ${v.sku}: ${JSON.stringify(newLine)} != ${JSON.stringify(refLine)}`);
    }
    cartInputs.push({ win, catalogEligible, quantity, snapshot, ref: refLine });
  }

  // ── §31 — representative multi-line cart totals ─────────────────────────
  // Slice the variant set into carts of 1 / 2 / 3 / 5 / 8 lines and compare
  // subtotal + itemCount NEW vs REFERENCE.
  let totalsMismatch = 0;
  for (const size of [1, 2, 3, 5, 8]) {
    for (let start = 0; start + size <= cartInputs.length; start += size) {
      const slice = cartInputs.slice(start, start + size);
      const newTotals = mirrorTotals(slice.map((s) => ({ l: mirrorLine(s.win, s.catalogEligible, s.quantity, s.snapshot), quantity: s.quantity })));
      const refTotals = mirrorTotals(slice.map((s) => ({ l: s.ref, quantity: s.quantity })));
      if (newTotals.subtotal !== refTotals.subtotal || newTotals.itemCount !== refTotals.itemCount) {
        totalsMismatch++;
        note(`cart[${start}..${start + size}] totals: ${JSON.stringify(newTotals)} != ${JSON.stringify(refTotals)}`);
      }
      break; // one representative cart per size is enough
    }
  }

  const report = {
    activeVariants: variants.length,
    "winningOffer.price vs Variant.price — mismatches": priceMismatch,
    "winningOffer.compareAtPrice vs Variant.compareAtPrice — mismatches": compareMismatch,
    "winningOffer.available vs Inventory available — mismatches": availMismatch,
    "cart line (unitPrice/compareAt/available/lineTotal/flags) — mismatches": lineMismatch,
    "cart totals (subtotal/itemCount) — mismatches": totalsMismatch,
    issues: issues.slice(0, 20),
  };
  console.log(JSON.stringify(report, null, 2));

  if (issues.length) {
    console.error(`\nCART PARITY GATE FAILED — ${issues.length} issue(s).`);
    throw new Error("Phase 9D-E cart parity gate failed.");
  }
  console.log(
    "\nCART PARITY GATE PASSED — offer-derived cart line price / compare-at / availability / line-total / subtotal are identical to Variant.price / Inventory for the current catalogue.",
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
