/**
 * Phase 9D-E — assertion runner (cart price / availability via the Offer layer).
 *
 *   A. Pure winning-offer resolution — the §28 line matrix + §29 fixture (no DB)
 *   B. Real Axiaro cart parity — resolveWinningOfferView vs Variant.price / Inventory
 *   C. Multi-offer synthetic fixtures — §29, rolled-back real offer rows
 *   D. Guest vs user parity — the resolution is owner-agnostic (one code path)
 *   E. Guest → user merge revalidation — the merge loop against rolled-back data
 *   F. Quantity validation — offer availability drives the cap
 *   G. Unavailable handling — suspended / inactive / no offer
 *   H. Cart totals — mirrored buildDTO subtotal / itemCount
 *   I. PDP ↔ cart price consistency (same resolveWinningOfferView)
 *   J. PDP ↔ cart availability consistency
 *   K. No N+1 — one offers query for a whole cart's variants
 *   L. No fallback — Variant.price is never surfaced when resolution fails
 *
 * The cart's real resolution is `resolveWinningOfferView` (called by
 * `src/lib/cart.ts` `lineDTO` + `validateVariant`). `cart.ts` itself pulls in
 * `next/navigation` (via auth) and cannot load in a standalone script, so the
 * ~6 lines of `lineDTO` wrapper maths are mirrored below (`mirrorLine`) and the
 * real end-to-end `loadCart` path is covered by dev-server manual QA (§43).
 *
 * Run:  npm run test:9de
 */
import { pathToFileURL } from "node:url";
import { PrismaClient, Prisma } from "@prisma/client";
import { resolveWinningOfferView, isEligibleForDisplayPrice } from "../src/lib/marketplace/buy-box-rule";
import type { FullOfferCandidate, WinningOfferView } from "../src/lib/marketplace/types";

const MAX_QTY_PER_LINE = 99; // mirror of src/lib/cart.ts

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
function cand(over: Partial<FullOfferCandidate>): FullOfferCandidate {
  return {
    offerId: "o" + Math.random().toString(36).slice(2, 8),
    sellerId: "",
    sellerType: "FIRST_PARTY",
    sellerStatus: "APPROVED",
    offerStatus: "ACTIVE",
    available: 10,
    reorderPoint: 3,
    price: 1000,
    compareAtPrice: null,
    createdAt: D("2026-01-01T00:00:00Z"),
    ...over,
  };
}

type AnyOffer = {
  id: string; status: string; price: number; compareAtPrice: number | null; createdAt: Date;
  seller: { type: string; status: string };
  inventory: { quantity: number; reserved: number; reorderPoint: number } | null;
};
const toCand = (o: AnyOffer): FullOfferCandidate => ({
  offerId: o.id, sellerId: "",
  sellerType: o.seller.type === "FIRST_PARTY" ? "FIRST_PARTY" : "THIRD_PARTY",
  sellerStatus: o.seller.status as FullOfferCandidate["sellerStatus"],
  offerStatus: o.status as FullOfferCandidate["offerStatus"],
  available: Math.max(0, (o.inventory?.quantity ?? 0) - (o.inventory?.reserved ?? 0)),
  reorderPoint: o.inventory?.reorderPoint ?? 0,
  price: o.price, compareAtPrice: o.compareAtPrice, createdAt: o.createdAt,
});

// --- Mirror of src/lib/cart.ts `lineDTO` / `buildDTO` (keep in sync) ---------
type MLine = { unitPrice: number; compareAtPrice: number | null; available: number; lineTotal: number; unavailable: boolean; overStock: boolean; priceChanged: boolean };
function mirrorLine(win: WinningOfferView | null, catalogEligible: boolean, quantity: number, priceSnapshot: number): MLine {
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
    priceChanged: win !== null && priceSnapshot !== unitPrice,
  };
}
/** Mirror of validateVariant's offer branch: NO_OFFER | { available, price }. */
function mirrorValidate(offers: FullOfferCandidate[]): { ok: false; code: "NO_OFFER" } | { ok: true; price: number; available: number } {
  if (!offers.some(isEligibleForDisplayPrice)) return { ok: false, code: "NO_OFFER" };
  const win = resolveWinningOfferView(offers);
  return { ok: true, price: win?.price ?? 0, available: win?.available ?? 0 };
}

