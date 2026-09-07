/**
 * PHASE UI-PDP-AUTO-SELECT — the PDP auto-selects the sole purchasable variant.
 *
 * Pure tests for `solePurchasableVariant`, static wiring checks on
 * `product-viewer.tsx`, and DB checks against the real catalogue (reproducing
 * the PDP DTO's per-variant winning-offer availability, like test-9db /
 * test-ui-seller-info — `getProductBySlug` is unstable_cache-wrapped).
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-pdp-auto-select.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { solePurchasableVariant, matchVariant } from "../src/lib/variant-match";
import { resolveWinningOfferView } from "../src/lib/marketplace/buy-box-rule";
import type { FullOfferCandidate } from "../src/lib/marketplace/types";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

type V = { id: string; status: string; stock: number; optionValueIds: string[] };
const v = (over: Partial<V>): V => ({ id: "v" + Math.random().toString(36).slice(2, 7), status: "ACTIVE", stock: 5, optionValueIds: [], ...over });

function pureTests() {
  console.log("\nPure — solePurchasableVariant");
  ok("exactly one ACTIVE in-stock variant → returns it", solePurchasableVariant([v({ id: "a" }), v({ id: "b", stock: 0 }), v({ id: "c", status: "ARCHIVED" })])?.id === "a");
  ok("two purchasable variants → null (shopper must choose)", solePurchasableVariant([v({ id: "a" }), v({ id: "b" })]) === null);
  ok("zero purchasable variants → null", solePurchasableVariant([v({ stock: 0 }), v({ status: "ARCHIVED" })]) === null);
  ok("out-of-stock variant is never the sole pick", solePurchasableVariant([v({ id: "a", stock: 0 })]) === null);
  ok("archived variant is never the sole pick", solePurchasableVariant([v({ id: "a", status: "ARCHIVED" })]) === null);
  ok("empty variant list → null", solePurchasableVariant([]) === null);
  ok("single-variant product (no options) that IS purchasable → returns it", solePurchasableVariant([v({ id: "only" })])?.id === "only");

  // The component maps the sole variant's optionValueIds → { [optionId]: valueId }
  // then matchVariant must resolve it.
  console.log("\nPure — auto-select seeds a selection matchVariant accepts");
  const options = [{ id: "size" }, { id: "colour" }];
  const variants = [
    v({ id: "m", optionValueIds: ["sz-m", "col-blue"] }),
    v({ id: "l", stock: 0, optionValueIds: ["sz-l", "col-blue"] }),
  ];
  const optionValues: Record<string, string> = { "sz-m": "size", "sz-l": "size", "col-blue": "colour" };
  const sole = solePurchasableVariant(variants)!;
  const seeded: Record<string, string> = {};
  for (const valueId of sole.optionValueIds) seeded[optionValues[valueId]] = valueId;
  ok("seeded selection covers every option", options.every((o) => seeded[o.id]));
  ok("matchVariant(seeded) → the sole purchasable variant", matchVariant(options, variants, seeded)?.id === "m");
}

function staticTests() {
  const viewer = read("src/components/pdp/product-viewer.tsx");
  const vm = read("src/lib/variant-match.ts");
  ok("variant-match exports solePurchasableVariant", /export function solePurchasableVariant</.test(vm));
  ok("solePurchasableVariant is ACTIVE + stock>0 and returns null on 2+", /v\.status !== "ACTIVE" \|\| v\.stock <= 0/.test(vm) && /if \(found\) return null;/.test(vm));
  ok("product-viewer imports solePurchasableVariant", /import \{ matchVariant, hasPurchasableVariant, solePurchasableVariant \} from "@\/lib\/variant-match";/.test(viewer));
  ok("auto-select runs inside the `selected` useState initializer", /const \[selected, setSelected\] = useState[\s\S]{0,800}const sole = solePurchasableVariant\(product\.variants\);\s*\n\s*if \(sole\) \{/.test(viewer));
  ok("auto-select maps optionValueIds → option ids from already-loaded data", /for \(const valueId of sole\.optionValueIds\)[\s\S]{0,160}product\.options\.find\(\(o\) => o\.values\.some\(\(val\) => val\.id === valueId\)\)/.test(viewer));
  ok("no new database call / import in the viewer for this", !/prisma|useSWR|fetch\(|loadProductBySlug/.test(viewer));
  ok("colour pre-fill still present (existing behaviour preserved)", /if \(colourOption\?\.values\[0\]\) init\[colourOption\.id\] = colourOption\.values\[0\]\.id;/.test(viewer));

  // Scope guards
  ok("scope · buy-box-rule.ts untouched", !/AUTO-SELECT|solePurchasable/.test(read("src/lib/marketplace/buy-box-rule.ts")));
  ok("scope · checkout.ts untouched", !/AUTO-SELECT|solePurchasable/.test(read("src/lib/checkout.ts")));
  ok("scope · data.ts untouched by this phase", !/solePurchasable|AUTO-SELECT/.test(read("src/lib/data.ts")));
  ok("scope · no schema change", !/solePurchasable|AUTO-SELECT/.test(read("prisma/schema.prisma")));
}

/** Reproduce the PDP DTO's per-variant winning-offer availability. */
const PDP_OFFER_SELECT = {
  id: true, status: true, price: true, compareAtPrice: true, createdAt: true,
  seller: { select: { type: true, status: true } },
  inventory: { select: { quantity: true, reserved: true, reorderPoint: true } },
} as const;

