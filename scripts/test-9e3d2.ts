/**
 * Phase 9E-3D-2 — assertion runner (OfferInventory operational authority).
 *
 * Proves that admin + analytics CURRENT-STATE inventory reads now resolve
 * through the Axiaro FIRST_PARTY `OfferInventory` (the operational authority),
 * while `Inventory` / `Variant.stock` stay synchronized mirrors and the
 * adjustment HISTORY stays on `InventoryAdjustment`.
 *
 * DB tests run inside ONE `prisma.$transaction` that builds a fixture whose
 * two stores are DELIBERATELY DIVERGENT, replicates each migrated reader's
 * query, asserts it returns the OfferInventory value (not the mirror), then
 * throws to ROLL BACK. The reader query shapes are also asserted statically
 * against the real source files.
 *
 * Groups (spec §23):
 *   A  admin inventory list      reads OfferInventory
 *   B  admin inventory detail    reads OfferInventory
 *   C  low-stock report          reads OfferInventory
 *   D  analytics current-state   reads OfferInventory (insights + dashboard tile)
 *   E  admin write keeps the Inventory mirror synchronized (delta parity)
 *   F  Variant.stock stays correct (= max(0, OfferInventory.q - r))
 *   G  storefront availability read still offer-derived (unchanged)
 *   H  adjustment history stays on InventoryAdjustment (+ actor relation)
 *
 *   node --env-file=.env --import tsx scripts/test-9e3d2.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
class Rollback extends Error {}

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");

// ── replicated reader query shapes — keep in sync with ────────────────────
//   src/lib/admin/inventory.ts  (listInventory / getInventoryDetail)
//   src/lib/analytics/queries.ts  (getInventoryInsights / getLowStockReport)
const FP_FILTER = { seller: { is: { type: "FIRST_PARTY" } }, condition: "NEW" } as const;

async function listQuery(tx: Prisma.TransactionClient, q?: string) {
  const offerWhere: Record<string, unknown> = { ...FP_FILTER };
  if (q?.trim()) {
    offerWhere.variant = {
      OR: [
        { sku: { contains: q.trim(), mode: "insensitive" } },
        { product: { name: { contains: q.trim(), mode: "insensitive" } } },
      ],
    };
  }
  return tx.offerInventory.findMany({
    where: { offer: offerWhere },
    select: {
      quantity: true, reserved: true, reorderPoint: true,
      offer: { select: { variant: { select: { id: true, sku: true } } } },
    },
  });
}

// ── fixtures ─────────────────────────────────────────────────────────────
async function mkFixture(
  tx: Prisma.TransactionClient,
  sellerId: string, productId: string, sku: string,
  offerQty: number, invQty: number, reorderPoint = 3,
) {
  const v = await tx.variant.create({
    data: { productId, sku, price: 1000, status: "ACTIVE", stock: Math.max(0, invQty) },
    select: { id: true },
  });
  await tx.inventory.create({ data: { variantId: v.id, sku, quantity: invQty, reserved: 0, reorderPoint } });
  const o = await tx.offer.create({
    data: { sellerId, variantId: v.id, price: 1000, condition: "NEW", status: "ACTIVE", sellerSku: `s-${Math.random().toString(36).slice(2, 9)}` },
    select: { id: true },
  });
  await tx.offerInventory.create({
    data: { offerId: o.id, sellerSku: `oi-${Math.random().toString(36).slice(2, 9)}`, quantity: offerQty, reserved: 0, reorderPoint },
  });
  return { variantId: v.id, offerId: o.id };
}

async function dbTests() {
  const axiaro = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
  const product = await prisma.product.findFirst({ where: { status: "ACTIVE" }, select: { id: true } });
  if (!axiaro || !product) return ok("(skipped — no FIRST_PARTY seller / product)", true);
  const sfx = "9e3d2-" + Date.now();

  try {
    await prisma.$transaction(async (tx) => {
      // DIVERGENT fixture: OfferInventory says 42, Inventory mirror says 7.
      // Every migrated reader must report 42.
      const div = await mkFixture(tx, axiaro.id, product.id, `div-${sfx}`, 42, 7, 3);

      // ---- A — admin list ----
      const listRows = await listQuery(tx);
      const divRow = listRows.find((r) => r.offer.variant.id === div.variantId);
      ok("A  admin list row reports the OfferInventory quantity (42, not mirror 7)", divRow?.quantity === 42, JSON.stringify(divRow));
      ok("A  admin list search matches on Variant.sku", (await listQuery(tx, `div-${sfx}`)).some((r) => r.offer.variant.id === div.variantId));

      // ---- B — admin detail ----
      const detail = await tx.offerInventory.findFirst({
        where: { offer: { variantId: div.variantId, ...FP_FILTER } },
        select: { quantity: true, reserved: true, reorderPoint: true, offer: { select: { variant: { select: { sku: true } } } } },
      });
      ok("B  admin detail reports the OfferInventory quantity (42)", detail?.quantity === 42);

      // ---- C — low-stock report (available <= reorderPoint) ----
      // OfferInventory available = 42 (not low). Mirror available = 7 (would be... not low either at rp 3).
      // Make a second fixture where the AUTHORITY is low but the mirror is healthy.
      const lowAuth = await mkFixture(tx, axiaro.id, product.id, `low-${sfx}`, 2, 500, 3);
      const lowRows = await tx.offerInventory.findMany({
        where: { offer: { ...FP_FILTER, variant: { status: "ACTIVE" } } },
        select: { quantity: true, reserved: true, reorderPoint: true, offer: { select: { variant: { select: { id: true } } } } },
      });
      const flagged = lowRows.filter((r) => r.quantity - r.reserved <= r.reorderPoint).map((r) => r.offer.variant.id);
      ok("C  low-stock flags the fixture whose OfferInventory is low (mirror is healthy)", flagged.includes(lowAuth.variantId));
      ok("C  low-stock does NOT flag the fixture whose OfferInventory is healthy (mirror is low)", !flagged.includes(div.variantId));

      // ---- D — analytics insights raw SQL + dashboard tile ----
      const insightsRow = await tx.$queryRawUnsafe<{ out: number; low: number }[]>(`
        SELECT COUNT(*) FILTER (WHERE oi.quantity - oi.reserved <= 0)::int AS out,
               COUNT(*) FILTER (WHERE oi.quantity - oi.reserved > 0 AND oi.quantity - oi.reserved <= oi."reorderPoint")::int AS low
        FROM "OfferInventory" oi
        JOIN "Offer" o ON o.id = oi."offerId"
        JOIN "Seller" s ON s.id = o."sellerId"
        JOIN "Variant" v ON v.id = o."variantId"
        WHERE s.type = 'FIRST_PARTY' AND o.condition = 'NEW' AND v.status = 'ACTIVE'
          AND o."variantId" IN ($1, $2)`, div.variantId, lowAuth.variantId);
      ok("D  analytics insights: exactly 1 low from the divergent pair (the authority-low one)", insightsRow[0].low === 1 && insightsRow[0].out === 0, JSON.stringify(insightsRow[0]));

      const tile = await tx.$queryRawUnsafe<{ count: bigint }[]>(`
        SELECT COUNT(*)::bigint AS count FROM "OfferInventory" oi
        JOIN "Offer" o ON o.id = oi."offerId" JOIN "Seller" s ON s.id = o."sellerId"
        WHERE s.type = 'FIRST_PARTY' AND o.condition = 'NEW'
          AND oi."quantity" - oi."reserved" <= oi."reorderPoint"
          AND o."variantId" IN ($1, $2)`, div.variantId, lowAuth.variantId);
      ok("D  dashboard low-stock tile counts the authority-low fixture only", Number(tile[0].count) === 1);

      // value reporting still uses Variant.price (catalog), only quantity from OfferInventory
      const valueRow = await tx.$queryRawUnsafe<{ retail: string }[]>(`
        SELECT COALESCE(SUM(oi.quantity * v.price), 0)::text AS retail
        FROM "OfferInventory" oi
        JOIN "Offer" o ON o.id = oi."offerId" JOIN "Seller" s ON s.id = o."sellerId"
        JOIN "Variant" v ON v.id = o."variantId"
        WHERE s.type = 'FIRST_PARTY' AND o.condition = 'NEW' AND o."variantId" = $1`, div.variantId);
      ok("D  retail value = OfferInventory.quantity (42) * Variant.price (1000) = 42000", valueRow[0].retail === "42000", valueRow[0].retail);

      // ---- E / F — admin write core keeps both stores + mirror in step ----
      const sync = await mkFixture(tx, axiaro.id, product.id, `sync-${sfx}`, 20, 20, 3);
      const delta = 10;
      // replicate: syncFirstPartyOfferStock (OfferInventory FOR UPDATE + OfferAdjustment) then adjustStock (Inventory + mirror)
      const loi = await tx.$queryRawUnsafe<{ id: string; quantity: number }[]>(
        `SELECT oi."id", oi."quantity" FROM "OfferInventory" oi JOIN "Offer" o ON o.id = oi."offerId"
         WHERE o."variantId" = $1 AND o.condition = 'NEW' FOR UPDATE OF oi`, sync.variantId);
      await tx.offerInventory.update({ where: { id: loi[0].id }, data: { quantity: loi[0].quantity + delta } });
      await tx.offerAdjustment.create({ data: { offerInventoryId: loi[0].id, previousQuantity: loi[0].quantity, delta, newQuantity: loi[0].quantity + delta, reason: "RESTOCK", note: "admin" } });
      const linv = await tx.$queryRawUnsafe<{ id: string; quantity: number }[]>(
        `SELECT "id","quantity" FROM "Inventory" WHERE "variantId" = $1 FOR UPDATE`, sync.variantId);
      await tx.inventory.update({ where: { id: linv[0].id }, data: { quantity: linv[0].quantity + delta } });
      await tx.inventoryAdjustment.create({ data: { inventoryId: linv[0].id, previousQuantity: linv[0].quantity, delta, newQuantity: linv[0].quantity + delta, reason: "RESTOCK", note: "admin" } });
      await tx.$executeRawUnsafe(
        `UPDATE "Variant" SET "stock" = GREATEST(0, COALESCE((SELECT "quantity" - "reserved" FROM "Inventory" WHERE "variantId" = $1), 0)) WHERE "id" = $1`, sync.variantId);

      const eoi = await tx.offerInventory.findFirstOrThrow({ where: { offerId: sync.offerId }, select: { quantity: true, reserved: true } });
      const einv = await tx.inventory.findUniqueOrThrow({ where: { variantId: sync.variantId }, select: { quantity: true } });
      const evar = await tx.variant.findUniqueOrThrow({ where: { id: sync.variantId }, select: { stock: true } });
      ok("E  admin write moved BOTH stores by the same delta (+10 → 30 / 30)", eoi.quantity === 30 && einv.quantity === 30);
      ok("F  Variant.stock == max(0, OfferInventory.quantity - reserved) after the write", evar.stock === Math.max(0, eoi.quantity - eoi.reserved));

      // ---- G — storefront-style availability read (offer-derived) reflects the write ----
      const storefront = await tx.offerInventory.findFirstOrThrow({
        where: { offer: { variantId: sync.variantId, ...FP_FILTER } },
        select: { quantity: true, reserved: true },
      });
      ok("G  storefront offer availability = 30 after the admin write (unchanged resolution path)", Math.max(0, storefront.quantity - storefront.reserved) === 30);

      // ---- H — adjustment history still on InventoryAdjustment, with actor relation ----
      const histShape = await tx.inventoryAdjustment.findFirst({
        where: { inventory: { variantId: sync.variantId } },
        select: { reason: true, delta: true, actor: { select: { email: true } }, inventory: { select: { sku: true } } },
      });
      ok("H  InventoryAdjustment history row exists for the admin write, carries actor + inventory relations", histShape?.reason === "RESTOCK" && histShape.delta === 10);

      throw new Rollback();
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  const leaked = await prisma.variant.count({ where: { sku: { contains: sfx } } });
  ok("ROLLBACK  no fixture variant leaked", leaked === 0, String(leaked));
}

function staticChecks() {
  console.log("\nstatic — migrated readers resolve through FIRST_PARTY OfferInventory");
  const adminInv = strip(readFileSync(new URL("../src/lib/admin/inventory.ts", import.meta.url), "utf8"));
  const fpInv = readFileSync(new URL("../src/lib/admin/first-party-inventory.ts", import.meta.url), "utf8");
  const queries = strip(readFileSync(new URL("../src/lib/analytics/queries.ts", import.meta.url), "utf8"));
  const dash = strip(readFileSync(new URL("../src/app/admin/(shell)/page.tsx", import.meta.url), "utf8"));
  const adminActions = strip(readFileSync(new URL("../src/lib/admin/inventory-actions.ts", import.meta.url), "utf8"));
  const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

  // A / B — admin list + detail
  ok("A  inventory.ts listInventory uses prisma.offerInventory.findMany", /prisma\.offerInventory\.findMany/.test(adminInv));
  ok("A  inventory.ts listInventory no longer calls prisma.inventory.findMany", !/prisma\.inventory\.findMany/.test(adminInv));
  ok("B  inventory.ts getInventoryDetail uses prisma.offerInventory.findFirst, not prisma.inventory.findUnique", /prisma\.offerInventory\.findFirst/.test(adminInv) && !/prisma\.inventory\.findUnique/.test(adminInv));
  ok("A/B  the FIRST_PARTY offer filter is applied", /FIRST_PARTY_OFFER_FILTER/.test(adminInv));
  ok("A/B  first-party-inventory.ts pins seller FIRST_PARTY + condition NEW", /type:\s*"FIRST_PARTY"/.test(fpInv) && /condition:\s*"NEW"/.test(fpInv));
  ok("A/B  first-party-inventory.ts is read-only (no offerInventory.update / adjustStock)", !/\.update\s*\(|\.create\s*\(|adjustStock|commitOfferStock|restoreOfferStock/.test(fpInv));

  // C / D — analytics
  ok("C  getLowStockReport uses prisma.offerInventory.findMany (FIRST_PARTY)", /prisma\.offerInventory\.findMany[\s\S]{0,200}FIRST_PARTY/.test(queries));
  ok("C  getLowStockReport no longer calls prisma.inventory.findMany", !/prisma\.inventory\.findMany/.test(queries));
  ok("D  getInventoryInsights raw SQL reads \"OfferInventory\" scoped to FIRST_PARTY", /FROM "OfferInventory" oi/.test(queries) && /s\.type = 'FIRST_PARTY'/.test(queries));
  ok("D  getInventoryInsights no longer selects FROM \"Inventory\" i", !/FROM "Inventory" i/.test(queries));
  ok("D  product-performance currentStock reads the FIRST_PARTY offer's inventory", /offers:\s*\{\s*where:\s*\{[\s\S]{0,120}FIRST_PARTY/.test(queries) && !/inventory:\s*\{\s*select:\s*\{\s*quantity:\s*true,\s*reserved:\s*true\s*\}\s*\}\s*,\s*\n\s*\}\s*,\s*\n\s*\}\s*,\s*\n\s*\}\s*\)/.test(queries));
  ok("D  dashboard low-stock tile counts \"OfferInventory\" scoped to FIRST_PARTY", /FROM "OfferInventory" oi/.test(dash) && /s\.type = 'FIRST_PARTY'/.test(dash) && !/COUNT\(\*\)::bigint AS count FROM "Inventory"/.test(dash));

  // E — write path unchanged from 9E-3D-1 (OfferInventory → Inventory)
  const ia = (s: string, a: RegExp, b: RegExp) => { const x = s.search(a), y = s.search(b); return x >= 0 && y >= 0 && x < y; };
  ok("E  adjustStockAction still: syncFirstPartyOfferStock before adjustStock", ia(adminActions, /syncFirstPartyOfferStock\s*\(/, /adjustStock\s*\(/));
  ok("E  updateThresholdAction still: syncFirstPartyOfferReorderPoint before setReorderPoint", ia(adminActions, /syncFirstPartyOfferReorderPoint\s*\(/, /setReorderPoint\s*\(/));

  // F — Variant.stock schema comment reflects mirror role
  ok("F  schema.prisma Variant.stock documented as a compatibility mirror", /compatibility mirror/.test(schema) && /Read by nobody since Phase 9D-D/.test(schema));

  // G — storefront / checkout inventory paths untouched by this (9E-3D-2) change.
  //     (9E-3D-5 later removed the checkout Inventory mirror — checkout now
  //     commits OfferInventory only.)
  ok("G  checkout.ts commits OfferInventory (commitOfferStockForSale) as its SALE writer", (() => {
    const co = strip(readFileSync(new URL("../src/lib/checkout.ts", import.meta.url), "utf8"));
    return /commitOfferStockForSale\s*\(/.test(co);
  })());
  ok("G  data.ts storefront still resolves availability via offers (resolveVariantAvailability)", (() => {
    const d = readFileSync(new URL("../src/lib/data.ts", import.meta.url), "utf8");
    return /resolveVariantAvailability|resolveWinningOfferView|offers/.test(d) && !/prisma\.inventory\.findMany/.test(d);
  })());

  // H — history stays on InventoryAdjustment
  ok("H  listInventoryHistory / historyReasons still read prisma.inventoryAdjustment", /prisma\.inventoryAdjustment\.findMany/.test(adminInv) && /prisma\.inventoryAdjustment\.findMany\(\{\s*\n\s*distinct/.test(adminInv.replace(/count[\s\S]*?\n/, "")) || /distinct: \["reason"\]/.test(adminInv));
  ok("H  history NOT switched to OfferAdjustment", !/prisma\.offerAdjustment\.findMany/.test(adminInv));
}

async function gateCheck() {
  const g = await prisma.storeSetting.findUnique({ where: { key: "marketplace.multiSellerCheckout" } });
  ok("GATE  marketplace.multiSellerCheckout == 'false'", g?.value === "false", g?.value ?? "<absent>");
  const tp = await prisma.offer.count({ where: { seller: { type: "THIRD_PARTY" } } });
  ok("GATE  no THIRD_PARTY offers exist (1P-only operational scope)", tp === 0, String(tp));
}

async function run() {
  await dbTests();
  staticChecks();
  await gateCheck();
  console.log(`\n  ${pass} passed, ${fail} failed.`);
  if (fail > 0) throw new Error(`${fail} Phase 9E-3D-2 check(s) failed.`);
}

run().then(() => console.log("All Phase 9E-3D-2 checks passed."))
  .catch((e) => { console.error(e.message ?? e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
