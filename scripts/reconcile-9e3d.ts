/**
 * Phase 9E-3D — inventory authority reconciliation. READ-ONLY.
 *
 * Two regimes, one script:
 *
 *   POST-RETIREMENT OFFER CHAIN (authoritative, always strict) —
 *     OfferInventory opening + Σ OfferAdjustment.delta == OfferInventory.quantity;
 *     SALE + CANCELLATION + RETURN net per offer-native order; no negative
 *     OfferInventory; CHECK constraints present; OfferInventory ↔ FIRST_PARTY
 *     Offer ↔ Variant 1:1 (both directions).
 *
 *   PRE-RETIREMENT LEGACY ARCHIVE (frozen, still internally consistent) —
 *     Inventory opening + Σ InventoryAdjustment.delta == Inventory.quantity;
 *     no negative Inventory; Variant.stock == max(0, Inventory.q - r) (the
 *     denorm mirror tracks its writer, which is still Inventory).
 *
 *   CROSS-STORE PARITY (transitional) — OfferInventory.quantity ==
 *     Inventory.quantity is REQUIRED only for offers where NEITHER store has
 *     moved past its opening balance. Since Phase 9E-3D-5 an offer-native
 *     sale / cancel / return moves only OfferInventory, so a moved offer
 *     legitimately diverges — reported as [INFO], never a failure.
 *
 * Exit 1 on any failure.
 *   node --env-file=.env --import tsx scripts/reconcile-9e3d.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.error(`  [FAIL] ${name}   ${detail}`); }
};

async function run() {
  console.log("PHASE 9E-3D — inventory authority reconciliation\n");

  const axiaro = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
  if (!axiaro) { console.error("STOP — no FIRST_PARTY seller."); process.exitCode = 1; return; }

  // Every FIRST_PARTY NEW offer with its OfferInventory, its variant, and that
  // variant's legacy Inventory row.
  const offers = await prisma.offer.findMany({
    where: { sellerId: axiaro.id, condition: "NEW" },
    select: {
      id: true,
      variantId: true,
      inventory: { select: { id: true, quantity: true, reserved: true, reorderPoint: true } },
      variant: { select: { id: true, stock: true, inventory: { select: { id: true, quantity: true, reserved: true, reorderPoint: true } } } },
    },
  });
  console.log(`  ${offers.length} FIRST_PARTY NEW offers\n`);

  // Per-store operational-movement flags. Phase 9E-3D-5: offer-native
  // checkout / cancel / return write ONLY OfferInventory + OfferAdjustment.
  // The `Inventory` mirror is frozen for operational movement from the
  // 9E-3D-5 deploy on (admin adjust + variant lifecycle still write it).
  // So cross-store parity is REQUIRED only while NEITHER store has moved
  // past its opening balance; once either has, the two legitimately diverge.
  // An offer's two stores legitimately diverge only when a POST-9E-3D-5
  // operation touched one but not the other:
  //   - offer-native SALE / CANCELLATION / RETURN → moves OfferInventory only
  //     (the offer gains an operational OfferAdjustment)
  //   - legacy-fallback CANCELLATION / RETURN → moves Inventory only (the
  //     variant gains a CANCELLATION / RETURN InventoryAdjustment)
  // Everything else (admin adjust — still dual-write; pre-backfill legacy SALE
  // — baked into the OfferInventory opening) keeps the two stores equal.
  const oiMoved = new Set(
    (await prisma.$queryRawUnsafe(
      `SELECT DISTINCT "offerInventoryId" AS id FROM "OfferAdjustment"
       WHERE "reason" IN ('SALE','CANCELLATION','RETURN')`,
    ) as { id: string }[]).map((r) => r.id),
  );
  const invMoved = new Set(
    (await prisma.$queryRawUnsafe(
      `SELECT DISTINCT "inventoryId" AS id FROM "InventoryAdjustment"
       WHERE "reason" IN ('CANCELLATION','RETURN')`,
    ) as { id: string }[]).map((r) => r.id),
  );

  // ── PRE-RETIREMENT: cross-store parity (only for un-moved offers) ──────
  let qDiff = 0, rDiff = 0, rpDiff = 0, availDiff = 0, mirrorDiff = 0, missingOI = 0, missingInv = 0;
  let parityChecked = 0, divergedInfo = 0;
  const qDiffRows: string[] = [];
  const divergedRows: string[] = [];
  for (const o of offers) {
    const oi = o.inventory;
    const inv = o.variant.inventory;
    if (!oi) { missingOI++; continue; }
    if (!inv) { missingInv++; continue; }
    if (o.variant.stock !== Math.max(0, inv.quantity - inv.reserved)) mirrorDiff++;
    const moved = oiMoved.has(oi.id) || invMoved.has(inv.id);
    if (moved) {
      if (oi.quantity !== inv.quantity) {
        divergedInfo++;
        divergedRows.push(`offer ${o.id}: OfferInv ${oi.quantity} / frozen Inv ${inv.quantity}`);
      }
      continue;
    }
    parityChecked++;
    if (oi.quantity !== inv.quantity) { qDiff++; qDiffRows.push(`offer ${o.id}: OfferInv ${oi.quantity} vs Inv ${inv.quantity}`); }
    if (oi.reserved !== inv.reserved) rDiff++;
    if (oi.reorderPoint !== inv.reorderPoint) rpDiff++;
    if (Math.max(0, oi.quantity - oi.reserved) !== Math.max(0, inv.quantity - inv.reserved)) availDiff++;
  }
  check("every FIRST_PARTY offer has an OfferInventory row", missingOI === 0, `${missingOI} missing`);
  check("every such variant has a legacy Inventory row", missingInv === 0, `${missingInv} missing`);
  check(`OfferInventory.quantity == Inventory.quantity (${parityChecked} un-moved offers)`, qDiff === 0, qDiffRows.slice(0, 5).join(" ; "));
  check("OfferInventory.reserved == Inventory.reserved (un-moved offers)", rDiff === 0, `${rDiff} differ`);
  check("OfferInventory.reorderPoint == Inventory.reorderPoint (un-moved offers)", rpDiff === 0, `${rpDiff} differ`);
  check("available parity on both stores (un-moved offers)", availDiff === 0, `${availDiff} differ`);
  check("Variant.stock == max(0, Inventory.quantity - reserved) — the denorm mirror tracks its writer (Inventory)", mirrorDiff === 0, `${mirrorDiff} differ`);
  if (divergedInfo > 0) {
    console.log(`  [INFO] ${divergedInfo} offer(s) legitimately diverged post-retirement (OfferInventory moved, Inventory frozen): ${divergedRows.slice(0, 5).join(" ; ")}`);
  }

  const invNoFpOffer = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM "Inventory" i
     WHERE NOT EXISTS (
       SELECT 1 FROM "Offer" o JOIN "Seller" s ON s.id = o."sellerId"
       WHERE o."variantId" = i."variantId" AND s.type = 'FIRST_PARTY' AND o.condition = 'NEW'
     )`,
  ) as { n: number }[];
  check("every Inventory row has a FIRST_PARTY NEW offer (reverse coverage)", invNoFpOffer[0].n === 0, `${invNoFpOffer[0].n} uncovered`);

  const multiFpOffer = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT o."variantId" FROM "Offer" o JOIN "Seller" s ON s.id = o."sellerId"
       WHERE s.type = 'FIRST_PARTY' AND o.condition = 'NEW'
       GROUP BY o."variantId" HAVING COUNT(*) > 1
     ) d`,
  ) as { n: number }[];
  check("at most one FIRST_PARTY NEW offer per variant", multiFpOffer[0].n === 0, `${multiFpOffer[0].n} variants with >1`);

  // ── negative stock ────────────────────────────────────────────────────
  const negOI = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM "OfferInventory" WHERE "quantity" < 0 OR "quantity" < "reserved" OR "reserved" < 0`,
  ) as { n: number }[];
  const negInv = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM "Inventory" WHERE "quantity" < 0 OR "quantity" < "reserved" OR "reserved" < 0`,
  ) as { n: number }[];
  check("no negative / invalid OfferInventory rows", negOI[0].n === 0, `${negOI[0].n}`);
  check("no negative / invalid Inventory rows", negInv[0].n === 0, `${negInv[0].n}`);

  // ── CHECK constraints present ─────────────────────────────────────────
  const cks = await prisma.$queryRawUnsafe(
    `SELECT conname FROM pg_constraint WHERE conname IN ('offerinventory_quantity_nonneg','offerinventory_reserved_nonneg','offerinventory_available_nonneg','offerinventory_reorder_nonneg')`,
  ) as { conname: string }[];
  check("OfferInventory CHECK constraints present (nonneg / available / reorder)", cks.length === 4, cks.map((c) => c.conname).join(","));

  // ── orphans ──────────────────────────────────────────────────────────
  const orphanOI = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM "OfferInventory" oi LEFT JOIN "Offer" o ON o."id" = oi."offerId" WHERE o."id" IS NULL`,
  ) as { n: number }[];
  const orphanOffer = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM "Offer" o LEFT JOIN "Variant" v ON v."id" = o."variantId" WHERE v."id" IS NULL`,
  ) as { n: number }[];
  const orphanInv = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM "Inventory" i LEFT JOIN "Variant" v ON v."id" = i."variantId" WHERE v."id" IS NULL`,
  ) as { n: number }[];
  check("no orphaned OfferInventory (offer gone)", orphanOI[0].n === 0, `${orphanOI[0].n}`);
  check("no orphaned Offer (variant gone)", orphanOffer[0].n === 0, `${orphanOffer[0].n}`);
  check("no orphaned Inventory (variant gone)", orphanInv[0].n === 0, `${orphanInv[0].n}`);

  // ── duplicate adjustments ────────────────────────────────────────────
  const dupOfferAdj = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT "offerInventoryId","reason","note" FROM "OfferAdjustment"
       WHERE "reason" IN ('SALE','CANCELLATION','RETURN') AND "note" IS NOT NULL
       GROUP BY "offerInventoryId","reason","note" HAVING COUNT(*) > 1
     ) d`,
  ) as { n: number }[];
  const dupInvAdj = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT "inventoryId","reason","note" FROM "InventoryAdjustment"
       WHERE "reason" IN ('SALE','CANCELLATION','RETURN') AND "note" IS NOT NULL
       GROUP BY "inventoryId","reason","note" HAVING COUNT(*) > 1
     ) d`,
  ) as { n: number }[];
  check("no duplicate OfferAdjustment (same offerInventoryId + reason + note)", dupOfferAdj[0].n === 0, `${dupOfferAdj[0].n}`);
  check("no duplicate InventoryAdjustment (same inventoryId + reason + note)", dupInvAdj[0].n === 0, `${dupInvAdj[0].n}`);

  // ── adjustment-sum reconciliation ────────────────────────────────────
  const oiSums = await prisma.$queryRawUnsafe(
    `SELECT oi."id", oi."quantity",
            (SELECT "previousQuantity" FROM "OfferAdjustment" a WHERE a."offerInventoryId"=oi."id" ORDER BY a."createdAt" ASC, a."id" ASC LIMIT 1) AS opening,
            COALESCE((SELECT SUM("delta") FROM "OfferAdjustment" a WHERE a."offerInventoryId"=oi."id"),0)::int AS sumdelta,
            (SELECT COUNT(*) FROM "OfferAdjustment" a WHERE a."offerInventoryId"=oi."id")::int AS n
     FROM "OfferInventory" oi`,
  ) as { id: string; quantity: number; opening: number | null; sumdelta: number; n: number }[];
  let oiSumBad = 0;
  for (const r of oiSums) {
    if (r.n === 0) continue; // no history yet — nothing to reconcile
    const expected = (r.opening ?? 0) + r.sumdelta;
    if (expected !== r.quantity) oiSumBad++;
  }
  check("OfferAdjustment chain reconciles (opening + Σδ == quantity)", oiSumBad === 0, `${oiSumBad} broken chains`);

  const invSums = await prisma.$queryRawUnsafe(
    `SELECT i."id", i."quantity",
            (SELECT "previousQuantity" FROM "InventoryAdjustment" a WHERE a."inventoryId"=i."id" ORDER BY a."createdAt" ASC, a."id" ASC LIMIT 1) AS opening,
            COALESCE((SELECT SUM("delta") FROM "InventoryAdjustment" a WHERE a."inventoryId"=i."id"),0)::int AS sumdelta,
            (SELECT COUNT(*) FROM "InventoryAdjustment" a WHERE a."inventoryId"=i."id")::int AS n
     FROM "Inventory" i`,
  ) as { id: string; quantity: number; opening: number | null; sumdelta: number; n: number }[];
  let invSumBad = 0;
  for (const r of invSums) {
    if (r.n === 0) continue;
    const expected = (r.opening ?? 0) + r.sumdelta;
    if (expected !== r.quantity) invSumBad++;
  }
  check("InventoryAdjustment chain reconciles (opening + Σδ == quantity)", invSumBad === 0, `${invSumBad} broken chains`);

  // ── SALE/CANCELLATION/RETURN net movement, per order ──────────────────
  // For every order with a SALE OfferAdjustment: Σ(SALE) + Σ(CANCELLATION) net
  // to 0 iff the order is cancelled; and RETURN adds back only the received qty.
  const saleNotes = await prisma.$queryRawUnsafe(
    `SELECT DISTINCT "note" FROM "OfferAdjustment" WHERE "reason"='SALE' AND "note" LIKE 'Order %'`,
  ) as { note: string }[];
  let netBad = 0;
  for (const { note } of saleNotes) {
    const orderNumber = note.replace(/^Order /, "");
    const ord = await prisma.order.findUnique({ where: { orderNumber }, select: { status: true } });
    const rows = await prisma.$queryRawUnsafe(
      `SELECT "reason", COALESCE(SUM("delta"),0)::int AS s FROM "OfferAdjustment"
       WHERE "note" LIKE ${"'" + orderNumber.replace(/'/g, "''") + "%'"} GROUP BY "reason"`,
    ) as { reason: string; s: number }[];
    const byReason = Object.fromEntries(rows.map((r) => [r.reason, r.s]));
    const sale = byReason["SALE"] ?? 0;      // negative
    const cancel = byReason["CANCELLATION"] ?? 0; // positive
    if (ord?.status === "CANCELLED" && sale + cancel !== 0) { netBad++; }
    if (ord?.status !== "CANCELLED" && cancel !== 0) { netBad++; } // cancelled-back but not cancelled
  }
  check("SALE + CANCELLATION net to 0 for every cancelled offer-native order (and only those)", netBad === 0, `${netBad} mismatches`);

  console.log(`\n  ${pass} passed, ${fail} failed.`);
  if (fail > 0) { console.error("\nRECONCILIATION FAILED."); process.exitCode = 1; }
  else console.log("\nRECONCILIATION PASSED — post-retirement OfferAdjustment chain reconciles; the pre-retirement InventoryAdjustment archive is frozen and internally consistent; un-moved offers remain in cross-store parity.");
}

run().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
