/**
 * PHASE 9F-23b — 1P offer DISCOVERY / SYNC de-NEWing.
 *
 * The 1P offer discovery + synchronization layer no longer hardcodes
 * `condition = "NEW"`. It identifies the ONE Axiaro FIRST_PARTY offer for a
 * variant by the seller alone, and fails safely (never silently picks an
 * arbitrary offer) if that invariant is broken.
 *
 * Scope of source change:
 *   src/lib/admin/offer-sync.ts
 *     - ensureFirstPartyOffer          findFirst({ sellerId, variantId }); opts.condition?? "NEW" on create only
 *     - syncFirstPartyOfferPrice       updateMany where { variantId, sellerId }
 *     - lockFirstPartyOfferInventory   NEW helper — FOR UPDATE ... LIMIT 2, assert-one, fail-safe on 0 / >1
 *     - syncFirstPartyOfferStock       uses lockFirstPartyOfferInventory
 *     - syncFirstPartyOfferReorderPoint uses lockFirstPartyOfferInventory
 *     - syncVariantStockFromFirstPartyOffer  subquery keyed on s.type = 'FIRST_PARTY'
 *   src/lib/admin/first-party-inventory.ts
 *     - FIRST_PARTY_OFFER_FILTER       { seller: { is: { type: "FIRST_PARTY" } } }  (no condition)
 *
 * ZERO functional change on current production data: all 1P offers are NEW and
 * there is exactly one FIRST_PARTY offer per variant.
 *
 * DB tests build fixtures inside ONE prisma.$transaction and roll back. No
 * production offer / order / inventory / condition is created or changed.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f23b.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient, Prisma } from "@prisma/client";
import {
  ensureFirstPartyOffer,
  syncFirstPartyOfferPrice,
  syncFirstPartyOfferStock,
  syncFirstPartyOfferReorderPoint,
  syncVariantStockFromFirstPartyOffer,
} from "@/lib/admin/offer-sync";
import { FIRST_PARTY_OFFER_FILTER, getFirstPartyStock } from "@/lib/admin/first-party-inventory";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");

class Rollback extends Error {}

// ── fixture ──────────────────────────────────────────────────────────────
async function mkVariant(tx: Prisma.TransactionClient, productId: string, sku: string, qty = 10, reserved = 0) {
  const v = await tx.variant.create({
    data: { productId, sku, price: 1000, status: "ACTIVE", stock: Math.max(0, qty - reserved) },
    select: { id: true },
  });
  await tx.inventory.create({ data: { variantId: v.id, sku, quantity: qty, reserved, reorderPoint: 3 } });
  return v.id;
}
async function mkOffer(
  tx: Prisma.TransactionClient,
  sellerId: string,
  variantId: string,
  sku: string,
  condition = "NEW",
  qty = 10,
  reserved = 0,
) {
  const o = await tx.offer.create({
    data: { sellerId, variantId, price: 1000, condition, status: "ACTIVE", sellerSku: sku },
    select: { id: true },
  });
  await tx.offerInventory.create({
    data: { offerId: o.id, sellerSku: `oi-${sku}`, quantity: qty, reserved, reorderPoint: 3 },
  });
  return o.id;
}

// ── static wiring ────────────────────────────────────────────────────────
function staticTests() {
  console.log("\n── static wiring ──");
  const sync = read("src/lib/admin/offer-sync.ts");
  const syncCode = strip(sync);
  const fpInv = read("src/lib/admin/first-party-inventory.ts");
  const fpInvCode = strip(fpInv);

  const noNewInCode = (src: string) =>
    !/condition\s*=\s*'NEW'/.test(src) && !/condition:\s*"NEW"(?!\s*\/)/.test(src.replace(/opts\.condition \?\? "NEW"/g, ""));

  // 1 — ensureFirstPartyOffer: discovery by (sellerId, variantId)
  ok("offer-sync · ensureFirstPartyOffer discovers by findFirst({ sellerId, variantId })",
    /const existing = await tx\.offer\.findFirst\(\{\s*\n?\s*where: \{ sellerId, variantId: variant\.id \},/.test(sync));
  ok("offer-sync · ensureFirstPartyOffer no longer keys on sellerId_variantId_condition",
    !/sellerId_variantId_condition/.test(sync));
  // 2 — optional condition param, default NEW, applied on CREATE only
  ok("offer-sync · opts carries optional condition?: string", /opts: \{ productStatus: string; costPrice: number \| null; condition\?: string \}/.test(sync));
  ok("offer-sync · fresh create uses opts.condition ?? \"NEW\"", /condition: opts\.condition \?\? "NEW",/.test(sync));
  ok("offer-sync · create is guarded by `if \\(!offerId\\)` (never a 2nd 1P offer)",
    /if \(!offerId\) \{\s*\n\s*const created = await tx\.offer\.create/.test(sync));

  // 3 — sync fns key on the FIRST_PARTY seller, not condition
  ok("offer-sync · syncFirstPartyOfferPrice updateMany where { variantId, sellerId }",
    /where: \{ variantId, sellerId \},/.test(sync));
  ok("offer-sync · lockFirstPartyOfferInventory FOR UPDATE keyed on s.\"type\" = 'FIRST_PARTY', LIMIT 2",
    /WHERE o\."variantId" = \$\{variantId\} AND s\."type" = 'FIRST_PARTY'\s*\n\s*FOR UPDATE OF oi\s*\n\s*LIMIT 2/.test(sync));
  ok("offer-sync · lock helper fails safe on zero (ok:false, no throw)",
    /if \(locked\.length === 0\) return \{ ok: false, error: "No inventory record for that variant\." \};/.test(sync));
  ok("offer-sync · lock helper fails safe on multiple (ok:false, no throw)",
    /if \(locked\.length > 1\) \{\s*\n\s*return \{\s*\n\s*ok: false,/.test(sync));
  ok("offer-sync · syncFirstPartyOfferStock delegates to lockFirstPartyOfferInventory",
    /export async function syncFirstPartyOfferStock[\s\S]*?const locked = await lockFirstPartyOfferInventory\(variantId, tx\);/.test(sync));
  ok("offer-sync · syncFirstPartyOfferReorderPoint delegates to lockFirstPartyOfferInventory",
    /export async function syncFirstPartyOfferReorderPoint[\s\S]*?const locked = await lockFirstPartyOfferInventory\(variantId, tx\);/.test(sync));
  ok("offer-sync · syncVariantStockFromFirstPartyOffer subquery = s.\"type\" = 'FIRST_PARTY' only",
    /WHERE o\."variantId" = \$\{variantId\} AND s\."type" = 'FIRST_PARTY'\s*\n\s*\), 0\)\)/.test(sync));
  ok("offer-sync · no `condition = 'NEW'` / hardcoded `condition: \"NEW\"` filter left in executable code",
    noNewInCode(syncCode));

  // 10 — FIRST_PARTY_OFFER_FILTER
  ok("first-party-inventory · FILTER keeps seller FIRST_PARTY", /seller: \{ is: \{ type: "FIRST_PARTY" \} \},/.test(fpInv));
  ok("first-party-inventory · FILTER drops condition: \"NEW\"",
    /FIRST_PARTY_OFFER_FILTER = \{\s*\n\s*seller: \{ is: \{ type: "FIRST_PARTY" \} \},\s*\n\s*\} satisfies/.test(fpInv) && !/condition:\s*"NEW"/.test(fpInvCode));

  // invariant / scope guards
  ok("schema · @@unique([sellerId, variantId, condition]) unchanged",
    /@@unique\(\[sellerId, variantId, condition\]\)/.test(read("prisma/schema.prisma")) && !/9F-23b/.test(read("prisma/schema.prisma")));
  ok("scope · no CMS/admin condition selector added (product-variants.tsx)",
    !/9F-23b/.test(read("src/components/admin/catalog/product-variants.tsx")) && !/conditionLabel|name="condition"/.test(read("src/components/admin/catalog/product-variants.tsx")));
  ok("scope · updateVariant / catalog-actions not given a 1P condition control",
    !/9F-23b/.test(read("src/lib/admin/variants.ts")) && !/setFirstPartyOfferCondition/.test(read("src/lib/admin/catalog-actions.ts")));
  ok("scope · checkout / OrderItem snapshot untouched", !/9F-23b/.test(read("src/lib/checkout.ts")));
  ok("scope · buy-box / seller 3P repo untouched",
    !/9F-23b/.test(read("src/lib/marketplace/buy-box-rule.ts")) && !/9F-23b/.test(read("src/lib/marketplace/seller-repository.ts")));
  ok("scope · marketplace/offer-inventory.ts (checkout/cancel/return) untouched", !/9F-23b/.test(read("src/lib/marketplace/offer-inventory.ts")));
  ok("scope · email / settlement / order-status untouched",
    !/9F-23b/.test(read("src/lib/email/notifications.ts")) && !/9F-23b/.test(read("src/lib/marketplace/settlement.ts")) && !/9F-23b/.test(read("src/lib/orders/status.ts")));
  ok("scope · analytics / dashboard not re-touched beyond 9F-23a",
    !/9F-23b/.test(read("src/lib/analytics/queries.ts")) && !/9F-23b/.test(read("src/app/admin/(shell)/page.tsx")));
  ok("scope · seed-rbac.ts untouched", !/9F-23b/.test(read("scripts/seed-rbac.ts")));
}

// ── behaviour (rolled-back fixtures) ─────────────────────────────────────
async function dbTests() {
  console.log("\n── behaviour (fixtures rolled back) ──");
  const axiaro = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
  const product = await prisma.product.findFirst({ where: { status: "ACTIVE" }, select: { id: true } });
  if (!axiaro || !product) return ok("(skipped — no FIRST_PARTY seller / product)", true);
  const sfx = "9f23b-" + Date.now();

  try {
    await prisma.$transaction(async (tx) => {
      // 1 / 2 — an existing NEW 1P offer is still discovered; discovery does not require NEW
      {
        const v = await mkVariant(tx, product.id, `d-new-${sfx}`);
        const offerId = await mkOffer(tx, axiaro.id, v, `new-${sfx}`, "NEW");
        await ensureFirstPartyOffer(
          { id: v, sku: `d-new-${sfx}`, price: 1000, compareAtPrice: null },
          { productStatus: "ACTIVE", costPrice: null },
          tx,
        );
        const offers = await tx.offer.findMany({ where: { sellerId: axiaro.id, variantId: v }, select: { id: true } });
        ok("1 · existing NEW 1P offer still discovered — ensureFirstPartyOffer is a no-op (1 offer, same id)",
          offers.length === 1 && offers[0].id === offerId);
      }
      {
        const v = await mkVariant(tx, product.id, `d-ref-${sfx}`);
        const refId = await mkOffer(tx, axiaro.id, v, `ref-${sfx}`, "REFURBISHED");
        await ensureFirstPartyOffer(
          { id: v, sku: `d-ref-${sfx}`, price: 1000, compareAtPrice: null },
          { productStatus: "ACTIVE", costPrice: null },
          tx,
        );
        const offers = await tx.offer.findMany({ where: { sellerId: axiaro.id, variantId: v }, select: { id: true, condition: true } });
        ok("2 · discovery no longer requires condition=NEW — non-NEW 1P offer found, NOT duplicated, condition preserved",
          offers.length === 1 && offers[0].id === refId && offers[0].condition === "REFURBISHED");
      }

      // 3 / 5 — single-FIRST_PARTY-offer invariant enforced; multiple fails safe
      {
        const v = await mkVariant(tx, product.id, `d-multi-${sfx}`);
        await mkOffer(tx, axiaro.id, v, `m-new-${sfx}`, "NEW", 10);
        await mkOffer(tx, axiaro.id, v, `m-ref-${sfx}`, "REFURBISHED", 4);
        const s = await syncFirstPartyOfferStock(v, 5, "RESTOCK", null, null, tx);
        ok("5 · >1 FIRST_PARTY offer for a variant → syncFirstPartyOfferStock fails safe (ok:false, no write, no throw)",
          !s.ok && /more than one Axiaro listing/.test(s.error));
        const r = await syncFirstPartyOfferReorderPoint(v, 9, tx);
        ok("5 · >1 FIRST_PARTY offer → syncFirstPartyOfferReorderPoint fails safe (ok:false)",
          !r.ok && "error" in r && /more than one Axiaro listing/.test(r.error));
        const untouched = await tx.offerInventory.findMany({ where: { offer: { variantId: v } }, select: { quantity: true, reorderPoint: true } });
        ok("3 · neither OfferInventory row was mutated by the failed calls",
          untouched.every((o) => (o.quantity === 10 || o.quantity === 4) && o.reorderPoint === 3));
      }

      // 4 — zero-offer case fails safe
      {
        const v = await mkVariant(tx, product.id, `d-zero-${sfx}`);
        const s = await syncFirstPartyOfferStock(v, 3, "RESTOCK", null, null, tx);
        ok("4 · no FIRST_PARTY offer for the variant → syncFirstPartyOfferStock ok:false 'No inventory record'",
          !s.ok && s.error === "No inventory record for that variant.");
        const r = await syncFirstPartyOfferReorderPoint(v, 7, tx);
        ok("4 · no FIRST_PARTY offer → syncFirstPartyOfferReorderPoint ok:false",
          !r.ok && "error" in r && r.error === "No inventory record for that variant.");
      }

      // 6 — price sync targets the one 1P offer (any condition)
      {
        const v = await mkVariant(tx, product.id, `d-price-${sfx}`);
        await mkOffer(tx, axiaro.id, v, `p-ref-${sfx}`, "REFURBISHED");
        await syncFirstPartyOfferPrice(v, { price: 1234, compareAtPrice: 1999 }, tx);
        const o = await tx.offer.findFirstOrThrow({ where: { sellerId: axiaro.id, variantId: v }, select: { price: true, compareAtPrice: true, condition: true } });
        ok("6 · price sync hit the single 1P offer regardless of condition (1234 / 1999, still REFURBISHED)",
          o.price === 1234 && o.compareAtPrice === 1999 && o.condition === "REFURBISHED");
      }

      // 7 / 9 — stock sync targets the right OfferInventory + Variant.stock mirror
      {
        const v = await mkVariant(tx, product.id, `d-stock-${sfx}`, 20, 2);
        const offerId = await mkOffer(tx, axiaro.id, v, `s-new-${sfx}`, "NEW", 20, 2);
        const s = await syncFirstPartyOfferStock(v, 5, "RESTOCK", null, null, tx);
        const oi = await tx.offerInventory.findFirstOrThrow({ where: { offerId }, select: { quantity: true, reserved: true } });
        const vs = await tx.variant.findUniqueOrThrow({ where: { id: v }, select: { stock: true } });
        ok("7 · stock sync moved the FIRST_PARTY OfferInventory (+5 → 25)", s.ok && oi.quantity === 25);
        ok("9 · Variant.stock mirror re-derived from OfferInventory (max(0, 25 - 2) = 23)", vs.stock === 23);
        // 8 — reorder-point sync
        const r = await syncFirstPartyOfferReorderPoint(v, 8, tx);
        const oi2 = await tx.offerInventory.findFirstOrThrow({ where: { offerId }, select: { reorderPoint: true } });
        ok("8 · reorder-point sync hit the right OfferInventory (3 → 8), previous reported", r.ok && "previous" in r && r.previous === 3 && oi2.reorderPoint === 8);
        // 9 — direct mirror call is condition-independent too
        await tx.offerInventory.update({ where: { offerId }, data: { quantity: 30 } });
        await syncVariantStockFromFirstPartyOffer(v, tx);
        const vs2 = await tx.variant.findUniqueOrThrow({ where: { id: v }, select: { stock: true } });
        ok("9 · syncVariantStockFromFirstPartyOffer re-derives (30 - 2 = 28)", vs2.stock === 28);
      }

      // 10 — FIRST_PARTY_OFFER_FILTER resolves the one 1P offer (non-NEW included)
      {
        const v = await mkVariant(tx, product.id, `d-filter-${sfx}`);
        await mkOffer(tx, axiaro.id, v, `f-ref-${sfx}`, "REFURBISHED", 7);
        const viaFilter = await tx.offerInventory.findMany({
          where: { offer: { variantId: v, ...FIRST_PARTY_OFFER_FILTER } },
          select: { quantity: true },
        });
        ok("10 · FIRST_PARTY_OFFER_FILTER returns the one 1P OfferInventory even when condition != NEW",
          viaFilter.length === 1 && viaFilter[0].quantity === 7);
        const stock = await getFirstPartyStock(v, tx);
        ok("10 · getFirstPartyStock resolves the non-NEW 1P offer (qty 7)", stock?.quantity === 7);
      }

      // 11 — a THIRD_PARTY offer on the same variant is never selected
      {
        const v = await mkVariant(tx, product.id, `d-3p-${sfx}`, 30);
        const fpOfferId = await mkOffer(tx, axiaro.id, v, `tp-fp-${sfx}`, "NEW", 30);
        const tp = await tx.seller.create({
          data: { type: "THIRD_PARTY", status: "APPROVED", displayName: `TP ${sfx}`, slug: `tp-${sfx}`, supportEmail: "tp@t.test" },
          select: { id: true },
        });
        const tpOfferId = await mkOffer(tx, tp.id, v, `tp-3p-${sfx}`, "NEW", 999);
        const s = await syncFirstPartyOfferStock(v, 5, "RESTOCK", null, null, tx);
        const fpOi = await tx.offerInventory.findFirstOrThrow({ where: { offerId: fpOfferId }, select: { quantity: true } });
        const tpOi = await tx.offerInventory.findFirstOrThrow({ where: { offerId: tpOfferId }, select: { quantity: true } });
        ok("11 · stock sync moved ONLY the FIRST_PARTY OfferInventory (35); THIRD_PARTY untouched (999)",
          s.ok && fpOi.quantity === 35 && tpOi.quantity === 999);
        await syncFirstPartyOfferPrice(v, { price: 4321, compareAtPrice: null }, tx);
        const tpOffer = await tx.offer.findFirstOrThrow({ where: { id: tpOfferId }, select: { price: true } });
        const fpOffer = await tx.offer.findFirstOrThrow({ where: { id: fpOfferId }, select: { price: true } });
        ok("11 · price sync moved ONLY the FIRST_PARTY offer (4321); THIRD_PARTY price untouched (1000)",
          fpOffer.price === 4321 && tpOffer.price === 1000);
      }

      throw new Rollback();
    }, { timeout: 90000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("ROLLBACK · no fixture variant leaked", (await prisma.variant.count({ where: { sku: { contains: sfx } } })) === 0);
  ok("ROLLBACK · no fixture seller leaked", (await prisma.seller.count({ where: { slug: { contains: sfx } } })) === 0);
}

// ── 12 — production results unchanged (READ-ONLY) ────────────────────────
async function prodTests() {
  console.log("\n── production (READ-ONLY) ──");
  const axiaro = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
  if (!axiaro) return ok("(skipped — no FIRST_PARTY seller)", true);

  // discovery row-set: OLD (condition='NEW') vs NEW (seller-only)
  const oldSet = await prisma.offer.findMany({ where: { sellerId: axiaro.id, condition: "NEW" }, select: { id: true } });
  const newSet = await prisma.offer.findMany({ where: { sellerId: axiaro.id }, select: { id: true } });
  ok("12 · 1P discovery row-set identical (OLD condition='NEW' == NEW seller-only)",
    oldSet.length === newSet.length && new Set([...oldSet, ...newSet].map((o) => o.id)).size === oldSet.length,
    `old ${oldSet.length} / new ${newSet.length}`);

  const multi = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT COUNT(*)::int AS n FROM (SELECT o."variantId" FROM "Offer" o JOIN "Seller" s ON s.id=o."sellerId" WHERE s.type='FIRST_PARTY' GROUP BY o."variantId" HAVING COUNT(*)>1) d`,
  );
  ok("12 · production has exactly one FIRST_PARTY offer per variant", multi[0].n === 0, `${multi[0].n} with >1`);

  const fpByCond = await prisma.offer.groupBy({ by: ["condition"], where: { seller: { is: { type: "FIRST_PARTY" } } }, _count: true });
  ok("12 · every FIRST_PARTY offer is still condition NEW", fpByCond.every((g) => g.condition === "NEW"), JSON.stringify(fpByCond));

  const sa = await prisma.offer.findFirst({ where: { seller: { is: { displayName: "Style Avenue" } } }, select: { condition: true, status: true } });
  ok("12 · Style Avenue 3P offer untouched (NEW / ACTIVE)", sa?.condition === "NEW" && sa?.status === "ACTIVE", JSON.stringify(sa));

  ok("12 · Inventory 332 / OfferInventory 333 / Variant 332 (unchanged)",
    (await prisma.inventory.count()) === 332 && (await prisma.offerInventory.count()) === 333 && (await prisma.variant.count()) === 332);
}

async function main() {
  console.log("\nPHASE 9F-23b — 1P offer discovery / sync de-NEWing\n");
  staticTests();
  await dbTests();
  await prodTests();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