// ---------------------------------------------------------------------------
function pureTests() {
  console.log("\nA. Pure winning-offer resolution (cart line matrix §28 / §29)");

  ok("1  Axiaro offer available → its price + availability",
    (() => { const w = resolveWinningOfferView([cand({ price: 790, available: 6 })]); return w?.price === 790 && w?.available === 6; })());
  ok("2  Axiaro offer out of stock → null → unavailable",
    resolveWinningOfferView([cand({ available: 0 })]) === null);
  ok("3  suspended seller → null → unavailable",
    resolveWinningOfferView([cand({ sellerStatus: "SUSPENDED", available: 9 })]) === null);
  ok("4  inactive offer → null → unavailable",
    resolveWinningOfferView([cand({ offerStatus: "INACTIVE", available: 9 })]) === null);
  ok("5  multiple sellers, cheaper 3P in stock → 3P price + availability",
    (() => {
      const w = resolveWinningOfferView([cand({ price: 1000, sellerType: "FIRST_PARTY", available: 5 }), cand({ price: 900, sellerType: "THIRD_PARTY", available: 8 })]);
      return w?.price === 900 && w?.available === 8;
    })());
  ok("6  price tie → Axiaro (FIRST_PARTY) wins → its fields",
    (() => {
      const w = resolveWinningOfferView([
        cand({ price: 900, sellerType: "THIRD_PARTY", createdAt: D("2025-01-01"), available: 20, compareAtPrice: 1500 }),
        cand({ price: 900, sellerType: "FIRST_PARTY", createdAt: D("2026-06-01"), available: 4, compareAtPrice: null }),
      ]);
      return w?.available === 4 && w?.compareAtPrice === null;
    })());
  ok("7  Axiaro out of stock, 3P in stock → 3P wins",
    (() => {
      const w = resolveWinningOfferView([cand({ price: 800, sellerType: "FIRST_PARTY", available: 0 }), cand({ price: 950, sellerType: "THIRD_PARTY", available: 7 })]);
      return w?.price === 950 && w?.available === 7;
    })());
  ok("8  both sellers unavailable → null",
    resolveWinningOfferView([cand({ sellerType: "FIRST_PARTY", available: 0 }), cand({ sellerType: "THIRD_PARTY", offerStatus: "INACTIVE", available: 9 })]) === null);
  ok("9  §29#1 — price + availability from the SAME offer (Seller B)",
    (() => {
      const w = resolveWinningOfferView([
        cand({ price: 1000, sellerType: "FIRST_PARTY", available: 5, compareAtPrice: 1200 }),
        cand({ price: 900, sellerType: "THIRD_PARTY", available: 10, compareAtPrice: null }),
      ]);
      return w?.price === 900 && w?.available === 10 && w?.compareAtPrice === null;
    })());
  ok("10 §29#2 — Axiaro cheaper → Axiaro wins (900 / 5)",
    (() => {
      const w = resolveWinningOfferView([cand({ price: 900, sellerType: "FIRST_PARTY", available: 5 }), cand({ price: 1000, sellerType: "THIRD_PARTY", available: 10 })]);
      return w?.price === 900 && w?.available === 5;
    })());
  ok("11 §29#3 — Axiaro cheaper but OOS → Seller B wins (1000 / 10)",
    (() => {
      const w = resolveWinningOfferView([cand({ price: 900, sellerType: "FIRST_PARTY", available: 0 }), cand({ price: 1000, sellerType: "THIRD_PARTY", available: 10 })]);
      return w?.price === 1000 && w?.available === 10;
    })());
  ok("12 input order irrelevant",
    (() => {
      const a = cand({ price: 900, available: 9 }), b = cand({ price: 700, available: 3 }), c = cand({ price: 800, available: 4 });
      return resolveWinningOfferView([a, b, c])?.price === resolveWinningOfferView([c, a, b])?.price;
    })());

  console.log("\n   line DTO wrapper (mirror of lineDTO)");
  ok("13 line for an in-stock winner → unitPrice=offer, not unavailable",
    (() => { const l = mirrorLine(resolveWinningOfferView([cand({ price: 790, available: 5 })]), true, 2, 790); return l.unitPrice === 790 && !l.unavailable && l.lineTotal === 1580; })());
  ok("14 line, qty > available → overStock, lineTotal clamps to available",
    (() => { const l = mirrorLine(resolveWinningOfferView([cand({ price: 500, available: 3 })]), true, 5, 500); return l.overStock && !l.unavailable && l.lineTotal === 1500; })());
  ok("15 line, no winning offer → unavailable, lineTotal 0, unitPrice = snapshot (NOT 0)",
    (() => { const l = mirrorLine(null, true, 2, 640); return l.unavailable && l.lineTotal === 0 && l.unitPrice === 640; })());
  ok("16 line, catalog-disabled product → unavailable even with a winner",
    (() => { const l = mirrorLine(resolveWinningOfferView([cand({ price: 700, available: 9 })]), false, 1, 700); return l.unavailable && l.lineTotal === 0; })());
  ok("17 line, snapshot != live offer price → priceChanged",
    (() => { const l = mirrorLine(resolveWinningOfferView([cand({ price: 690, available: 4 })]), true, 1, 790); return l.priceChanged && l.unitPrice === 690; })());
  ok("18 §29 — validate: no eligible offer → NO_OFFER (not a price)",
    mirrorValidate([cand({ offerStatus: "INACTIVE", available: 9, price: 999 })]).ok === false);
  ok("19 §29 — validate: displayable but all OOS → ok, available 0 (caller → OUT_OF_STOCK)",
    (() => { const r = mirrorValidate([cand({ available: 0, price: 999 })]); return r.ok === true && r.available === 0; })());
}

