/**
 * PHASE UI-SELLER-INFO / UI-SELLER-INFO-2 — PDP marketplace seller-information
 * block for THIRD_PARTY winning offers (Sold by / Payment / Customer service).
 *
 * Read-only. Calls the real cached PDP resolver against committed data (the
 * live 9F-9 pilot: Style Avenue's Linen Blend Relaxed Shirt Medium is ACTIVE)
 * plus a FIRST_PARTY control product, and static-checks that no extra query or
 * offer-resolver dependency was introduced.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-ui-seller-info.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
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

function staticTests() {
  const data = read("src/lib/data.ts");
  const types = read("src/lib/types.ts");
  const viewer = read("src/components/pdp/product-viewer.tsx");

  // Data layer
  ok("data · offer seller select now includes displayName", /seller: \{ select: \{ type: true, status: true, displayName: true \} \}/.test(data));
  ok("data · VariantView DTO gains sellerType + sellerName", /sellerType: "FIRST_PARTY" \| "THIRD_PARTY" \| null;\s*\n\s*sellerName: string \| null;/.test(types));
  ok("data · winner resolved from the SAME already-loaded offers array (offers.find on win.offerId)", /const winnerRow = win \? offers\.find\(\(o\) => o\.id === win\.offerId\) : undefined;/.test(data));
  ok("data · variant DTO carries off.sellerType / off.sellerName through", /sellerType: off\.sellerType,\s*\n\s*sellerName: off\.sellerName,/.test(data));

  // NO extra query / NO offer-resolver dependency introduced in loadProductBySlug
  const loadFn = data.slice(data.indexOf("async function loadProductBySlug"), data.indexOf("export const getProductBySlug"));
  const prismaCalls = (loadFn.match(/\bprisma\.\w+\.(findFirst|findUnique|findMany|count|aggregate|groupBy)\(/g) ?? []);
  ok("data · loadProductBySlug still makes exactly ONE database call", prismaCalls.length === 1, prismaCalls.join(" | "));
  ok("data · no import of offer-resolver / getWinningOffer added", !/offer-resolver|getWinningOffer/.test(data));
  ok("data · resolveWinningOfferView is unchanged (still the only resolver used, no new signature)", /const win = resolveWinningOfferView\(offers\.map\(fullCandidate\)\);/.test(data));

  // UI (UI-SELLER-INFO-2 + UI-PDP-CONDITION: block renders for BOTH seller types)
  ok("ui · seller block renders for any winning offer (not THIRD_PARTY-only)", /\{matchedVariant\?\.sellerType && matchedVariant\.sellerName && \(\s*\n\s*<dl /.test(viewer) && !/sellerType === "THIRD_PARTY" && matchedVariant\.sellerName && \(\s*\n\s*<dl/.test(viewer));
  ok("ui · block carries 'Sold by' → sellerName", /<dt className="shrink-0 text-ink-faint">Sold by<\/dt>\s*\n\s*<dd className="text-right font-medium text-ink">\{matchedVariant\.sellerName\}<\/dd>/.test(viewer));
  ok("ui · block carries 'Payment' → Secure checkout", /<dt className="shrink-0 text-ink-faint">Payment<\/dt>\s*\n\s*<dd className="text-right text-ink-soft">Secure checkout<\/dd>/.test(viewer));
  ok("ui · 'Customer service' → seller for THIRD_PARTY, SITE.name for FIRST_PARTY", /Customer service<\/dt>[\s\S]{0,160}matchedVariant\.sellerType === "THIRD_PARTY"\s*\n?\s*\? \(matchedVariant\.sellerName \?\? SITE\.name\)\s*\n?\s*: SITE\.name/.test(viewer));
  ok("ui · placed directly under the price block, above the short description", viewer.indexOf('size="lg"') < viewer.indexOf(">Sold by</dt>") && viewer.indexOf(">Sold by</dt>") < viewer.indexOf("{product.shortDescription}"));
  ok("ui · plain text — no <Link>/<a> in the seller block", !/>Sold by<\/dt>[\s\S]{0,600}<(Link|a )/.test(viewer));
  ok("ui · no rating/badge/logo/location/response/sales stats invented in the block", !/>Sold by<\/dt>[\s\S]{0,600}(rating|badge|logo|location|reviews|response rate|positive feedback|items sold|since \d)/i.test(viewer));
  ok("ui · SITE constant imported (no magic 'Axiaro' string literal in the block)", /import \{ SITE \} from "@\/lib\/constants";/.test(viewer) && !/>Axiaro</.test(viewer));

  // Scope guards
  ok("scope · cart unchanged (still its own Sold-by, not touched here)", !/UI-SELLER-INFO/.test(read("src/components/cart/cart-drawer.tsx")) && !/UI-SELLER-INFO/.test(read("src/lib/cart.ts")));
  ok("scope · buy-box-rule.ts / WinningOfferView untouched", !/UI-SELLER-INFO/.test(read("src/lib/marketplace/buy-box-rule.ts")) && !/sellerName/.test(read("src/lib/marketplace/types.ts").slice(read("src/lib/marketplace/types.ts").indexOf("type WinningOfferView"), read("src/lib/marketplace/types.ts").indexOf("type WinningOfferView") + 300)));
  ok("scope · no schema change", !/UI-SELLER-INFO/.test(read("prisma/schema.prisma")));
  ok("scope · checkout.ts untouched", !/UI-SELLER-INFO/.test(read("src/lib/checkout.ts")));
}

/**
 * `getProductBySlug` is `unstable_cache`-wrapped and `loadProductBySlug` is not
 * exported — so, like `scripts/test-9db.ts`, this reproduces the resolver's
 * exact per-variant winning-offer logic (INCLUDING the new
 * `offers.find(o => o.id === win.offerId)` seller lookup) against the same
 * one-query nested include, and asserts on that.
 */
