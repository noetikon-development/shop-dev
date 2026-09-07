/**
 * PHASE UI-PDP-CONDITION — the PDP seller-information block shows the winning
 * offer's listing condition (Offer.condition → conditionLabel()), for BOTH
 * FIRST_PARTY and THIRD_PARTY winners, from the same already-loaded offer row.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-pdp-condition.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { resolveWinningOfferView } from "../src/lib/marketplace/buy-box-rule";
import { conditionLabel } from "../src/lib/seller/format";
import type { FullOfferCandidate } from "../src/lib/marketplace/types";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

function pureTests() {
  console.log("\nPure — conditionLabel (existing helper, unchanged)");
  ok("NEW → New", conditionLabel("NEW") === "New");
  ok("REFURBISHED → Refurbished", conditionLabel("REFURBISHED") === "Refurbished");
  ok("USED_LIKE_NEW → Used — like new", conditionLabel("USED_LIKE_NEW") === "Used — like new");
  ok("USED_GOOD → Used — good", conditionLabel("USED_GOOD") === "Used — good");
  ok("unknown value falls back to the raw string", conditionLabel("MYSTERY") === "MYSTERY");
}

function staticTests() {
  console.log("\nStatic wiring");
  const data = read("src/lib/data.ts");
  const types = read("src/lib/types.ts");
  const viewer = read("src/components/pdp/product-viewer.tsx");

  ok("data · PDP offer select now includes condition", /condition: true,\s*\n\s*inventory: \{ select: \{ quantity: true/.test(data));
  ok("data · variantOffer returns offerCondition from the winner row", /offerCondition: winnerRow\?\.condition \?\? null,/.test(data));
  ok("data · variant DTO carries off.offerCondition through", /offerCondition: off\.offerCondition,/.test(data));
  ok("types · VariantView gains offerCondition: string | null", /offerCondition: string \| null;/.test(types));

  // still exactly one DB call, resolver untouched
  const loadFn = data.slice(data.indexOf("async function loadProductBySlug"), data.indexOf("export const getProductBySlug"));
  const prismaCalls = (loadFn.match(/\bprisma\.\w+\.(findFirst|findUnique|findMany|count|aggregate|groupBy)\(/g) ?? []);
  ok("data · loadProductBySlug still makes exactly ONE database call", prismaCalls.length === 1, prismaCalls.join(" | "));
  ok("data · resolveWinningOfferView call is unchanged", /const win = resolveWinningOfferView\(offers\.map\(fullCandidate\)\);/.test(data));
  ok("data · buy-box-rule.ts not touched by this phase", !/UI-PDP-CONDITION|offerCondition/.test(read("src/lib/marketplace/buy-box-rule.ts")));

  ok("ui · conditionLabel imported from the existing seller/format helper", /import \{ conditionLabel \} from "@\/lib\/seller\/format";/.test(viewer));
  ok("ui · Condition row sits directly under 'Sold by'", viewer.indexOf(">Sold by</dt>") < viewer.indexOf(">Condition</dt>") && viewer.indexOf(">Condition</dt>") < viewer.indexOf(">Payment</dt>"));
  ok("ui · Condition value is conditionLabel(matchedVariant.offerCondition)", /<dt className="shrink-0 text-ink-faint">Condition<\/dt>\s*\n\s*<dd className="text-right text-ink-soft">\s*\n?\s*\{conditionLabel\(matchedVariant\.offerCondition\)\}/.test(viewer));
  ok("ui · Condition row is guarded on matchedVariant.offerCondition", /\{matchedVariant\.offerCondition && \(\s*\n\s*<div className="flex items-baseline justify-between gap-4">\s*\n\s*<dt className="shrink-0 text-ink-faint">Condition<\/dt>/.test(viewer));
  ok("ui · block guard now covers BOTH seller types", /\{matchedVariant\?\.sellerType && matchedVariant\.sellerName && \(/.test(viewer));
  ok("ui · no new condition values / vocabulary introduced", !/Brand New|Secondhand|Pre-owned|Open box/i.test(viewer));

  // Scope
  ok("scope · no schema change for this phase", !/UI-PDP-CONDITION|offerCondition/.test(read("prisma/schema.prisma")));
  ok("scope · checkout.ts untouched", !/UI-PDP-CONDITION|offerCondition/.test(read("src/lib/checkout.ts")));
  ok("scope · cart untouched", !/UI-PDP-CONDITION/.test(read("src/lib/cart.ts")));
}

const PDP_OFFER_SELECT = {
  id: true, status: true, price: true, compareAtPrice: true, createdAt: true,
  seller: { select: { type: true, status: true, displayName: true } },
  condition: true,
  inventory: { select: { quantity: true, reserved: true, reorderPoint: true } },
} as const;

type Row = {
  id: string; status: string; price: number; compareAtPrice: number | null; createdAt: Date;
  seller: { type: string; status: string; displayName: string };
  condition: string;
  inventory: { quantity: number; reserved: number; reorderPoint: number } | null;
};

/** Reproduce loadProductBySlug's per-variant winner + seller + condition lookup. */
function resolveVariant(offers: Row[]): { sellerType: string | null; sellerName: string | null; offerCondition: string | null; sameRow: boolean } {
  const cands: FullOfferCandidate[] = offers.map((o) => ({
    offerId: o.id, sellerId: "",
    sellerType: o.seller.type === "FIRST_PARTY" ? "FIRST_PARTY" : "THIRD_PARTY",
    sellerStatus: o.seller.status as FullOfferCandidate["sellerStatus"],
    offerStatus: o.status as FullOfferCandidate["offerStatus"],
    available: Math.max(0, (o.inventory?.quantity ?? 0) - (o.inventory?.reserved ?? 0)),
    reorderPoint: o.inventory?.reorderPoint ?? 0,
    price: o.price, compareAtPrice: o.compareAtPrice, createdAt: o.createdAt,
  }));
  const win = resolveWinningOfferView(cands);
  const row = win ? offers.find((o) => o.id === win.offerId) : undefined;
  return {
    sellerType: row ? (row.seller.type === "FIRST_PARTY" ? "FIRST_PARTY" : "THIRD_PARTY") : null,
    sellerName: row?.seller.displayName ?? null,
    offerCondition: row?.condition ?? null,
    sameRow: row !== undefined, // seller + condition both read off this one row
  };
}

