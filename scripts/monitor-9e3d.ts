/**
 * Phase 9E-3D-7 — 1P inventory FREEZE & OBSERVATION monitor. READ-ONLY.
 *
 * Run during the observation window (min 30 days OR 5 production deploys,
 * whichever is longer) and after every deploy. Flags any unexpected write to
 * the frozen legacy `Inventory` / `InventoryAdjustment` store, confirms the
 * `OfferAdjustment` operational ledger, and reports the observation anchors.
 *
 *   node --env-file=.env --import tsx scripts/monitor-9e3d.ts [--since=<ISO>]
 *
 * Default `--since` = the retirement boundary anchor (2026-09-04T00:00:00Z:
 * the 9E-3D-5 / 9E-3D-6 deploy day). Any InventoryAdjustment created after
 * that, or Inventory row whose `updatedAt` is after it, is NEW activity to
 * classify:
 *   A  permitted historical fallback  — CANCELLATION / RETURN whose order/return
 *      predates the retirement boundary (a re-opened pre-retirement record)
 *   B  test                            — SKU matches a known test-fixture pattern
 *   C  UNEXPECTED operational write     — anything else → exit 1, investigate
 *
 * Exit 1 on any hard-stop condition (§13). Exit 0 = CONTINUE OBSERVATION.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

const RETIREMENT_BOUNDARY = new Date("2026-09-04T00:00:00Z");
const sinceArg = process.argv.find((a) => a.startsWith("--since="))?.slice("--since=".length);
const SINCE = sinceArg ? new Date(sinceArg) : RETIREMENT_BOUNDARY;

// Known pre-retirement records that MAY still use the legacy Inventory fallback.
const LEGACY_ORDERS = new Set(["AX-260902-100023"]);
const TEST_SKU = /^(Z-9dd|X-|V-9|a-9e3d|b-9e3d|s-\w+9e3d|AX-TEST)/i;
const TEST_NOTE = /9e3d\d|9dd|test opening|dup$/i;

let fail = 0;
const flag = (msg: string) => { fail++; console.error(`  [STOP] ${msg}`); };
const info = (msg: string) => console.log(`  ${msg}`);

async function run() {
  console.log(`PHASE 9E-3D-7 — freeze & observation monitor`);
  console.log(`  observation anchor (--since): ${SINCE.toISOString()}`);
  console.log(`  boundary: 9E-3D-5 (ba17907) + 9E-3D-6 (adc814b), 2026-09-04\n`);

  // ── 1. legacy fallback order ──────────────────────────────────────────
  console.log("── known pre-retirement legacy order ──");
  for (const num of LEGACY_ORDERS) {
    const o = await prisma.order.findUnique({ where: { orderNumber: num }, select: { status: true, placedAt: true } });
    info(`${num}: ${o ? `${o.status} (placed ${o.placedAt.toISOString().slice(0, 10)})` : "NOT FOUND"}`);
  }

  // ── 2. new InventoryAdjustment activity (the frozen archive) ──────────
  console.log("\n── InventoryAdjustment activity since anchor (frozen archive) ──");
  const newIA = await prisma.inventoryAdjustment.findMany({
    where: { createdAt: { gte: SINCE } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true, reason: true, delta: true, note: true, createdAt: true,
      inventory: { select: { sku: true, variant: { select: { product: { select: { name: true } } } } } },
    },
  });
  if (newIA.length === 0) {
    info("none — the archive is frozen ✓");
  } else {
    for (const a of newIA) {
      const sku = a.inventory.sku;
      const orderMatch = a.note?.match(/Order (AX-[\w-]+)/)?.[1];
      const returnMatch = a.note?.match(/Return (RET-[\w-]+)/)?.[1];
      let cls: "A" | "B" | "C" = "C";
      if (TEST_SKU.test(sku) || (a.note && TEST_NOTE.test(a.note))) cls = "B";
      else if (["CANCELLATION", "RETURN"].includes(a.reason)) {
        // permitted iff the referenced order/return predates the boundary
        if (orderMatch && LEGACY_ORDERS.has(orderMatch)) cls = "A";
        else if (orderMatch) {
          const ord = await prisma.order.findUnique({ where: { orderNumber: orderMatch }, select: { placedAt: true } });
          if (ord && ord.placedAt < RETIREMENT_BOUNDARY) cls = "A";
        } else if (returnMatch) {
          const ret = await prisma.returnRequest.findFirst({ where: { returnNumber: returnMatch }, select: { createdAt: true } });
          if (ret && ret.createdAt < RETIREMENT_BOUNDARY) cls = "A";
        }
      }
      const label = cls === "A" ? "permitted legacy fallback" : cls === "B" ? "TEST fixture" : "UNEXPECTED operational write";
      const line = `${a.createdAt.toISOString()}  ${a.reason} ${a.delta > 0 ? "+" : ""}${a.delta}  ${sku}  "${a.note ?? ""}"  → [${cls}] ${label}`;
      if (cls === "C") flag(`InventoryAdjustment ${a.id} — ${line}`);
      else if (cls === "B") { console.warn(`  [warn] ${line} — clean up leaked test fixtures`); }
      else info(line);
    }
  }

  // ── 3. new Inventory row mutations ───────────────────────────────────
  console.log("\n── Inventory row mutations since anchor ──");
  const touchedInv = await prisma.$queryRawUnsafe(
    `SELECT i."sku", i."quantity", i."reorderPoint", i."updatedAt"
     FROM "Inventory" i WHERE i."updatedAt" >= $1 ORDER BY i."updatedAt" ASC`,
    SINCE,
  ) as { sku: string; quantity: number; reorderPoint: number; updatedAt: Date }[];
  if (touchedInv.length === 0) {
    info("none — Inventory quantities / reorder points are frozen ✓");
  } else {
    for (const r of touchedInv) {
      const testFixture = TEST_SKU.test(r.sku);
      const line = `${new Date(r.updatedAt).toISOString()}  ${r.sku}  qty ${r.quantity} / reorder ${r.reorderPoint}`;
      // Could still be a legacy-fallback adjustStock — cross-check against §2 above.
      const hasFallbackIA = newIA.some((a) => a.inventory.sku === r.sku && ["CANCELLATION", "RETURN"].includes(a.reason));
      if (testFixture) console.warn(`  [warn] ${line} — test fixture`);
      else if (hasFallbackIA) info(`${line}  → paired with a permitted legacy-fallback InventoryAdjustment`);
      else flag(`Inventory ${r.sku} mutated with no permitted legacy-fallback pairing — ${line}`);
    }
  }

  // ── 4. OfferAdjustment operational ledger ────────────────────────────
  console.log("\n── OfferAdjustment operational ledger since anchor ──");
  const oa = await prisma.offerAdjustment.groupBy({
    by: ["reason"],
    where: { createdAt: { gte: SINCE }, reason: { not: "MIGRATION_OPENING" } },
    _count: true, _sum: { delta: true },
  });
  if (oa.length === 0) {
    info("no operational OfferAdjustment rows yet — 0 real sales / adjustments in the window");
  } else {
    for (const g of oa) info(`${g.reason}: ${g._count} row(s), Σδ ${g._sum.delta ?? 0}`);
  }
  const openingCount = await prisma.offerAdjustment.count({ where: { reason: "MIGRATION_OPENING" } });
  info(`(MIGRATION_OPENING backfill rows: ${openingCount} — excluded from history + from this ledger view)`);

  // ── 5. OfferInventory chain integrity (the operational authority) ────
  console.log("\n── OfferInventory chain integrity ──");
  const chains = await prisma.$queryRawUnsafe(
    `SELECT oi."id", oi."quantity",
            (SELECT "previousQuantity" FROM "OfferAdjustment" a WHERE a."offerInventoryId"=oi."id" ORDER BY a."createdAt" ASC, a."id" ASC LIMIT 1) AS opening,
            COALESCE((SELECT SUM("delta") FROM "OfferAdjustment" a WHERE a."offerInventoryId"=oi."id"),0)::int AS sd,
            (SELECT COUNT(*) FROM "OfferAdjustment" a WHERE a."offerInventoryId"=oi."id")::int AS n
     FROM "OfferInventory" oi
     JOIN "Offer" o ON o.id = oi."offerId" JOIN "Seller" s ON s.id = o."sellerId"
     WHERE s.type = 'FIRST_PARTY' AND o.condition = 'NEW'`,
  ) as { id: string; quantity: number; opening: number | null; sd: number; n: number }[];
  let broken = 0;
  for (const c of chains) { if (c.n > 0 && (c.opening ?? 0) + c.sd !== c.quantity) broken++; }
  if (broken === 0) info(`opening + Σ OfferAdjustment.delta == quantity for all ${chains.length} FIRST_PARTY offers ✓`);
  else flag(`${broken} OfferInventory chain(s) do NOT reconcile`);

  const neg = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM "OfferInventory" WHERE "quantity" < 0 OR "quantity" < "reserved" OR "reserved" < 0`,
  ) as { n: number }[];
  if (neg[0].n === 0) info("no negative / invalid OfferInventory rows ✓");
  else flag(`${neg[0].n} negative / invalid OfferInventory rows`);

  // ── 6. baseline counts ──────────────────────────────────────────────
  console.log("\n── baseline counts ──");
  const c = {
    orders: await prisma.order.count(),
    activeVariants: await prisma.variant.count({ where: { status: "ACTIVE" } }),
    inventory: await prisma.inventory.count(),
    offerInventory: await prisma.offerInventory.count(),
    offerAdjustments: await prisma.offerAdjustment.count(),
    inventoryAdjustments: await prisma.inventoryAdjustment.count(),
    payments: await prisma.payment.count(),
    webhookEvents: await prisma.webhookEvent.count(),
  };
  info(JSON.stringify(c));
  const gate = await prisma.storeSetting.findUnique({ where: { key: "marketplace.multiSellerCheckout" } });
  info(`marketplace.multiSellerCheckout = ${gate?.value ?? "<absent>"}`);

  console.log(`\n  ${fail === 0 ? "OBSERVATION OK — CONTINUE OBSERVATION" : `${fail} HARD-STOP condition(s) — STOP AND INVESTIGATE`}`);
  if (fail > 0) process.exitCode = 1;
}

run().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