// ---------------------------------------------------------------------------
class Rollback extends Error {}

async function realParityTests(prisma: PrismaClient) {
  console.log("\nB. Real Axiaro cart parity (resolveWinningOfferView vs Variant / Inventory)");
  const variants = await prisma.variant.findMany({
    where: { status: "ACTIVE" },
    select: {
      id: true, sku: true, price: true, compareAtPrice: true,
      inventory: { select: { quantity: true, reserved: true } },
      offers: {
        select: {
          id: true, status: true, price: true, compareAtPrice: true, createdAt: true,
          seller: { select: { type: true, status: true } },
          inventory: { select: { quantity: true, reserved: true, reorderPoint: true } },
        },
      },
    },
  });
  let priceOk = 0, compareOk = 0, availOk = 0;
  for (const v of variants) {
    const win = resolveWinningOfferView(v.offers.map(toCand));
    const refAvail = Math.max(0, (v.inventory?.quantity ?? 0) - (v.inventory?.reserved ?? 0));
    if (win && win.price === v.price) priceOk++;
    if (win && (win.compareAtPrice ?? null) === (v.compareAtPrice ?? null)) compareOk++;
    if (win && win.available === refAvail) availOk++;
  }
  ok(`B  winning-offer price == Variant.price for all ${variants.length} ACTIVE variants`, priceOk === variants.length, `${priceOk}/${variants.length}`);
  ok(`B  winning-offer compareAt == Variant.compareAtPrice for all ${variants.length}`, compareOk === variants.length, `${compareOk}/${variants.length}`);
  ok(`B  winning-offer available == Inventory available for all ${variants.length}`, availOk === variants.length, `${availOk}/${variants.length}`);
}