async function dbTests() {
  console.log("\nDatabase (read-only, real catalogue)");

  const linen = await prisma.product.findFirst({
    where: { slug: "linen-blend-relaxed-shirt", status: "ACTIVE" },
    select: { variants: { where: { status: "ACTIVE" }, select: { sku: true, offers: { select: PDP_OFFER_SELECT } } } },
  });
  ok("linen · resolves", linen !== null);
  ok("linen · condition present in the SAME nested include as seller (no extra query)",
    (linen?.variants ?? []).some((v) => v.offers.some((o) => typeof o.condition === "string" && typeof o.seller.displayName === "string")));

  const medium = resolveVariant((linen?.variants.find((v) => v.sku === "LINEN-BLEND-RELAXED-SHIRT-MEDIUM")?.offers ?? []) as Row[]);
  ok("THIRD_PARTY · Style Avenue Medium → Sold by Style Avenue", medium.sellerType === "THIRD_PARTY" && medium.sellerName === "Style Avenue", JSON.stringify(medium));
  ok("THIRD_PARTY · Style Avenue Medium → Condition New (NEW → conditionLabel)", conditionLabel(medium.offerCondition ?? "") === "New", JSON.stringify(medium));
  ok("THIRD_PARTY · seller AND condition come from the same winning Offer row", medium.sameRow);

  const small = resolveVariant((linen?.variants.find((v) => v.sku === "LINEN-BLEND-RELAXED-SHIRT-SMALL")?.offers ?? []) as Row[]);
  ok("no winning offer · sellerType / sellerName / offerCondition all null (no block)", small.sellerType === null && small.sellerName === null && small.offerCondition === null, JSON.stringify(small));

  const fp = await prisma.product.findFirst({
    where: { slug: "street-low-sneaker", status: "ACTIVE" },
    select: { variants: { where: { status: "ACTIVE" }, select: { offers: { select: PDP_OFFER_SELECT } } } },
  });
  const fpResolved = (fp?.variants ?? []).map((v) => resolveVariant(v.offers as Row[])).filter((r) => r.sellerType !== null);
  ok("FIRST_PARTY · winners → Sold by Axiaro", fpResolved.length > 0 && fpResolved.every((r) => r.sellerType === "FIRST_PARTY" && r.sellerName === "Axiaro"));
  ok("FIRST_PARTY · winners → Condition New", fpResolved.every((r) => conditionLabel(r.offerCondition ?? "") === "New"), JSON.stringify(fpResolved.slice(0, 2)));

  // Every condition value in the DB maps through conditionLabel without leaking the raw enum.
  const distinct = await prisma.offer.groupBy({ by: ["condition"] });
  const known = new Set(["NEW", "REFURBISHED", "USED_LIKE_NEW", "USED_GOOD"]);
  ok("every Offer.condition in the DB is a known enum value", distinct.every((g) => known.has(g.condition)), JSON.stringify(distinct.map((g) => g.condition)));
  ok("REFURBISHED / USED_LIKE_NEW / USED_GOOD all have a customer label", ["REFURBISHED", "USED_LIKE_NEW", "USED_GOOD"].every((c) => conditionLabel(c) !== c));
}

async function main() {
  console.log("\nPHASE UI-PDP-CONDITION — PDP listing condition\n");
  pureTests();
  staticTests();
  await dbTests();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
