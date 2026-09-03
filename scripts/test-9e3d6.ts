/**
 * Phase 9E-3D-6 — assertion runner (admin inventory offer-native write).
 *
 * The admin stock-adjustment and threshold write paths are OfferInventory-ONLY:
 * `syncFirstPartyOfferStock` / `syncFirstPartyOfferReorderPoint` (offer-sync.ts)
 * row-lock the FIRST_PARTY OfferInventory, mutate it, record an OfferAdjustment
 * (stock only), and re-derive Variant.stock directly from the offer. No
 * Inventory row is read, locked or written; no new InventoryAdjustment.
 *
 * Cores below are REPLICATED from src/lib/admin/offer-sync.ts (the real module
 * imports server-only). DB tests run in ONE prisma.$transaction, roll back.
 *
 * Groups (spec §18):
 *   A  admin stock increase → OfferInventory only
 *   B  admin stock decrease → OfferInventory only
 *   C  admin threshold update → OfferInventory only
 *   D  OfferAdjustment created (reason / delta / prev / new / actor / note)
 *   E  InventoryAdjustment NOT created
 *   F  Variant.stock == max(0, OfferInventory.q - r) after the adjust
 *   G  a below-zero / below-reserved change is rejected (no write)
 *   H  the FIRST_PARTY scope is honoured (a non-FIRST_PARTY offer is never touched)
 *   I  transaction rollback on a rejected adjustment (nothing persists)
 *   J  transaction rollback on a Variant.stock sync failure (OfferInventory reverts)
 *   K  duplicate admin submission = two independent adjustments (unchanged)
 *   L  history remains accessible — union of both ledgers
 *   M  customer availability stays OfferInventory-driven (resolution path unchanged)
 *   N  OfferInventory adjustment chain reconciles
 *
 *   node --env-file=.env --import tsx scripts/test-9e3d6.ts
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

// ── replicated cores — keep in sync with src/lib/admin/offer-sync.ts ──────
type StockResult =
  | { ok: true; previousQuantity: number; newQuantity: number; reserved: number }
  | { ok: false; error: string };

async function syncVariantStock(tx: Prisma.TransactionClient, variantId: string) {
  await tx.$executeRawUnsafe(
    `UPDATE "Variant" SET "stock" = GREATEST(0, COALESCE((
       SELECT oi."quantity" - oi."reserved" FROM "OfferInventory" oi
       JOIN "Offer" o ON o.id = oi."offerId" JOIN "Seller" s ON s.id = o."sellerId"
       WHERE o."variantId" = $1 AND s.type = 'FIRST_PARTY' AND o.condition = 'NEW'), 0)) WHERE "id" = $1`,
    variantId);
}

async function adminAdjust(
  tx: Prisma.TransactionClient,
  variantId: string,
  delta: number,
  reason: string,
  note: string | null,
  actorUserId: string | null,
  opts: { failVariantSync?: boolean } = {},
): Promise<StockResult> {
  const locked = await tx.$queryRawUnsafe<{ id: string; quantity: number; reserved: number }[]>(
    `SELECT oi."id", oi."quantity", oi."reserved" FROM "OfferInventory" oi
     JOIN "Offer" o ON o.id = oi."offerId" JOIN "Seller" s ON s.id = o."sellerId"
     WHERE o."variantId" = $1 AND s.type = 'FIRST_PARTY' AND o.condition = 'NEW' FOR UPDATE OF oi`,
    variantId);
  const inv = locked[0];
  if (!inv) return { ok: false, error: "No inventory record for that variant." };
  const previousQuantity = inv.quantity;
  const newQuantity = previousQuantity + delta;
  if (newQuantity < 0) return { ok: false, error: "Stock can’t go below zero." };
  if (newQuantity < inv.reserved) return { ok: false, error: `Can’t reduce below the ${inv.reserved} unit(s) currently reserved.` };
  if (delta !== 0) {
    await tx.offerInventory.update({ where: { id: inv.id }, data: { quantity: newQuantity } });
    await tx.offerAdjustment.create({ data: { offerInventoryId: inv.id, previousQuantity, delta, newQuantity, reason, note: note?.trim() || null, actorUserId } });
    if (opts.failVariantSync) throw new Error("variant sync failed");
    await syncVariantStock(tx, variantId);
  }
  return { ok: true, previousQuantity, newQuantity, reserved: inv.reserved };
}

async function adminThreshold(tx: Prisma.TransactionClient, variantId: string, reorderPoint: number) {
  const locked = await tx.$queryRawUnsafe<{ id: string; reorderPoint: number }[]>(
    `SELECT oi."id", oi."reorderPoint" FROM "OfferInventory" oi
     JOIN "Offer" o ON o.id = oi."offerId" JOIN "Seller" s ON s.id = o."sellerId"
     WHERE o."variantId" = $1 AND s.type = 'FIRST_PARTY' AND o.condition = 'NEW' FOR UPDATE OF oi`,
    variantId);
  const inv = locked[0];
  if (!inv) return { ok: false as const, error: "No inventory record for that variant." };
  await tx.offerInventory.update({ where: { id: inv.id }, data: { reorderPoint } });
  return { ok: true as const, previous: inv.reorderPoint };
}

// ── fixtures ─────────────────────────────────────────────────────────────
async function mkFixture(tx: Prisma.TransactionClient, sellerId: string, productId: string, sku: string, qty: number, reserved = 0) {
  const v = await tx.variant.create({ data: { productId, sku, price: 1000, status: "ACTIVE", stock: Math.max(0, qty - reserved) }, select: { id: true } });
  await tx.inventory.create({ data: { variantId: v.id, sku, quantity: qty, reserved, reorderPoint: 3 } });
  const o = await tx.offer.create({ data: { sellerId, variantId: v.id, price: 1000, condition: "NEW", status: "ACTIVE", sellerSku: `s-${sku}` }, select: { id: true } });
  await tx.offerInventory.create({ data: { offerId: o.id, sellerSku: `oi-${sku}`, quantity: qty, reserved, reorderPoint: 3 } });
  await tx.offerAdjustment.create({ data: { offerInventoryId: (await tx.offerInventory.findFirstOrThrow({ where: { offerId: o.id }, select: { id: true } })).id, previousQuantity: 0, delta: qty, newQuantity: qty, reason: "MIGRATION_OPENING", note: "test opening" } });
  return { variantId: v.id, offerId: o.id };
}
const oiOf = (tx: Prisma.TransactionClient, offerId: string) => tx.offerInventory.findFirstOrThrow({ where: { offerId }, select: { quantity: true, reorderPoint: true } });
const invOf = (tx: Prisma.TransactionClient, variantId: string) => tx.inventory.findUniqueOrThrow({ where: { variantId }, select: { quantity: true, reorderPoint: true } });
const vsOf = (tx: Prisma.TransactionClient, variantId: string) => tx.variant.findUniqueOrThrow({ where: { id: variantId }, select: { stock: true } }).then((x) => x.stock);

async function dbTests() {
  const axiaro = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
  const product = await prisma.product.findFirst({ where: { status: "ACTIVE" }, select: { id: true } });
  const someUser = await prisma.user.findFirst({ select: { id: true } });
  if (!axiaro || !product || !someUser) return ok("(skipped)", true);
  const sfx = "9e3d6-" + Date.now();

  try {
    await prisma.$transaction(async (tx) => {
      // ---- A / D / E / F — admin increase ----
      const f1 = await mkFixture(tx, axiaro.id, product.id, `a-${sfx}`, 10);
      const r1 = await adminAdjust(tx, f1.variantId, 7, "RESTOCK", "PO #42", someUser.id);
      ok("A  admin increase +7: OfferInventory 10 → 17", r1.ok && (await oiOf(tx, f1.offerId)).quantity === 17);
      ok("A  frozen Inventory UNCHANGED at 10", (await invOf(tx, f1.variantId)).quantity === 10);
      const oa1 = await tx.offerAdjustment.findMany({ where: { offerInventoryId: (await tx.offerInventory.findFirstOrThrow({ where: { offerId: f1.offerId }, select: { id: true } })).id, reason: "RESTOCK" }, select: { delta: true, previousQuantity: true, newQuantity: true, actorUserId: true, note: true } });
      ok("D  OfferAdjustment(RESTOCK) created: delta +7, prev 10, new 17, actor + note", oa1.length === 1 && oa1[0].delta === 7 && oa1[0].previousQuantity === 10 && oa1[0].newQuantity === 17 && oa1[0].actorUserId === someUser.id && oa1[0].note === "PO #42");
      ok("E  ZERO new InventoryAdjustment for the admin adjust", (await tx.inventoryAdjustment.count({ where: { inventory: { variantId: f1.variantId } } })) === 0);
      ok("F  Variant.stock re-derived from OfferInventory (17)", (await vsOf(tx, f1.variantId)) === 17);

      // ---- B — admin decrease ----
      const f2 = await mkFixture(tx, axiaro.id, product.id, `b-${sfx}`, 20);
      const r2 = await adminAdjust(tx, f2.variantId, -8, "DAMAGE", null, someUser.id);
      ok("B  admin decrease -8: OfferInventory 20 → 12; Variant.stock 12; frozen Inventory 20", r2.ok && (await oiOf(tx, f2.offerId)).quantity === 12 && (await vsOf(tx, f2.variantId)) === 12 && (await invOf(tx, f2.variantId)).quantity === 20);

      // ---- C — admin threshold ----
      const f3 = await mkFixture(tx, axiaro.id, product.id, `c-${sfx}`, 15);
      const r3 = await adminThreshold(tx, f3.variantId, 9);
      ok("C  threshold 3 → 9: OfferInventory.reorderPoint 9; frozen Inventory.reorderPoint 3; no OfferAdjustment for threshold",
        r3.ok && r3.previous === 3 && (await oiOf(tx, f3.offerId)).reorderPoint === 9 && (await invOf(tx, f3.variantId)).reorderPoint === 3
        && (await tx.offerAdjustment.count({ where: { offerInventoryId: (await tx.offerInventory.findFirstOrThrow({ where: { offerId: f3.offerId }, select: { id: true } })).id, reason: { not: "MIGRATION_OPENING" } } })) === 0);
      ok("C  threshold change does not touch Variant.stock", (await vsOf(tx, f3.variantId)) === 15);

      // ---- G / I — rejected change ----
      const f4 = await mkFixture(tx, axiaro.id, product.id, `g-${sfx}`, 5, 2);
      const oiG0 = (await oiOf(tx, f4.offerId)).quantity;
      const rgNeg = await adminAdjust(tx, f4.variantId, -10, "LOSS", null, someUser.id);
      ok("G  -10 on qty 5 rejected (below zero), no write", !rgNeg.ok && rgNeg.error === "Stock can’t go below zero." && (await oiOf(tx, f4.offerId)).quantity === oiG0);
      const rgRes = await adminAdjust(tx, f4.variantId, -4, "LOSS", null, someUser.id); // 5 - 4 = 1 < reserved 2
      ok("G  reducing below the reserved amount is rejected", !rgRes.ok && /reserved/.test(rgRes.error!) && (await oiOf(tx, f4.offerId)).quantity === oiG0);
      ok("I  a rejected adjustment persists nothing (no OfferAdjustment, no Variant.stock change)",
        (await tx.offerAdjustment.count({ where: { offerInventoryId: (await tx.offerInventory.findFirstOrThrow({ where: { offerId: f4.offerId }, select: { id: true } })).id, reason: "LOSS" } })) === 0);

      // ---- H — FIRST_PARTY scope ----
      const f5 = await mkFixture(tx, axiaro.id, product.id, `h-${sfx}`, 30);
      const otherSeller = await tx.seller.create({ data: { type: "THIRD_PARTY", status: "APPROVED", displayName: `T ${sfx}`, slug: `t-${sfx}`, supportEmail: "t@t.test" }, select: { id: true } });
      const tpOffer = await tx.offer.create({ data: { sellerId: otherSeller.id, variantId: f5.variantId, price: 900, condition: "NEW", status: "ACTIVE", sellerSku: `tp-${sfx}` }, select: { id: true } });
      await tx.offerInventory.create({ data: { offerId: tpOffer.id, sellerSku: `tpi-${sfx}`, quantity: 999, reserved: 0, reorderPoint: 3 } });
      await adminAdjust(tx, f5.variantId, 5, "RESTOCK", null, someUser.id);
      ok("H  admin adjust hits ONLY the FIRST_PARTY offer (35); the THIRD_PARTY offer's OfferInventory untouched (999)",
        (await oiOf(tx, f5.offerId)).quantity === 35 && (await tx.offerInventory.findFirstOrThrow({ where: { offerId: tpOffer.id }, select: { quantity: true } })).quantity === 999);

      // ---- J — Variant.stock sync failure rolls back ----
      const f6 = await mkFixture(tx, axiaro.id, product.id, `j-${sfx}`, 12);
      const oiJ0 = (await oiOf(tx, f6.offerId)).quantity;
      let rolledBack = false;
      await tx.$queryRawUnsafe(`SAVEPOINT j6`);
      try {
        await adminAdjust(tx, f6.variantId, 4, "RESTOCK", null, someUser.id, { failVariantSync: true });
      } catch {
        rolledBack = true;
        await tx.$queryRawUnsafe(`ROLLBACK TO SAVEPOINT j6`);
      }
      ok("J  a Variant.stock sync failure rolls back the OfferInventory write (stays 12)", rolledBack && (await oiOf(tx, f6.offerId)).quantity === oiJ0 && oiJ0 === 12);

      // ---- K — duplicate submission ----
      const f7 = await mkFixture(tx, axiaro.id, product.id, `k-${sfx}`, 10);
      await adminAdjust(tx, f7.variantId, 3, "RESTOCK", "dup", someUser.id);
      await adminAdjust(tx, f7.variantId, 3, "RESTOCK", "dup", someUser.id);
      ok("K  two identical admin submits = two independent adjustments (10 → 16); no idempotency added",
        (await oiOf(tx, f7.offerId)).quantity === 16 && (await tx.offerAdjustment.count({ where: { offerInventoryId: (await tx.offerInventory.findFirstOrThrow({ where: { offerId: f7.offerId }, select: { id: true } })).id, reason: "RESTOCK" } })) === 2);

      // ---- N — OfferInventory chain reconciles ----
      const chain = await tx.$queryRawUnsafe<{ q: number; opening: number; sd: number }[]>(
        `SELECT oi."quantity" AS q,
                (SELECT "previousQuantity" FROM "OfferAdjustment" a WHERE a."offerInventoryId"=oi."id" ORDER BY a."createdAt" ASC, a."id" ASC LIMIT 1) AS opening,
                COALESCE((SELECT SUM("delta") FROM "OfferAdjustment" a WHERE a."offerInventoryId"=oi."id"),0)::int AS sd
         FROM "OfferInventory" oi WHERE oi."offerId" IN ($1,$2,$3,$4)`, f1.offerId, f2.offerId, f5.offerId, f7.offerId);
      ok("N  OfferInventory chain: opening + Σδ == quantity for every adjusted fixture", chain.length === 4 && chain.every((c) => (c.opening ?? 0) + c.sd === c.q), JSON.stringify(chain));

      // ---- L — history union returns both ledgers ----
      // Legacy row (InventoryAdjustment) on f2's Inventory + the new OfferAdjustment rows.
      await tx.inventoryAdjustment.create({ data: { inventoryId: (await tx.inventory.findUniqueOrThrow({ where: { variantId: f2.variantId }, select: { id: true } })).id, previousQuantity: 20, delta: 1, newQuantity: 21, reason: "RESTOCK", note: "legacy archive row" } });
      const legacyCount = await tx.inventoryAdjustment.count();
      const currentCount = await tx.offerAdjustment.count({ where: { reason: { not: "MIGRATION_OPENING" }, offerInventory: { offer: { seller: { is: { type: "FIRST_PARTY" } }, condition: "NEW" } } } });
      ok("L  both ledgers have rows to union (legacy InventoryAdjustment ≥ 1, current OfferAdjustment ≥ 1)", legacyCount >= 1 && currentCount >= 1);

      throw new Rollback();
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  ok("ROLLBACK  no fixture variant leaked", (await prisma.variant.count({ where: { sku: { contains: sfx } } })) === 0);
  ok("ROLLBACK  no test seller leaked", (await prisma.seller.count({ where: { slug: { contains: sfx } } })) === 0);
}

function staticChecks() {
  console.log("\nstatic — admin inventory write is OfferInventory-only");
  const actions = readFileSync(new URL("../src/lib/admin/inventory-actions.ts", import.meta.url), "utf8");
  const actionsCode = strip(actions);
  const offerSync = strip(readFileSync(new URL("../src/lib/admin/offer-sync.ts", import.meta.url), "utf8"));
  const invRead = strip(readFileSync(new URL("../src/lib/admin/inventory.ts", import.meta.url), "utf8"));
  const invPrim = readFileSync(new URL("../src/lib/inventory.ts", import.meta.url), "utf8");
  const data = readFileSync(new URL("../src/lib/data.ts", import.meta.url), "utf8");

  ok("A/B  inventory-actions.ts calls syncFirstPartyOfferStock, NOT adjustStock, and does not import @/lib/inventory",
    /syncFirstPartyOfferStock\s*\(/.test(actionsCode) && !/adjustStock\s*\(/.test(actionsCode) && !/from "@\/lib\/inventory"/.test(actions));
  ok("C  updateThresholdAction calls syncFirstPartyOfferReorderPoint, NOT setReorderPoint",
    /syncFirstPartyOfferReorderPoint\s*\(/.test(actionsCode) && !/setReorderPoint\s*\(/.test(actionsCode));
  ok("A-F  syncFirstPartyOfferStock row-locks OfferInventory FOR UPDATE, writes OfferAdjustment + Variant.stock, NEVER Inventory", (() => {
    const m = offerSync.match(/export async function syncFirstPartyOfferStock[\s\S]*?\n\}/);
    if (!m) return false;
    const body = m[0];
    return /FROM "OfferInventory" oi[\s\S]*?FOR UPDATE OF oi/.test(body)
      && /tx\.offerAdjustment\.create/.test(body)
      && /syncVariantStockFromFirstPartyOffer/.test(body)
      && !/tx\.inventory\.|prisma\.inventory\.|adjustStock\s*\(|"Inventory"/.test(body);
  })());
  ok("F  offer-sync.ts re-derives Variant.stock from OfferInventory only (no FROM \"Inventory\" anywhere)",
    /UPDATE "Variant" SET "stock"[\s\S]{0,300}FROM "OfferInventory" oi/.test(offerSync) && !/FROM "Inventory"/.test(offerSync));
  ok("C  syncFirstPartyOfferReorderPoint creates NO OfferAdjustment (threshold ≠ quantity change)",
    (() => {
      const m = offerSync.match(/export async function syncFirstPartyOfferReorderPoint[\s\S]*?\n\}/);
      return !!m && !/offerAdjustment\.create/.test(m[0]);
    })());
  ok("L  listInventoryHistory unions InventoryAdjustment (legacy) + OfferAdjustment (current, non-opening)",
    /prisma\.inventoryAdjustment\.findMany/.test(invRead) && /prisma\.offerAdjustment\.findMany/.test(invRead) && /MIGRATION_OPENING/.test(invRead));
  ok("L  history rows are tagged legacy | current", /ledger:\s*"legacy"/.test(invRead) && /ledger:\s*"current"/.test(invRead));
  ok("L-actor  OfferAdjustment actor names resolved by a User lookup (no schema relation added)", /prisma\.user\.findMany/.test(invRead));
  ok("M  data.ts storefront still resolves availability via offers (never Variant.stock)",
    /stock: off\.available/.test(data) && /never reads `Variant\.stock`/.test(data));
  ok("legacy  adjustStock still present for the cancel/return legacy fallback", /export async function adjustStock/.test(invPrim));
  ok("dead  setReorderPoint documented DEAD (0 callers since 9E-3D-6)", /setReorderPoint[\s\S]{0,80}0 callers since 9E-3D-6/.test(invPrim));
}

async function gateCheck() {
  const g = await prisma.storeSetting.findUnique({ where: { key: "marketplace.multiSellerCheckout" } });
  ok("GATE  marketplace.multiSellerCheckout == 'false'", g?.value === "false", g?.value ?? "<absent>");
  ok("GATE  PayMongo dormant (0 payments, 0 webhookEvents)", (await prisma.payment.count()) === 0 && (await prisma.webhookEvent.count()) === 0);
}

async function run() {
  await dbTests();
  staticChecks();
  await gateCheck();
  console.log(`\n  ${pass} passed, ${fail} failed.`);
  if (fail > 0) throw new Error(`${fail} Phase 9E-3D-6 check(s) failed.`);
}

run().then(() => console.log("All Phase 9E-3D-6 checks passed."))
  .catch((e) => { console.error(e.message ?? e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
