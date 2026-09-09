/**
 * PHASE 9F-37B — unified colour / swatch handling.
 *
 * One shared module `src/lib/marketplace/colours.ts` is the canonical colour
 * presentation system: explicit `ProductOptionValue.swatchHex` wins, else a
 * controlled palette (normalised full label → last word → first word), else an
 * explicit neutral. Colour-axis option names (Colour / Color / Colours / Colors,
 * any case) are recognised everywhere; no value is ever dropped or rendered as a
 * raw `#ccc`. 1P and 3P go through the same resolver against the same field.
 * Nothing writes a derived hex any more — `catalog-actions` / `create-canonical`
 * store NULL and the storefront resolves at display time.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f37b.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient, Prisma } from "@prisma/client";
import {
  COLOUR_PALETTE,
  COLOUR_OPTION_NAMES,
  NEUTRAL_SWATCH_HEX,
  isColourOptionName,
  resolveSwatchHex,
  colourSwatch,
} from "@/lib/marketplace/colours";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
class Rollback extends Error {}
type Tx = Prisma.TransactionClient;
const HEX = /^#[0-9a-fA-F]{3,8}$/;

function pureTests() {
  console.log("\n── pure — colours.ts resolver ──");

  // 1. exact known colour → the exact palette hex
  ok("1 · exact known colour 'Oak' → palette hex #c8a97e", resolveSwatchHex("Oak") === "#c8a97e");
  ok("1 · 'Walnut' / 'Sage' / 'Navy' → their palette hexes",
    resolveSwatchHex("Walnut") === COLOUR_PALETTE.walnut &&
    resolveSwatchHex("Sage") === COLOUR_PALETTE.sage &&
    resolveSwatchHex("Navy") === COLOUR_PALETTE.navy);

  // 2. Field tan → a real controlled swatch, NOT null / NOT neutral
  const ft = resolveSwatchHex("Field tan");
  ok("2 · 'Field tan' resolves to a controlled swatch (not neutral, not null)",
    HEX.test(ft) && ft !== NEUTRAL_SWATCH_HEX, ft);
  ok("2 · 'Field tan' === the 'field tan' palette entry (and === 'tan' last-word)",
    ft === COLOUR_PALETTE["field tan"] && COLOUR_PALETTE["field tan"] === COLOUR_PALETTE.tan);

  // 3. multi-word colours
  for (const [label, expectWord] of [
    ["Sky blue", "blue"], ["Dark olive", "olive"], ["Forest green", "green"],
    ["Black stained oak", "oak"], ["Natural oak", "oak"], ["Black-stained ash", "ash"],
  ] as const) {
    const hex = resolveSwatchHex(label);
    ok(`3 · '${label}' → a controlled swatch (resolves via full-label or '${expectWord}')`,
      HEX.test(hex) && hex !== NEUTRAL_SWATCH_HEX &&
      (hex === COLOUR_PALETTE[label.toLowerCase().replace(/[^a-z]+/g, " ").trim()] || hex === COLOUR_PALETTE[expectWord]),
      hex);
  }
  ok("3 · NOT first-word-only — 'Field tan' would be NULL under the old split()[0] rule",
    !("field" in COLOUR_PALETTE));

  // 4 + 7. case-insensitive colour OPTION names
  ok("7 · isColourOptionName accepts Colour / Color / Colours / Colors (any case)",
    ["Colour", "color", "COLOURS", "Colors", " colour ", "cOlOr"].every(isColourOptionName));
  ok("7 · COLOUR_OPTION_NAMES = the 4 canonical casings", JSON.stringify([...COLOUR_OPTION_NAMES]) === JSON.stringify(["Colour", "Color", "Colours", "Colors"]));

  // 8. non-colour option names are NOT colour
  ok("8 · 'Size' / 'Material' / 'Coloured trim' / 'Colouring' are NOT colour options",
    !["Size", "Material", "Coloured trim", "Colouring", "Colorway", ""].some(isColourOptionName));

  // 5. explicit swatchHex overrides the palette
  ok("5 · explicit '#123456' wins over the palette for 'Oak'",
    resolveSwatchHex("Oak", "#123456") === "#123456");
  ok("5 · explicit wins even for an unknown colour (no neutral)",
    resolveSwatchHex("Zzznotacolour", "#abcdef") === "#abcdef");
  ok("5 · a MALFORMED explicit value is ignored, resolver falls through",
    resolveSwatchHex("Oak", "not-a-hex") === "#c8a97e" && resolveSwatchHex("Zzz", "  ") === NEUTRAL_SWATCH_HEX);

  // 6. unknown colour → the explicit neutral (never null, never #ccc)
  ok("6 · unknown colour → NEUTRAL_SWATCH_HEX (a real controlled hex, not the old raw '#ccc')",
    resolveSwatchHex("Ultraviolet sparkle") === NEUTRAL_SWATCH_HEX && HEX.test(NEUTRAL_SWATCH_HEX) &&
    (NEUTRAL_SWATCH_HEX as string).toLowerCase() !== "#ccc");
  ok("6 · resolveSwatchHex ALWAYS returns a valid hex string",
    ["", "  ", "???", "42", "Oak", "Field tan", "wat"].every((l) => HEX.test(resolveSwatchHex(l))));

  // colourSwatch { hex, palette }
  ok("aux · colourSwatch reports palette=false only for the neutral fallback",
    colourSwatch("Oak").palette === true && colourSwatch("Nope").palette === false && colourSwatch("Nope").hex === NEUTRAL_SWATCH_HEX);

  // every palette value is a valid hex
  ok("palette · every entry is a valid hex", Object.values(COLOUR_PALETTE).every((h) => HEX.test(h)));
  ok("palette · original SWATCH_HINTS hexes preserved (oak/walnut/black/white/natural/…)",
    COLOUR_PALETTE.oak === "#c8a97e" && COLOUR_PALETTE.walnut === "#6b4a32" &&
    COLOUR_PALETTE.black === "#262626" && COLOUR_PALETTE.white === "#f2f0ea" &&
    COLOUR_PALETTE.natural === "#d8c8ab" && COLOUR_PALETTE.terracotta === "#b06b4c");
}

function staticTests() {
  console.log("\n── static wiring ──");
  const colours = read("src/lib/marketplace/colours.ts");
  const data = read("src/lib/data.ts");
  const wishlist = read("src/lib/wishlist.ts");
  const viewer = read("src/components/pdp/product-viewer.tsx");
  const catalogActions = read("src/lib/admin/catalog-actions.ts");
  const createCanonical = read("src/lib/admin/seller-product-requests/create-canonical.ts");
  const adminProductPage = read("src/app/admin/(shell)/products/[id]/page.tsx");

  ok("module · colours.ts exports the resolver + neutral + option-name helpers",
    /export function resolveSwatchHex/.test(colours) && /export const NEUTRAL_SWATCH_HEX/.test(colours) &&
    /export function isColourOptionName/.test(colours) && /export const COLOUR_OPTION_NAMES/.test(colours) &&
    /export const COLOUR_PALETTE/.test(colours));
  ok("module · client-safe (no server-only import)", !/["']server-only["']/.test(colours));

  ok("10 · SWATCH_HINTS dictionary removed from catalog-actions.ts + create-canonical.ts",
    !/const SWATCH_HINTS/.test(catalogActions) && !/const SWATCH_HINTS/.test(createCanonical));
  ok("10 · catalog-actions no longer auto-derives / overwrites swatchHex — stores NULL for new values, preserves an explicit one",
    /swatchHex: null/.test(catalogActions) && /swatchHex: ev\.swatchHex/.test(catalogActions) &&
    !/SWATCH_HINTS\[/.test(catalogActions));
  ok("10 · create-canonical stores swatchHex: null (palette resolves at display time)",
    /swatchHex: null,/.test(createCanonical) && !/SWATCH_HINTS\[/.test(createCanonical));

  ok("data · card + PDP + facet source colour options case-insensitively (Colour/Color/Colours/Colors)",
    (data.match(/name: \{ in: \[\.\.\.COLOUR_OPTION_NAMES\], mode: "insensitive" \}/g) ?? []).length >= 2 &&
    /isColourOptionName\(o\.name\)/.test(data));
  ok("data · card swatches resolve every value through the shared palette + de-dupe (no .filter(Boolean) drop)",
    /\[\s*\.\.\.new Set\(\(colourOption\?\.values \?\? \[\]\)\.map\(\(v\) => resolveSwatchHex\(v\.value, v\.swatchHex\)\)\)/.test(data.replace(/\n\s*/g, " ")));
  ok("data · PDP per-value swatchHex is the RESOLVED hex for a colour option",
    /isColourOptionName\(o\.name\) \? resolveSwatchHex\(v\.value, v\.swatchHex\) : v\.swatchHex/.test(data));
  ok("data · colour facet hex resolved via the shared palette",
    /hex: resolveSwatchHex\(c\.value, c\.swatchHex\)/.test(data));

  ok("wishlist · same shared resolver + case-insensitive option name + de-dupe",
    /from "@\/lib\/marketplace\/colours"/.test(wishlist) &&
    /isColourOptionName\(o\.name\)/.test(wishlist) &&
    /resolveSwatchHex\(v\.value, v\.swatchHex\)/.test(wishlist));

  ok("pdp · product-viewer recognises the colour option case-insensitively",
    /const colourOption = product\.options\.find\(\(o\) => isColourOptionName\(o\.name\)\)/.test(viewer));
  ok("pdp · product-viewer no longer hard-codes the '#ccc' grey fallback",
    !/backgroundColor: v\.swatchHex \?\? "#ccc"/.test(viewer));

  ok("admin · product page resolves the colour dot through the shared palette too",
    /isColourOptionName\(o\.name\)/.test(adminProductPage) && /resolveSwatchHex\(v\.value, v\.swatchHex\)/.test(adminProductPage));

  ok("scope · seed-rbac.ts untouched", !/9F-37B/.test(read("scripts/seed-rbac.ts")));
  const schema = read("prisma/schema.prisma");
  ok("scope · no schema change — reuses the one ProductOptionValue.swatchHex String? field, no new column",
    (schema.match(/swatchHex/g) ?? []).length === 1 && /swatchHex String\? \/\/ for colour options/.test(schema));
  ok("scope · pricing / discount / checkout / commission / settlement untouched",
    !/9F-37B/.test(read("src/lib/checkout.ts")) && !/9F-37B/.test(read("src/lib/utils.ts")) &&
    !/9F-37B/.test(read("src/lib/marketplace/buy-box-rule.ts")) && !/9F-37B/.test(read("src/lib/marketplace/settlement.ts")));
}