type Row = {
  id: string; status: string; price: number; compareAtPrice: number | null; createdAt: Date;
  seller: { type: string; status: string };
  inventory: { quantity: number; reserved: number; reorderPoint: number } | null;
};

function variantStock(offers: Row[]): number {
  const cands: FullOfferCandidate[] = offers.map((o) => ({
    offerId: o.id, sellerId: "",
    sellerType: o.seller.type === "FIRST_PARTY" ? "FIRST_PARTY" : "THIRD_PARTY",
    sellerStatus: o.seller.status as FullOfferCandidate["sellerStatus"],
    offerStatus: o.status as FullOfferCandidate["offerStatus"],
    available: Math.max(0, (o.inventory?.quantity ?? 0) - (o.inventory?.reserved ?? 0)),
    reorderPoint: o.inventory?.reorderPoint ?? 0,
    price: o.price, compareAtPrice: o.compareAtPrice, createdAt: o.createdAt,
  }));
  return resolveWinningOfferView(cands)?.available ?? 0;
}

async function loadVariants(slug: string) {
  const p = await prisma.product.findFirst({
    where: { slug, status: "ACTIVE" },
    select: {
      options: { select: { id: true, name: true, values: { select: { id: true } } } },
      variants: {
        where: { status: "ACTIVE" },
        select: { id: true, sku: true, status: true, offers: { select: PDP_OFFER_SELECT }, optionValues: { select: { optionValueId: true } } },
      },
    },
  });
  if (!p) return null;
  const variants = p.variants.map((vv) => ({
    id: vv.id, sku: vv.sku, status: vv.status,
    stock: variantStock(vv.offers as Row[]),
    optionValueIds: vv.optionValues.map((ov) => ov.optionValueId),
  }));
  return { options: p.options, variants };
}

async function dbTests() {
  console.log("\nDatabase (read-only, real catalogue)");

  // ── Linen Blend Relaxed Shirt: Medium is the ONLY purchasable variant ──
  const linen = await loadVariants("linen-blend-relaxed-shirt");
  ok("linen · product loads", linen !== null);
  const purchasableLinen = (linen?.variants ?? []).filter((x) => x.status === "ACTIVE" && x.stock > 0);
  ok("linen · exactly one purchasable variant", purchasableLinen.length === 1, purchasableLinen.map((x) => x.sku).join(","));
  const soleLinen = solePurchasableVariant(linen!.variants);
  ok("linen · solePurchasableVariant picks the Medium variant", (soleLinen as { sku?: string })?.sku === "LINEN-BLEND-RELAXED-SHIRT-MEDIUM", JSON.stringify(soleLinen));

  // seed a selection the way the component does, then matchVariant
  const optToValues = new Map<string, string>();
  for (const o of linen!.options) for (const val of o.values) optToValues.set(val.id, o.id);
  const seeded: Record<string, string> = {};
  for (const valueId of soleLinen!.optionValueIds) seeded[optToValues.get(valueId)!] = valueId;
  ok("linen · seeded selection covers every option", linen!.options.every((o) => seeded[o.id]));
  ok("linen · matchVariant(seeded) === the Medium variant on load", matchVariant(linen!.options, linen!.variants, seeded)?.id === soleLinen!.id);

  // ── A multi-variant FIRST_PARTY product still needs a manual choice ──
  const sneaker = await loadVariants("street-low-sneaker");
  ok("sneaker · product loads", sneaker !== null);
  const purchasableSneaker = (sneaker?.variants ?? []).filter((x) => x.status === "ACTIVE" && x.stock > 0);
  ok("sneaker · has multiple purchasable variants", purchasableSneaker.length > 1, String(purchasableSneaker.length));
  ok("sneaker · solePurchasableVariant → null (manual selection preserved)", solePurchasableVariant(sneaker!.variants) === null);

  // ── FIRST_PARTY single-variant products (no options) auto-resolve too ──
  const singles = await prisma.product.findMany({
    where: { status: "ACTIVE", options: { none: {} } },
    select: { slug: true },
    take: 3,
  });
  for (const s of singles) {
    const d = await loadVariants(s.slug);
    if (!d || d.variants.length !== 1) continue;
    const only = d.variants[0];
    const sole = solePurchasableVariant(d.variants);
    ok(`single · ${s.slug}: sole === the one variant iff it is purchasable`, (only.stock > 0) ? sole?.id === only.id : sole === null);
    ok(`single · ${s.slug}: matchVariant resolves with no options regardless`, matchVariant([], d.variants, {})?.id === only.id);
  }
}

async function main() {
  console.log("\nPHASE UI-PDP-AUTO-SELECT — sole purchasable variant\n");
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