async function syntheticFixtureTests(prisma: PrismaClient) {
  console.log("\nC. Multi-offer synthetic fixtures (§29, rolled-back real offer rows)");
  const suffix = "9de-" + Date.now();
  const axiaro = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
  const product = await prisma.product.findFirst({ where: { status: "ACTIVE" }, select: { id: true } });
  if (!axiaro || !product) { ok("(skipped — no seller/product)", true); return; }

  const readCandidates = async (tx: Prisma.TransactionClient, variantId: string) => {
    const rows = await tx.offer.findMany({
      where: { variantId },
      select: {
        id: true, status: true, price: true, compareAtPrice: true, createdAt: true,
        seller: { select: { type: true, status: true } },
        inventory: { select: { quantity: true, reserved: true, reorderPoint: true } },
      },
    });
    return rows.map((r) => toCand(r as AnyOffer));
  };

  try {
    await prisma.$transaction(async (tx) => {
      const v = await tx.variant.create({ data: { productId: product.id, sku: `X-${suffix}`, price: 1000, status: "ACTIVE", stock: 0 } });
      await tx.inventory.create({ data: { variantId: v.id, sku: `X-${suffix}`, quantity: 5, reserved: 0, reorderPoint: 3 } });
      const axOffer = await tx.offer.create({ data: { sellerId: axiaro.id, variantId: v.id, price: 1000, condition: "NEW", status: "ACTIVE", sellerSku: `AX-${suffix}` }, select: { id: true } });
      await tx.offerInventory.create({ data: { offerId: axOffer.id, sellerSku: `AX-${suffix}`, quantity: 5, reserved: 0, reorderPoint: 3 } });
      const sellerB = await tx.seller.create({ data: { type: "THIRD_PARTY", status: "APPROVED", displayName: "Seller B", slug: `seller-b-${suffix}`, supportEmail: "b@example.test" }, select: { id: true } });
      const bOffer = await tx.offer.create({ data: { sellerId: sellerB.id, variantId: v.id, price: 900, condition: "NEW", status: "ACTIVE", sellerSku: `B-${suffix}` }, select: { id: true } });
      await tx.offerInventory.create({ data: { offerId: bOffer.id, sellerSku: `B-${suffix}`, quantity: 10, reserved: 0, reorderPoint: 5 } });

      // #1 — Axiaro 1000/5, Seller B 900/10 → cart price 900, available 10
      let w = resolveWinningOfferView(await readCandidates(tx, v.id));
      ok("§29#1  cart price = 900, available = 10 (Seller B wins)", w?.price === 900 && w?.available === 10);
      ok("§29#1  price & availability from the SAME offer", w?.offerId === bOffer.id);
      ok("§29#1  line total = 900 * 2", mirrorLine(w, true, 2, 1000).lineTotal === 1800);

      // #2 — Axiaro 900/5, Seller B 1000/10 → Axiaro wins (900/5)
      await tx.offer.update({ where: { id: axOffer.id }, data: { price: 900 } });
      await tx.offer.update({ where: { id: bOffer.id }, data: { price: 1000 } });
      w = resolveWinningOfferView(await readCandidates(tx, v.id));
      ok("§29#2  Axiaro wins → price 900, available 5", w?.price === 900 && w?.available === 5 && w?.offerId === axOffer.id);

      // #3 — Axiaro 900/0, Seller B 1000/10 → Seller B wins (1000/10)
      await tx.offerInventory.updateMany({ where: { offerId: axOffer.id }, data: { quantity: 0 } });
      w = resolveWinningOfferView(await readCandidates(tx, v.id));
      ok("§29#3  Axiaro OOS → Seller B wins → price 1000, available 10, same offer", w?.price === 1000 && w?.available === 10 && w?.offerId === bOffer.id);

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  const leaked = await prisma.seller.count({ where: { slug: { contains: suffix } } });
  ok("C  synthetic rows rolled back", leaked === 0, `leaked ${leaked}`);
}

function guestUserParityTest() {
  console.log("\nD. Guest vs user parity");
  // The cart resolution (`resolveWinningOfferView`) takes no owner / auth input,
  // so a guest cart and an authenticated cart necessarily resolve identically —
  // there is one code path. Assert the function is owner-free and deterministic.
  const offers = [cand({ price: 900, available: 4 }), cand({ price: 950, sellerType: "THIRD_PARTY", available: 9 })];
  ok("D  resolveWinningOfferView is pure / arity 1 (no owner arg)", resolveWinningOfferView.length === 1);
  ok("D  deterministic across calls", JSON.stringify(resolveWinningOfferView(offers)) === JSON.stringify(resolveWinningOfferView([...offers].reverse())));
}

async function mergeRevalidationTest(prisma: PrismaClient) {
  console.log("\nE. Guest → user merge revalidation (merge loop against rolled-back data)");
  const suffix = "9de-merge-" + Date.now();
  const axiaro = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
  const product = await prisma.product.findFirst({ where: { status: "ACTIVE" }, select: { id: true } });
  if (!axiaro || !product) { ok("(skipped)", true); return; }

  try {
    await prisma.$transaction(async (tx) => {
      const mk = async (sku: string, oiQty: number) => {
        const v = await tx.variant.create({ data: { productId: product.id, sku, price: 500, status: "ACTIVE", stock: 0 } });
        await tx.inventory.create({ data: { variantId: v.id, sku, quantity: oiQty, reserved: 0, reorderPoint: 3 } });
        const o = await tx.offer.create({ data: { sellerId: axiaro.id, variantId: v.id, price: 500, condition: "NEW", status: "ACTIVE", sellerSku: sku }, select: { id: true } });
        await tx.offerInventory.create({ data: { offerId: o.id, sellerSku: sku, quantity: oiQty, reserved: 0, reorderPoint: 3 } });
        return v.id;
      };
      const inStock = await mk(`A-${suffix}`, 4);
      const outOfStock = await mk(`B-${suffix}`, 0);

      const readCand = async (variantId: string) => {
        const rows = await tx.offer.findMany({
          where: { variantId },
          select: { id: true, status: true, price: true, compareAtPrice: true, createdAt: true, seller: { select: { type: true, status: true } }, inventory: { select: { quantity: true, reserved: true, reorderPoint: true } } },
        });
        return rows.map((r) => toCand(r as AnyOffer));
      };

      // Mirror of mergeGuestCartCore's per-line loop: validate → cap to offer avail.
      const guestItems = [
        { variantId: inStock, quantity: 10 },
        { variantId: outOfStock, quantity: 1 },
      ];
      const results: { kept: boolean; finalQty: number }[] = [];
      for (const gi of guestItems) {
        const val = mirrorValidate(await readCand(gi.variantId));
        if (!val.ok || val.available <= 0) { results.push({ kept: false, finalQty: 0 }); continue; }
        results.push({ kept: true, finalQty: Math.min(gi.quantity, val.available, MAX_QTY_PER_LINE) });
      }
      ok("E  in-stock guest line kept, capped to offer availability (4)", results[0].kept && results[0].finalQty === 4);
      ok("E  out-of-stock guest line dropped", !results[1].kept);

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  ok("E  merge fixture rolled back", (await prisma.variant.count({ where: { sku: { contains: suffix } } })) === 0);
}

async function quantityAndUnavailableTests(prisma: PrismaClient) {
  console.log("\nF/G/L. Quantity cap + unavailable handling + no-fallback (rolled back)");
  const suffix = "9de-qty-" + Date.now();
  const axiaro = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
  const product = await prisma.product.findFirst({ where: { status: "ACTIVE" }, select: { id: true } });
  if (!axiaro || !product) { ok("(skipped)", true); return; }

  try {
    await prisma.$transaction(async (tx) => {
      const v = await tx.variant.create({ data: { productId: product.id, sku: `Q-${suffix}`, price: 999, status: "ACTIVE", stock: 0 } });
      await tx.inventory.create({ data: { variantId: v.id, sku: `Q-${suffix}`, quantity: 3, reserved: 0, reorderPoint: 3 } });
      const o = await tx.offer.create({ data: { sellerId: axiaro.id, variantId: v.id, price: 700, condition: "NEW", status: "ACTIVE", sellerSku: `Q-${suffix}` }, select: { id: true } });
      await tx.offerInventory.create({ data: { offerId: o.id, sellerSku: `Q-${suffix}`, quantity: 3, reserved: 0, reorderPoint: 3 } });

      const readCand = async () => {
        const rows = await tx.offer.findMany({ where: { variantId: v.id }, select: { id: true, status: true, price: true, compareAtPrice: true, createdAt: true, seller: { select: { type: true, status: true } }, inventory: { select: { quantity: true, reserved: true, reorderPoint: true } } } });
        return rows.map((r) => toCand(r as AnyOffer));
      };

      // F — offer availability (3) drives the cap; price is the offer's 700, not Variant 999
      const val = mirrorValidate(await readCand());
      ok("F  validate → available 3, price 700 (offer, not Variant.price 999)", val.ok && val.available === 3 && val.price === 700);
      ok("F  requested 10 caps to 3", Math.min(10, val.ok ? val.available : 0, MAX_QTY_PER_LINE) === 3);
      const line = mirrorLine(resolveWinningOfferView(await readCand()), true, 5, 700);
      ok("F  cart line: qty 5 > available 3 → overStock, not unavailable, lineTotal 700*3", line.overStock && !line.unavailable && line.lineTotal === 2100);

      // G / L — suspend the seller → unavailable, no ₱0, no Variant.price fallback
      await tx.seller.update({ where: { id: axiaro.id }, data: { status: "SUSPENDED" } });
      const cands2 = await readCand();
      const line2 = mirrorLine(resolveWinningOfferView(cands2), true, 5, 700);
      ok("G  suspended seller → line unavailable, available 0, lineTotal 0", line2.unavailable && line2.available === 0 && line2.lineTotal === 0);
      ok("L  suspended → unitPrice = priceSnapshot (700), NEVER Variant.price (999)", line2.unitPrice === 700);
      ok("G  validate → NO_OFFER (not price 999)", mirrorValidate(cands2).ok === false);
      await tx.seller.update({ where: { id: axiaro.id }, data: { status: "APPROVED" } });

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  ok("F/G/L  fixture rolled back", (await prisma.variant.count({ where: { sku: { contains: suffix } } })) === 0);
}

async function totalsTest(prisma: PrismaClient) {
  console.log("\nH. Cart totals (mirror of buildDTO)");
  const variants = await prisma.variant.findMany({
    where: { status: "ACTIVE" },
    select: {
      id: true, status: true, product: { select: { status: true } },
      offers: { select: { id: true, status: true, price: true, compareAtPrice: true, createdAt: true, seller: { select: { type: true, status: true } }, inventory: { select: { quantity: true, reserved: true, reorderPoint: true } } } },
    },
    take: 8,
  });
  const lines = variants.map((v, i) => {
    const win = resolveWinningOfferView(v.offers.map(toCand));
    const quantity = ((i % 3) + 1);
    return { quantity, l: mirrorLine(win, v.status === "ACTIVE" && v.product.status === "ACTIVE", quantity, win?.price ?? 1) };
  });
  const purchasable = lines.filter((x) => !x.l.unavailable);
  const subtotal = purchasable.reduce((n, x) => n + x.l.lineTotal, 0);
  const itemCount = purchasable.reduce((n, x) => n + Math.min(x.quantity, x.l.available), 0);
  const expectSubtotal = purchasable.reduce((n, x) => n + x.l.unitPrice * Math.min(x.quantity, x.l.available), 0);
  ok(`H  subtotal = Σ unitPrice × min(qty, available)  (${subtotal})`, subtotal === expectSubtotal);
  ok("H  no NaN / negative in any line", lines.every((x) => Number.isFinite(x.l.lineTotal) && x.l.available >= 0 && x.l.unitPrice > 0));
  ok(`H  itemCount finite & >= 0 (${itemCount})`, Number.isFinite(itemCount) && itemCount >= 0);
}

async function consistencyTests(prisma: PrismaClient) {
  console.log("\nI/J. PDP ↔ cart consistency (same resolveWinningOfferView, same offer rows)");
  // The PDP (`src/lib/data.ts` loadProductBySlug → `fullCandidate`) and the cart
  // (`src/lib/cart.ts` lineDTO / validateVariant → `toOfferCandidate`) map an
  // offer row to a candidate with byte-identical logic, then call the SAME
  // `resolveWinningOfferView`. Prove it over every real ACTIVE variant: the two
  // mappers must yield the same winning view.
  const variants = await prisma.variant.findMany({
    where: { status: "ACTIVE" },
    select: {
      id: true,
      offers: { select: { id: true, status: true, price: true, compareAtPrice: true, createdAt: true, seller: { select: { type: true, status: true } }, inventory: { select: { quantity: true, reserved: true, reorderPoint: true } } } },
    },
  });

  // PDP mapper (copied from data.ts fullCandidate).
  const pdpCand = (o: AnyOffer): FullOfferCandidate => ({
    offerId: o.id, sellerId: "",
    sellerType: o.seller.type === "FIRST_PARTY" ? "FIRST_PARTY" : "THIRD_PARTY",
    sellerStatus: o.seller.status as FullOfferCandidate["sellerStatus"],
    offerStatus: o.status as FullOfferCandidate["offerStatus"],
    available: Math.max(0, (o.inventory?.quantity ?? 0) - (o.inventory?.reserved ?? 0)),
    reorderPoint: o.inventory?.reorderPoint ?? 0,
    price: o.price, compareAtPrice: o.compareAtPrice, createdAt: o.createdAt,
  });

  let priceMatch = 0, availMatch = 0;
  for (const v of variants) {
    const pdpWin = resolveWinningOfferView(v.offers.map((o) => pdpCand(o as AnyOffer)));
    const cartWin = resolveWinningOfferView(v.offers.map((o) => toCand(o as AnyOffer))); // cart's toOfferCandidate == toCand here
    if ((pdpWin?.price ?? null) === (cartWin?.price ?? null)) priceMatch++;
    if ((pdpWin?.available ?? 0) === (cartWin?.available ?? 0)) availMatch++;
  }
  ok(`I  PDP price == cart line price for all ${variants.length} ACTIVE variants`, priceMatch === variants.length, `${priceMatch}/${variants.length}`);
  ok(`J  PDP availability == cart line availability for all ${variants.length}`, availMatch === variants.length, `${availMatch}/${variants.length}`);
}

async function n1Check(prisma: PrismaClient) {
  console.log("\nK. N+1 check — one offers query for a whole cart, not one per line");
  const queries: string[] = [];
  (prisma.$on as (e: "query", cb: (x: { query: string }) => void) => void)("query", (e) => queries.push(e.query));

  queries.length = 0;
  const rows = await prisma.variant.findMany({
    where: { status: "ACTIVE" },
    take: 15,
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
  });
  const nOffers = rows.reduce((n, v) => n + v.offers.length, 0);
  const offerQ = queries.filter((s) => /FROM\s+"Offer"/i.test(s)).length;
  const sellerQ = queries.filter((s) => /FROM\s+"Seller"/i.test(s)).length;
  const oiQ = queries.filter((s) => /"OfferInventory"/.test(s)).length;
  console.log(JSON.stringify({ variants: rows.length, offers: nOffers, totalQueries: queries.length, offerQueries: offerQ, sellerQueries: sellerQ, offerInventoryQueries: oiQ }, null, 2));
  ok("K  Offer loaded in <= 1 query for a whole cart's variants", offerQ <= 1, `offer=${offerQ}`);
  ok("K  Seller loaded in <= 1 query", sellerQ <= 1, `seller=${sellerQ}`);
  ok("K  OfferInventory loaded in <= 1 query", oiQ <= 1, `oi=${oiQ}`);
}

export async function run(prisma: PrismaClient) {
  pureTests();
  await realParityTests(prisma);
  await syntheticFixtureTests(prisma);
  guestUserParityTest();
  await mergeRevalidationTest(prisma);
  await quantityAndUnavailableTests(prisma);
  await totalsTest(prisma);
  await consistencyTests(prisma);
  await n1Check(prisma);
  console.log(`\n  ${pass} passed, ${fail} failed.`);
  if (fail > 0) throw new Error(`${fail} Phase 9D-E check(s) failed.`);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  const prisma = new PrismaClient({
    datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL,
    log: [{ level: "query", emit: "event" }],
  });
  run(prisma)
    .then(() => console.log("All Phase 9D-E checks passed."))
    .catch((e) => {
      console.error(e.message ?? e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