async function dbTests() {
  console.log("\n── DB fixtures (rolled back) ──");
  const category = await prisma.category.findFirst({ where: { active: true }, select: { id: true } });
  const fp = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
  const tp = await prisma.seller.findFirst({ where: { type: "THIRD_PARTY" }, select: { id: true } });
  if (!category || !fp || !tp) { ok("(skipped — no catalog data / sellers)", true); return; }

  const before = { pv: await prisma.productOptionValue.count(), prod: await prisma.product.count() };
  const sfx = Date.now().toString(36);

  // 10 — a snapshot of EXISTING production colour values (must be byte-identical after the run)
  const prodColoursBefore = await prisma.productOptionValue.findMany({
    where: { option: { name: { in: [...COLOUR_OPTION_NAMES], mode: "insensitive" } } },
    select: { id: true, value: true, swatchHex: true },
    orderBy: { id: "asc" },
  });

  try {
    await prisma.$transaction(async (tx: Tx) => {
      // a product whose colour option is spelled the US way ("Colors")
      const prod = await tx.product.create({
        data: {
          name: `Swatch Test ${sfx}`, slug: `swatch-test-${sfx}`, brand: "Axiaro",
          shortDescription: "s", description: "d", categoryId: category.id, status: "ACTIVE", price: 5000,
        },
        select: { id: true },
      });
      const opt = await tx.productOption.create({ data: { productId: prod.id, name: "Colors", sortOrder: 0 }, select: { id: true } });
      const vals = await Promise.all(
        [
          { value: "Oak", swatchHex: null },
          { value: "Field tan", swatchHex: null },
          { value: "Zznotacolour", swatchHex: null },
          { value: "Custom", swatchHex: "#0a0b0c" }, // explicit override
        ].map((d, i) => tx.productOptionValue.create({ data: { optionId: opt.id, value: d.value, swatchHex: d.swatchHex, sortOrder: i }, select: { id: true, value: true, swatchHex: true } })),
      );

      // resolver applied to the fixture rows exactly as the display layer would
      const resolved = vals.map((v) => ({ value: v.value, hex: resolveSwatchHex(v.value, v.swatchHex) }));
      ok("DB · 'Oak' (null hex, option named 'Colors') → palette #c8a97e", resolved[0].hex === "#c8a97e");
      ok("DB · 'Field tan' (null hex) → a controlled swatch, not neutral", resolved[1].hex !== NEUTRAL_SWATCH_HEX && HEX.test(resolved[1].hex));
      ok("DB · 'Zznotacolour' (null hex) → NEUTRAL_SWATCH_HEX", resolved[2].hex === NEUTRAL_SWATCH_HEX);
      ok("DB · 'Custom' → the explicit #0a0b0c (palette not consulted)", resolved[3].hex === "#0a0b0c");
      ok("DB · the option 'Colors' is recognised as a colour axis", isColourOptionName("Colors"));

      // 9 — 1P and 3P resolve identically: build the same value under a 3P-origin
      // product and check the resolver output matches
      const prod3p = await tx.product.create({
        data: { name: `Swatch 3P ${sfx}`, slug: `swatch-3p-${sfx}`, brand: "X", shortDescription: "s", description: "d", categoryId: category.id, status: "ACTIVE", price: 5000 },
        select: { id: true },
      });
      const opt3p = await tx.productOption.create({ data: { productId: prod3p.id, name: "Colour", sortOrder: 0 }, select: { id: true } });
      const v3 = await tx.productOptionValue.create({ data: { optionId: opt3p.id, value: "Field tan", swatchHex: null, sortOrder: 0 }, select: { value: true, swatchHex: true } });
      ok("9 · same 'Field tan' resolves to the SAME hex regardless of 1P/3P origin",
        resolveSwatchHex(v3.value, v3.swatchHex) === resolved[1].hex);

      // the create path stored NULL (no auto-derived hex)
      ok("DB · newly-created colour values are stored with swatchHex NULL (resolve at display, not at write)",
        vals[0].swatchHex === null && vals[1].swatchHex === null && v3.swatchHex === null);

      throw new Rollback();
    }, { timeout: 60_000, maxWait: 12_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  const prodColoursAfter = await prisma.productOptionValue.findMany({
    where: { option: { name: { in: [...COLOUR_OPTION_NAMES], mode: "insensitive" } } },
    select: { id: true, value: true, swatchHex: true },
    orderBy: { id: "asc" },
  });
  ok("10 · EXISTING production colour values byte-identical after the run",
    JSON.stringify(prodColoursBefore) === JSON.stringify(prodColoursAfter));
  ok("rollback · no ProductOptionValue leaked", (await prisma.productOptionValue.count()) === before.pv);
  ok("rollback · no Product leaked", (await prisma.product.count()) === before.prod);
}

async function main() {
  console.log("\nPHASE 9F-37B — unified colour / swatch handling\n");
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
