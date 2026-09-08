/**
 * PHASE 9F-23a — remove the hardcoded FIRST_PARTY `condition = "NEW"` anchor
 * from reconciliation, its monitor, the 4 1P analytics queries, and the admin
 * dashboard 1P low-stock tile.
 *
 * Requirement: ZERO functional change on current production data (all 1P offers
 * are NEW, exactly one FIRST_PARTY offer per variant). Every query now anchors
 * on the FIRST_PARTY seller alone.
 *
 * READ-ONLY against production (equivalence checks run the OLD vs NEW SQL and
 * assert identical results). No offers / orders / inventory / condition changes.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f23a.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

function staticTests() {
  console.log("\n── static wiring ──");
  const reconcile = read("scripts/reconcile-9e3d.ts");
  const monitor = read("scripts/monitor-9e3d.ts");
  const queries = read("src/lib/analytics/queries.ts");
  const dash = read("src/app/admin/(shell)/page.tsx");

  // helper: does the file still filter FIRST_PARTY offers by condition = 'NEW'
  // in EXECUTABLE code (comments allowed to mention it as historical context)?
  const noNewInCode = (src: string) => {
    const stripped = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    return !/condition\s*=\s*'NEW'/.test(stripped) && !/condition:\s*"NEW"/.test(stripped);
  };

  // 2 — reconcile no longer depends on condition to identify the 1P offer
  ok("reconcile · offer fetch is `where: { sellerId: axiaro.id }` (no condition)", /const offers = await prisma\.offer\.findMany\(\{\s*where: \{ sellerId: axiaro\.id \},/.test(reconcile));
  ok("reconcile · reverse-coverage subquery drops AND o.condition = 'NEW'", /WHERE o\."variantId" = i\."variantId" AND s\.type = 'FIRST_PARTY'\s*\n\s*\)/.test(reconcile));
  ok("reconcile · no `condition = 'NEW'` / `condition: \"NEW\"` in executable code", noNewInCode(reconcile));
  ok("reconcile · still anchors on s.type = 'FIRST_PARTY'", /s\.type = 'FIRST_PARTY'/.test(reconcile) && /where: \{ type: "FIRST_PARTY" \}/.test(reconcile));

  // 3 — one-1P-offer-per-variant invariant retained (now condition-independent)
  ok("reconcile · one-per-variant guard = FIRST_PARTY only, no condition", /SELECT o\."variantId" FROM "Offer" o JOIN "Seller" s ON s\.id = o\."sellerId"\s*\n\s*WHERE s\.type = 'FIRST_PARTY'\s*\n\s*GROUP BY o\."variantId" HAVING COUNT\(\*\) > 1/.test(reconcile));
  ok("reconcile · guard message updated to 'at most one FIRST_PARTY offer per variant'", /check\("at most one FIRST_PARTY offer per variant"/.test(reconcile));

  // 7 — monitor
  ok("monitor · chain query drops AND o.condition = 'NEW', keeps FIRST_PARTY", /JOIN "Seller" s ON s\.id = o\."sellerId"\s*\n\s*WHERE s\.type = 'FIRST_PARTY'`/.test(monitor) && noNewInCode(monitor));

  // 3/4 — analytics
  ok("analytics · getInventoryInsights FP fragment = FIRST_PARTY + v.status ACTIVE only", /WHERE s\.type = 'FIRST_PARTY' AND v\.status = 'ACTIVE'`;/.test(queries));
  ok("analytics · retail-value query drops AND o.condition = 'NEW'", /JOIN "Product" p ON p\.id = v\."productId"\s*\n\s*WHERE s\.type = 'FIRST_PARTY' AND v\.status = 'ACTIVE'/.test(queries));
  ok("analytics · product-performance offers where = seller FIRST_PARTY only", /offers: \{\s*\n\s*where: \{ seller: \{ is: \{ type: "FIRST_PARTY" \} \} \},/.test(queries));
  ok("analytics · getLowStockReport offer where = seller FIRST_PARTY + variant ACTIVE only", /offer: \{ seller: \{ is: \{ type: "FIRST_PARTY" \} \}, variant: \{ status: "ACTIVE" \} \}/.test(queries));
  ok("analytics · no `condition = 'NEW'` / `condition: \"NEW\"` in executable code", noNewInCode(queries));

  // 6 — dashboard
  ok("dashboard · low-stock tile SQL drops AND o.condition = 'NEW', keeps FIRST_PARTY", /WHERE s\.type = 'FIRST_PARTY'\s*\n\s*AND oi\."quantity" - oi\."reserved" <= oi\."reorderPoint"/.test(dash) && noNewInCode(dash));

  // 8 — untouched areas (no CMS control, no 1P sync/inventory/FILTER change)
  ok("8 · offer-sync.ts NOT touched (still hardcodes FIRST_PARTY + condition 'NEW')", !/9F-23a/.test(read("src/lib/admin/offer-sync.ts")) && (read("src/lib/admin/offer-sync.ts").match(/condition = 'NEW'|condition: "NEW"/g) ?? []).length >= 5);
  ok("8 · first-party-inventory.ts FIRST_PARTY_OFFER_FILTER still pins condition: \"NEW\"", /FIRST_PARTY_OFFER_FILTER = \{[\s\S]{0,120}condition: "NEW",/.test(read("src/lib/admin/first-party-inventory.ts")) && !/9F-23a/.test(read("src/lib/admin/first-party-inventory.ts")));
  ok("8 · marketplace/offer-inventory.ts (checkout/cancel/return) NOT touched", !/9F-23a/.test(read("src/lib/marketplace/offer-inventory.ts")));
  ok("8 · admin/inventory.ts + inventory write paths NOT touched", !/9F-23a/.test(read("src/lib/admin/inventory.ts")) && !/9F-23a/.test(read("src/lib/inventory.ts")) && !/9F-23a/.test(read("src/lib/admin/inventory-actions.ts")));
  ok("8 · checkout.ts + OrderItem snapshot NOT touched", !/9F-23a/.test(read("src/lib/checkout.ts")));
  ok("8 · buy-box / seller-repository / email NOT touched", !/9F-23a/.test(read("src/lib/marketplace/buy-box-rule.ts")) && !/9F-23a/.test(read("src/lib/marketplace/seller-repository.ts")) && !/9F-23a/.test(read("src/lib/email/notifications.ts")));
  ok("9 · NO CMS/admin condition selector added (product-variants.tsx unchanged)", !/9F-23a/.test(read("src/components/admin/catalog/product-variants.tsx")) && !/conditionLabel|name="condition"/.test(read("src/components/admin/catalog/product-variants.tsx")));
  ok("10 · ensureFirstPartyOffer still hardcodes condition: \"NEW\" (no offer can go non-NEW yet)", /condition: "NEW",/.test(read("src/lib/admin/offer-sync.ts")) && /sellerId_variantId_condition: \{ sellerId, variantId: variant\.id, condition: "NEW" \}/.test(read("src/lib/admin/offer-sync.ts")));
  ok("scope · seed-rbac.ts untouched", !/9F-23a/.test(read("scripts/seed-rbac.ts")));
  ok("scope · schema unchanged (no 9F-23a marker)", !/9F-23a/.test(read("prisma/schema.prisma")));
}

async function prodEquivalenceTests() {
  console.log("\n── production equivalence (READ-ONLY: OLD vs NEW SQL) ──");
  const axiaro = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
  if (!axiaro) { ok("no FIRST_PARTY seller — skipped", true); return; }

  // 1 — reconcile offer row-set: OLD (condition='NEW') vs NEW (seller only)
  const oldSet = await prisma.offer.findMany({ where: { sellerId: axiaro.id, condition: "NEW" }, select: { id: true } });
  const newSet = await prisma.offer.findMany({ where: { sellerId: axiaro.id }, select: { id: true } });
  ok("1 · reconcile FIRST_PARTY offer row-set identical (OLD condition='NEW' == NEW seller-only)",
    oldSet.length === newSet.length && new Set(oldSet.map((o) => o.id)).size === new Set([...oldSet, ...newSet].map((o) => o.id)).size,
    `old ${oldSet.length} / new ${newSet.length}`);

  // 4 — no 3P offer creeps in
  const tpInSet = await prisma.offer.count({ where: { sellerId: axiaro.id, seller: { is: { type: "THIRD_PARTY" } } } });
  const tpTotal = await prisma.offer.count({ where: { seller: { is: { type: "THIRD_PARTY" } } } });
  ok("4 · the FIRST_PARTY anchor includes ZERO THIRD_PARTY offers", tpInSet === 0, `${tpInSet} of ${tpTotal} 3P offers`);

  // 3 — one FIRST_PARTY offer per variant, condition-independent
  const multi = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT COUNT(*)::int AS n FROM (SELECT o."variantId" FROM "Offer" o JOIN "Seller" s ON s.id=o."sellerId" WHERE s.type='FIRST_PARTY' GROUP BY o."variantId" HAVING COUNT(*)>1) d`,
  );
  ok("3 · production has exactly one FIRST_PARTY offer per variant", multi[0].n === 0, `${multi[0].n} variants with >1`);

  // 5 — analytics: getInventoryInsights status counts, OLD vs NEW
  const insOld = await prisma.$queryRawUnsafe<{ out: number; low: number }[]>(`
    SELECT COUNT(*) FILTER (WHERE oi.quantity - oi.reserved <= 0)::int AS out,
           COUNT(*) FILTER (WHERE oi.quantity - oi.reserved > 0 AND oi.quantity - oi.reserved <= oi."reorderPoint")::int AS low
    FROM "OfferInventory" oi JOIN "Offer" o ON o.id=oi."offerId" JOIN "Seller" s ON s.id=o."sellerId" JOIN "Variant" v ON v.id=o."variantId"
    WHERE s.type='FIRST_PARTY' AND o.condition='NEW' AND v.status='ACTIVE'`);
  const insNew = await prisma.$queryRawUnsafe<{ out: number; low: number }[]>(`
    SELECT COUNT(*) FILTER (WHERE oi.quantity - oi.reserved <= 0)::int AS out,
           COUNT(*) FILTER (WHERE oi.quantity - oi.reserved > 0 AND oi.quantity - oi.reserved <= oi."reorderPoint")::int AS low
    FROM "OfferInventory" oi JOIN "Offer" o ON o.id=oi."offerId" JOIN "Seller" s ON s.id=o."sellerId" JOIN "Variant" v ON v.id=o."variantId"
    WHERE s.type='FIRST_PARTY' AND v.status='ACTIVE'`);
  ok("5 · getInventoryInsights out/low counts identical OLD vs NEW", insOld[0].out === insNew[0].out && insOld[0].low === insNew[0].low, `${JSON.stringify(insOld[0])} vs ${JSON.stringify(insNew[0])}`);

  // 5 — retail value OLD vs NEW
  const valOld = await prisma.$queryRawUnsafe<{ retail: string }[]>(`
    SELECT COALESCE(SUM(oi.quantity * v.price),0)::text AS retail
    FROM "OfferInventory" oi JOIN "Offer" o ON o.id=oi."offerId" JOIN "Seller" s ON s.id=o."sellerId" JOIN "Variant" v ON v.id=o."variantId"
    WHERE s.type='FIRST_PARTY' AND o.condition='NEW' AND v.status='ACTIVE'`);
  const valNew = await prisma.$queryRawUnsafe<{ retail: string }[]>(`
    SELECT COALESCE(SUM(oi.quantity * v.price),0)::text AS retail
    FROM "OfferInventory" oi JOIN "Offer" o ON o.id=oi."offerId" JOIN "Seller" s ON s.id=o."sellerId" JOIN "Variant" v ON v.id=o."variantId"
    WHERE s.type='FIRST_PARTY' AND v.status='ACTIVE'`);
  ok("5 · getInventoryInsights retail value identical OLD vs NEW", valOld[0].retail === valNew[0].retail, `${valOld[0].retail} vs ${valNew[0].retail}`);

  // 5 — getLowStockReport row set OLD vs NEW
  const lowOld = await prisma.offerInventory.count({ where: { offer: { seller: { is: { type: "FIRST_PARTY" } }, condition: "NEW", variant: { status: "ACTIVE" } } } });
  const lowNew = await prisma.offerInventory.count({ where: { offer: { seller: { is: { type: "FIRST_PARTY" } }, variant: { status: "ACTIVE" } } } });
  ok("5 · getLowStockReport candidate count identical OLD vs NEW", lowOld === lowNew, `${lowOld} vs ${lowNew}`);

  // 6 — dashboard tile OLD vs NEW
  const tileOld = await prisma.$queryRawUnsafe<{ count: bigint }[]>(`
    SELECT COUNT(*)::bigint AS count FROM "OfferInventory" oi JOIN "Offer" o ON o.id=oi."offerId" JOIN "Seller" s ON s.id=o."sellerId"
    WHERE s.type='FIRST_PARTY' AND o.condition='NEW' AND oi."quantity"-oi."reserved" <= oi."reorderPoint"`);
  const tileNew = await prisma.$queryRawUnsafe<{ count: bigint }[]>(`
    SELECT COUNT(*)::bigint AS count FROM "OfferInventory" oi JOIN "Offer" o ON o.id=oi."offerId" JOIN "Seller" s ON s.id=o."sellerId"
    WHERE s.type='FIRST_PARTY' AND oi."quantity"-oi."reserved" <= oi."reorderPoint"`);
  ok("6 · dashboard low-stock tile count identical OLD vs NEW", Number(tileOld[0].count) === Number(tileNew[0].count), `${tileOld[0].count} vs ${tileNew[0].count}`);

  // 7 — monitor chain query row set OLD vs NEW
  const monOld = await prisma.$queryRawUnsafe<{ n: number }[]>(`
    SELECT COUNT(*)::int AS n FROM "OfferInventory" oi JOIN "Offer" o ON o.id=oi."offerId" JOIN "Seller" s ON s.id=o."sellerId"
    WHERE s.type='FIRST_PARTY' AND o.condition='NEW'`);
  const monNew = await prisma.$queryRawUnsafe<{ n: number }[]>(`
    SELECT COUNT(*)::int AS n FROM "OfferInventory" oi JOIN "Offer" o ON o.id=oi."offerId" JOIN "Seller" s ON s.id=o."sellerId"
    WHERE s.type='FIRST_PARTY'`);
  ok("7 · monitor OfferInventory chain set identical OLD vs NEW", monOld[0].n === monNew[0].n, `${monOld[0].n} vs ${monNew[0].n}`);

  // production safety snapshot
  const fpByCond = await prisma.offer.groupBy({ by: ["condition"], where: { seller: { is: { type: "FIRST_PARTY" } } }, _count: true });
  ok("prod · every FIRST_PARTY offer is still condition NEW", fpByCond.every((g) => g.condition === "NEW"), JSON.stringify(fpByCond));
  const sa = await prisma.offer.findFirst({ where: { seller: { is: { displayName: "Style Avenue" } } }, select: { condition: true, status: true } });
  ok("prod · Style Avenue 3P offer unchanged (NEW/ACTIVE)", sa?.condition === "NEW" && sa?.status === "ACTIVE", JSON.stringify(sa));
  ok("prod · Inventory 332 / OfferInventory 333 / Variant 332 (unchanged)",
    (await prisma.inventory.count()) === 332 && (await prisma.offerInventory.count()) === 333 && (await prisma.variant.count()) === 332);
}

async function main() {
  console.log("\nPHASE 9F-23a — 1P condition foundation: reconcile / monitor / analytics\n");
  staticTests();
  await prodEquivalenceTests();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
