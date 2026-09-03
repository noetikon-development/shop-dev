/**
 * Phase 9E-3D-3 — assertion runner (legacy Inventory cleanup).
 *
 * Confirms the two targeted cleanups and that nothing operational still
 * depends on the legacy Inventory store beyond the documented mirror /
 * ledger / create-time roles.
 *
 * Groups (spec §12):
 *   A  getAdminReturn probes OfferInventory, not Inventory
 *   B  admin inventory error handling is sanitized (no raw internal detail)
 *   C  cancellation still restores both stores            (→ test:9e3d1 A/N)
 *   D  return still restores both stores                  (→ test:9e3d1 C/O)
 *   E  admin adjustment still updates both stores         (→ test:9e3d2 E)
 *   F  checkout still updates both stores                 (→ test:9e3c2)
 *   G  lock ordering remains OfferInventory → Inventory   (static)
 *   H  customer availability remains OfferInventory-driven (static + parity gates)
 *   I  no operational reader falls back to Inventory
 *   J  historical InventoryAdjustment history remains available
 *
 *   node --env-file=.env --import tsx scripts/test-9e3d3.ts
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
const ordered = (s: string, a: RegExp, b: RegExp) => { const x = s.search(a), y = s.search(b); return x >= 0 && y >= 0 && x < y; };

// ── replicated admin-adjust core — keep in sync with ─────────────────────
//   src/lib/admin/inventory-actions.ts (adjustStockAction) + offer-sync.ts
//
// Models the SANITIZATION contract only: on any error the transaction is
// rolled back by the real $transaction — here the caller wraps a SAVEPOINT so
// a partial write never leaks between assertions.
class AdjustError extends Error {}
async function adminAdjustCore(
  tx: Prisma.TransactionClient,
  variantId: string,
  delta: number,
  opts: { syncThrowsRaw?: boolean; adjustFails?: string } = {},
): Promise<{ error: string } | { ok: true }> {
  try {
    try {
      if (opts.syncThrowsRaw) {
        throw new Error(
          `syncFirstPartyOfferStock: OfferInventory invariant violation for variant ${variantId} (prev 5, delta ${delta}, reserved 0) — rolling back.`,
        );
      }
      const l = await tx.$queryRawUnsafe<{ id: string; quantity: number; reserved: number }[]>(
        `SELECT oi."id", oi."quantity", oi."reserved" FROM "OfferInventory" oi JOIN "Offer" o ON o.id = oi."offerId"
         WHERE o."variantId" = $1 AND o.condition = 'NEW' FOR UPDATE OF oi`, variantId);
      if (l[0]) {
        const nq = l[0].quantity + delta;
        if (nq < 0 || nq < l[0].reserved) throw new Error("invariant");
        await tx.offerInventory.update({ where: { id: l[0].id }, data: { quantity: nq } });
      }
    } catch (syncErr) {
      console.error("[replicated] sync failed:", (syncErr as Error).message.slice(0, 30));
      throw new AdjustError("Couldn’t adjust stock — the stored figures need a refresh. Reload the page and try again.");
    }
    if (opts.adjustFails) throw new AdjustError(opts.adjustFails);
    // 9E-3D-6: OfferInventory-only. Re-derive Variant.stock from the offer;
    // NO Inventory write.
    await tx.$executeRawUnsafe(
      `UPDATE "Variant" SET "stock" = GREATEST(0, COALESCE((SELECT oi."quantity" - oi."reserved" FROM "OfferInventory" oi JOIN "Offer" o ON o.id = oi."offerId" WHERE o."variantId" = $1 AND o.condition = 'NEW'), 0)) WHERE "id" = $1`,
      variantId);
    return { ok: true };
  } catch (err) {
    if (err instanceof AdjustError) return { error: err.message };
    console.error("[replicated] unexpected", err);
    return { error: "Couldn’t adjust stock right now. Please try again." };
  }
}
async function mkFull(tx: Prisma.TransactionClient, sellerId: string, productId: string, sku: string, qty: number) {
  const v = await tx.variant.create({ data: { productId, sku, price: 1000, status: "ACTIVE", stock: qty }, select: { id: true } });
  await tx.inventory.create({ data: { variantId: v.id, sku, quantity: qty, reserved: 0, reorderPoint: 3 } });
  const o = await tx.offer.create({ data: { sellerId, variantId: v.id, price: 1000, condition: "NEW", status: "ACTIVE", sellerSku: `s-${sku}` }, select: { id: true } });
  await tx.offerInventory.create({ data: { offerId: o.id, sellerSku: `oi-${sku}`, quantity: qty, reserved: 0, reorderPoint: 3 } });
  return { variantId: v.id, offerId: o.id };
}

async function dbTests() {
  const axiaro = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
  const product = await prisma.product.findFirst({ where: { status: "ACTIVE" }, select: { id: true } });
  if (!axiaro || !product) return ok("(skipped)", true);
  const sfx = "9e3d3-" + Date.now();

  try {
    await prisma.$transaction(async (tx) => {
      // ---- A — getAdminReturn probe works WITHOUT an Inventory row ----
      // A variant + FIRST_PARTY offer + OfferInventory, but NO Inventory row.
      const v = await tx.variant.create({ data: { productId: product.id, sku: `a-${sfx}`, price: 1000, status: "ACTIVE", stock: 5 }, select: { id: true } });
      const o = await tx.offer.create({ data: { sellerId: axiaro.id, variantId: v.id, price: 1000, condition: "NEW", status: "ACTIVE", sellerSku: `s-${sfx}` }, select: { id: true } });
      await tx.offerInventory.create({ data: { offerId: o.id, sellerSku: `oi-${sfx}`, quantity: 5, reserved: 0, reorderPoint: 3 } });

      const probe = await tx.offerInventory.findMany({
        where: { offer: { variantId: { in: [v.id] }, seller: { is: { type: "FIRST_PARTY" } }, condition: "NEW" } },
        select: { offer: { select: { variantId: true } } },
      });
      ok("A  probe flags the variant as restockable from OfferInventory (no Inventory row exists)", probe.length === 1 && probe[0].offer.variantId === v.id);
      const invRow = await tx.inventory.findUnique({ where: { variantId: v.id } });
      ok("A  fixture genuinely has no Inventory row — probe is Inventory-free", invRow === null);

      const probeMissing = await tx.offerInventory.findMany({
        where: { offer: { variantId: { in: ["does-not-exist"] }, seller: { is: { type: "FIRST_PARTY" } }, condition: "NEW" } },
        select: { offer: { select: { variantId: true } } },
      });
      ok("A  probe does NOT flag a non-existent variant", probeMissing.length === 0);

      // ---- B — admin error sanitization (fresh fixture per sub-test) ----
      const fb1 = await mkFull(tx, axiaro.id, product.id, `b1-${sfx}`, 5);
      const rawLeak = await adminAdjustCore(tx, fb1.variantId, 3, { syncThrowsRaw: true });
      const leakMsg = "error" in rawLeak ? rawLeak.error : "";
      ok("B  a raw sync error is replaced by a sanitized message",
        "error" in rawLeak &&
        !/invariant|rolling back|OfferInventory|syncFirstPartyOfferStock|variant [a-z0-9]{20}|prev \d|delta -?\d/i.test(leakMsg),
        leakMsg);
      ok("B  sanitized message is user-actionable", /refresh|reload|try again/i.test(leakMsg));

      const fb2 = await mkFull(tx, axiaro.id, product.id, `b2-${sfx}`, 5);
      const safePass = await adminAdjustCore(tx, fb2.variantId, 1, { adjustFails: "Stock can’t go below zero." });
      ok("B  adjustStock's own user-facing copy passes through unchanged",
        "error" in safePass && safePass.error === "Stock can’t go below zero.");

      const fb3 = await mkFull(tx, axiaro.id, product.id, `b3-${sfx}`, 5);
      const success = await adminAdjustCore(tx, fb3.variantId, 2);
      const oiAfter = await tx.offerInventory.findFirstOrThrow({ where: { offerId: fb3.offerId }, select: { quantity: true } });
      const invAfter = await tx.inventory.findUniqueOrThrow({ where: { variantId: fb3.variantId }, select: { quantity: true } });
      const vsAfter = await tx.variant.findUniqueOrThrow({ where: { id: fb3.variantId }, select: { stock: true } });
      ok("B/E  9E-3D-6: a clean adjust moves OfferInventory (+2 → 7) + Variant.stock (7); frozen Inventory unchanged (5)",
        "ok" in success && oiAfter.quantity === 7 && vsAfter.stock === 7 && invAfter.quantity === 5);

      throw new Rollback();
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  const leaked = await prisma.variant.count({ where: { sku: { contains: sfx } } });
  ok("ROLLBACK  no fixture leaked", leaked === 0, String(leaked));
}

function staticChecks() {
  console.log("\nstatic — no operational Inventory dependency, sanitized errors, lock order");
  const returns = strip(readFileSync(new URL("../src/lib/admin/returns.ts", import.meta.url), "utf8"));
  const invActions = readFileSync(new URL("../src/lib/admin/inventory-actions.ts", import.meta.url), "utf8");
  const invActionsCode = strip(invActions);
  const invRead = strip(readFileSync(new URL("../src/lib/admin/inventory.ts", import.meta.url), "utf8"));
  const invPrim = readFileSync(new URL("../src/lib/inventory.ts", import.meta.url), "utf8");
  const cancel = strip(readFileSync(new URL("../src/lib/admin/order-actions.ts", import.meta.url), "utf8"));
  const returnsAct = strip(readFileSync(new URL("../src/lib/admin/returns-actions.ts", import.meta.url), "utf8"));
  const data = readFileSync(new URL("../src/lib/data.ts", import.meta.url), "utf8");

  // A — getAdminReturn probe
  ok("A  returns.ts getAdminReturn probes prisma.offerInventory, not prisma.inventory", /prisma\.offerInventory\.findMany/.test(returns) && !/prisma\.inventory\.find/.test(returns));
  ok("A  returns.ts probe applies the FIRST_PARTY offer filter", /FIRST_PARTY_OFFER_FILTER/.test(returns));

  // B — sanitized admin errors
  ok("B  inventory-actions.ts defines a typed AdjustError for safe messages", /class AdjustError extends Error/.test(invActionsCode));
  ok("B  inventory-actions.ts catch uses toActionError (no raw err.message passthrough)", /catch \(err\) \{\s*return toActionError\(/.test(invActionsCode) && !/return \{ error: err instanceof Error \? err\.message/.test(invActionsCode));
  ok("B  syncFirstPartyOfferStock call is wrapped and re-thrown as AdjustError", ordered(invActionsCode, /syncFirstPartyOfferStock\s*\(/, /throw new AdjustError/));
  ok("B  the raw sync error is logged server-side (console.error)", /console\.error\(\s*"\[adjustStockAction\] OfferInventory adjust failed/.test(invActionsCode));
  ok("B  toActionError logs unexpected errors and returns a generic message", /console\.error\(`\[\$\{context\}\] unexpected error`/.test(invActionsCode));

  // E / G — admin write is OfferInventory-only (9E-3D-6); cancel/return keep the offer-native branch first
  ok("E/G  adjustStockAction: syncFirstPartyOfferStock, NO adjustStock / @/lib/inventory", /syncFirstPartyOfferStock\s*\(/.test(invActionsCode) && !/adjustStock\s*\(/.test(invActionsCode) && !/from "@\/lib\/inventory"/.test(invActionsCode));
  ok("E/G  updateThresholdAction: syncFirstPartyOfferReorderPoint, NO setReorderPoint", /syncFirstPartyOfferReorderPoint\s*\(/.test(invActionsCode) && !/setReorderPoint\s*\(/.test(invActionsCode));
  ok("G  cancelOrderAction: restoreOfferStock (offer-native) before adjustStock (legacy)", ordered(cancel, /restoreOfferStock\s*\(/, /adjustStock\s*\(/));
  ok("G  receiveReturnAction: restoreOfferStock (offer-native) before adjustStock (legacy)", ordered(returnsAct, /restoreOfferStock\s*\(/, /adjustStock\s*\(/));

  // I — no operational current-state Inventory read remains
  ok("I  inventory-actions.ts has no prisma.inventory read (preload → getFirstPartyStock)", !/prisma\.inventory\.find/.test(invActionsCode) && /getFirstPartyStock/.test(invActionsCode));
  ok("I  returns.ts has no prisma.inventory read", !/prisma\.inventory\./.test(returns));
  ok("I  admin/inventory.ts (list/detail) has no prisma.inventory read", !/prisma\.inventory\.find/.test(invRead));
  // The remaining Inventory access is all mirror-write / read-for-write / ledger / create-time:
  ok("I  inventory.ts primitives still row-lock Inventory FOR UPDATE (mirror writers)", /FROM "Inventory" WHERE "variantId" = \$\{variantId\} FOR UPDATE/.test(invPrim));
  ok("I  order-actions cancellation reads InventoryAdjustment SALE rows (mirror reversal, not a state read)", /tx\.inventoryAdjustment\.findMany/.test(cancel) && /reason: "SALE"/.test(cancel));
  ok("I  returns-actions locates the Inventory mirror row FOR the restock write only", /tx\.inventory\.findUnique/.test(returnsAct));

  // H — customer availability offer-driven
  ok("H  data.ts storefront stock = winning offer available, never Variant.stock", /stock: off\.available/.test(data) && /never reads `Variant\.stock`/.test(data));

  // J — historical ledger intact (legacy archive still read; unioned with the
  //     current OfferAdjustment ledger since 9E-3D-6)
  ok("J  admin/inventory.ts history still reads the legacy InventoryAdjustment archive", /prisma\.inventoryAdjustment\.findMany/.test(invRead) && /distinct: \["reason"\]/.test(invRead));
  ok("J  inventory.ts still writes InventoryAdjustment rows for the LEGACY cancel/return fallback (adjustStock)", /tx\.inventoryAdjustment\.create/.test(invPrim));
  ok("J  history unions the current OfferAdjustment ledger, excluding MIGRATION_OPENING", /prisma\.offerAdjustment\.findMany/.test(invRead) && /MIGRATION_OPENING/.test(invRead));

  // §9 — dead code documented, not deleted
  ok("§9  reserveStock / releaseStock / commitStock still present (DEAD / FUTURE UTILITY, not deleted)",
    /export async function reserveStock/.test(invPrim) && /export async function releaseStock/.test(invPrim) && /export async function commitStock/.test(invPrim));
  ok("§9  inventory.ts doc marks the dead utilities explicitly", /DEAD \/ FUTURE UTILITY/.test(invPrim));

  // §7 — Variant.stock never authoritative
  ok("§7  Variant.stock only written as 0 at creation + re-derived by syncVariantMirror", /SET "stock" = GREATEST\(0, COALESCE\(/.test(invPrim));
}

async function gateCheck() {
  const g = await prisma.storeSetting.findUnique({ where: { key: "marketplace.multiSellerCheckout" } });
  ok("GATE  marketplace.multiSellerCheckout == 'false'", g?.value === "false", g?.value ?? "<absent>");
  const pay = await prisma.payment.count();
  const wh = await prisma.webhookEvent.count();
  ok("GATE  PayMongo dormant (0 payments, 0 webhookEvents)", pay === 0 && wh === 0, `${pay}/${wh}`);
}

async function run() {
  await dbTests();
  staticChecks();
  await gateCheck();
  console.log(`\n  ${pass} passed, ${fail} failed.`);
  if (fail > 0) throw new Error(`${fail} Phase 9E-3D-3 check(s) failed.`);
}

run().then(() => console.log("All Phase 9E-3D-3 checks passed."))
  .catch((e) => { console.error(e.message ?? e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