const PDP_OFFER_SELECT = {
  id: true, status: true, price: true, compareAtPrice: true, createdAt: true,
  seller: { select: { type: true, status: true, displayName: true } },
  inventory: { select: { quantity: true, reserved: true, reorderPoint: true } },
} as const;

type PdpOffer = {
  id: string; status: string; price: number; compareAtPrice: number | null; createdAt: Date;
  seller: { type: string; status: string; displayName: string };
  inventory: { quantity: number; reserved: number; reorderPoint: number } | null;
};

function resolveVariantSeller(offers: PdpOffer[]): { sellerType: string | null; sellerName: string | null; price: number | null } {
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
  const winnerRow = win ? offers.find((o) => o.id === win.offerId) : undefined;
  return {
    sellerType: winnerRow ? (winnerRow.seller.type === "FIRST_PARTY" ? "FIRST_PARTY" : "THIRD_PARTY") : null,
    sellerName: winnerRow?.seller.displayName ?? null,
    price: win?.price ?? null,
  };
}

async function dbTests() {
  // ── ONE query, nested include (the shape loadProductBySlug uses) ─────────
  const sa = await prisma.product.findFirst({
    where: { slug: "linen-blend-relaxed-shirt", status: "ACTIVE" },
    select: { name: true, variants: { where: { status: "ACTIVE" }, select: { sku: true, offers: { select: PDP_OFFER_SELECT } } } },
  });
  ok("1 · Style Avenue product is ACTIVE and resolvable in one query", sa !== null && sa.name === "Linen Blend Relaxed Shirt");
  ok("4 · seller displayName IS present inside that same nested include (no extra query)", (sa?.variants ?? []).some((v) => v.offers.some((o) => typeof o.seller.displayName === "string" && o.seller.displayName.length > 0)));

  const mediumOffers = sa?.variants.find((v) => v.sku === "LINEN-BLEND-RELAXED-SHIRT-MEDIUM")?.offers ?? [];
  const mediumR = resolveVariantSeller(mediumOffers as PdpOffer[]);
  ok("1 · Medium winning offer sellerType === THIRD_PARTY", mediumR.sellerType === "THIRD_PARTY", JSON.stringify(mediumR));
  ok("1 · Medium winning offer sellerName === 'Style Avenue' → PDP shows \"Sold by Style Avenue\"", mediumR.sellerName === "Style Avenue");
  ok("1 · winner really is the THIRD_PARTY offer (₱1,199 flows through)", mediumR.price === 119900);

  const smallOffers = sa?.variants.find((v) => v.sku === "LINEN-BLEND-RELAXED-SHIRT-SMALL")?.offers ?? [];
  const smallR = resolveVariantSeller(smallOffers as PdpOffer[]);
  ok("2 · a size with no eligible offer → sellerType/sellerName null (no line rendered)", smallR.sellerType === null && smallR.sellerName === null && smallR.price === null, JSON.stringify(smallR));

  // ── FIRST_PARTY — data carried, and the block now renders too ───────────
  const fp = await prisma.product.findFirst({
    where: { slug: "street-low-sneaker", status: "ACTIVE" },
    select: { variants: { where: { status: "ACTIVE" }, select: { sku: true, offers: { select: PDP_OFFER_SELECT } } } },
  });
  ok("3 · a FIRST_PARTY product resolves", fp !== null);
  const fpResolved = (fp?.variants ?? []).map((v) => resolveVariantSeller(v.offers as PdpOffer[])).filter((r) => r.price != null);
  ok("3 · every winning FIRST_PARTY variant → sellerType FIRST_PARTY", fpResolved.length > 0 && fpResolved.every((r) => r.sellerType === "FIRST_PARTY"), JSON.stringify(fpResolved));
  ok("3 · sellerName 'Axiaro' is carried → PDP block shows 'Sold by Axiaro'", fpResolved.every((r) => r.sellerName === "Axiaro"));
}

async function main() {
  console.log("\nPHASE UI-SELLER-INFO — PDP seller attribution\n");
  console.log("Static wiring");
  staticTests();
  console.log("\nDatabase (read-only, real committed / live-pilot data)");
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
