/**
 * Phase 9C — marketplace foundation checks.
 *
 * The project has no test framework; this is a standalone assertion runner in
 * the same style as the other scripts. Two parts:
 *
 *   A. PURE buy-box rule (fixtures, no DB) — categories 4-10.
 *   B. DB-backed isolation + uniqueness — categories 1-3, 11-13. All DB writes
 *      happen inside ONE interactive transaction that is rolled back at the end,
 *      so nothing is persisted. Requires the schema + the
 *      20260903120000_marketplace_offer_foundation.sql constraints to be applied.
 *
 * Run:  npm run db:test:marketplace
 *       (node --env-file=.env --conditions=react-server --import tsx …)
 */
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { pickWinningOffer, rankOffers } from "../src/lib/marketplace/buy-box-rule";
import {
  listSellerOffers,
  getOfferForSeller,
  adjustOfferStock,
} from "../src/lib/marketplace/seller-repository";
import type { OfferCandidate, SellerContext } from "../src/lib/marketplace/types";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}   ${detail}`);
  }
}

const D = (iso: string) => new Date(iso);
function cand(over: Partial<OfferCandidate>): OfferCandidate {
  return {
    offerId: "o" + Math.random().toString(36).slice(2, 8),
    sellerId: "s1",
    sellerType: "THIRD_PARTY",
    sellerStatus: "APPROVED",
    offerStatus: "ACTIVE",
    available: 5,
    price: 1000,
    createdAt: D("2026-01-01T00:00:00Z"),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// A. Pure buy-box rule
// ---------------------------------------------------------------------------
function pureTests() {
  console.log("\nA. Pure buy-box rule");

  // 4. active/inactive offer resolution
  {
    const draft = cand({ offerStatus: "DRAFT", price: 500 });
    const active = cand({ offerStatus: "ACTIVE", price: 900 });
    const w = pickWinningOffer([draft, active]);
    ok("4  inactive/DRAFT offer never wins", w?.offerId === active.offerId, `got ${w?.offerId}`);
    ok("4  ARCHIVED/INACTIVE excluded", pickWinningOffer([cand({ offerStatus: "INACTIVE" }), cand({ offerStatus: "ARCHIVED" })]) === null);
  }

  // 5. approved/suspended seller filtering
  {
    const suspended = cand({ sellerStatus: "SUSPENDED", price: 100 });
    const approved = cand({ sellerStatus: "APPROVED", price: 800 });
    const w = pickWinningOffer([suspended, approved]);
    ok("5  suspended seller's offer never wins", w?.offerId === approved.offerId, `got ${w?.offerId}`);
    ok("5  PENDING/CLOSED seller excluded", pickWinningOffer([cand({ sellerStatus: "PENDING" }), cand({ sellerStatus: "CLOSED" })]) === null);
  }

  // 6. stock availability
  {
    const zero = cand({ available: 0, price: 100 });
    const stocked = cand({ available: 1, price: 700 });
    const w = pickWinningOffer([zero, stocked]);
    ok("6  out-of-stock offer never wins", w?.offerId === stocked.offerId, `got ${w?.offerId}`);
    ok("6  negative available excluded", pickWinningOffer([cand({ available: -3 })]) === null);
  }

  // 7. lowest-price selection
  {
    const a = cand({ price: 1500 });
    const b = cand({ price: 999 });
    const c = cand({ price: 1200 });
    ok("7  lowest price wins", pickWinningOffer([a, b, c])?.offerId === b.offerId);
  }

  // 8. FIRST_PARTY tie-break on equal price
  {
    const tp = cand({ sellerType: "THIRD_PARTY", price: 1000, createdAt: D("2025-01-01T00:00:00Z") });
    const fp = cand({ sellerType: "FIRST_PARTY", price: 1000, createdAt: D("2026-06-01T00:00:00Z") });
    ok("8  FIRST_PARTY wins a price tie (even if newer)", pickWinningOffer([tp, fp])?.offerId === fp.offerId);
  }

  // 9. deterministic createdAt tie-break
  {
    const older = cand({ price: 1000, sellerType: "THIRD_PARTY", createdAt: D("2026-01-01T00:00:00Z") });
    const newer = cand({ price: 1000, sellerType: "THIRD_PARTY", createdAt: D("2026-05-01T00:00:00Z") });
    ok("9  oldest offer wins a price+type tie", pickWinningOffer([newer, older])?.offerId === older.offerId);
    // order-independence
    const r1 = rankOffers([newer, older]).map((c) => c.offerId).join(",");
    const r2 = rankOffers([older, newer]).map((c) => c.offerId).join(",");
    ok("9  ranking is input-order-independent", r1 === r2, `${r1} vs ${r2}`);
  }

  // 10. null when no eligible offer
  {
    ok("10 empty input → null", pickWinningOffer([]) === null);
    ok("10 all ineligible → null", pickWinningOffer([cand({ offerStatus: "DRAFT" }), cand({ available: 0 }), cand({ sellerStatus: "SUSPENDED" })]) === null);
  }
}

// ---------------------------------------------------------------------------
// B. DB-backed isolation + uniqueness (all inside a rolled-back transaction)
// ---------------------------------------------------------------------------
class Rollback extends Error {}

async function dbTests(prisma: PrismaClient) {
  console.log("\nB. DB-backed isolation + uniqueness");

  // ---- Uniqueness constraints (DDL existence — a schema fact) ----------
  // Triggering a live unique violation inside a shared interactive transaction
  // poisons the rest of it (Postgres aborts the block), so the constraints are
  // verified by asserting the indexes exist — the same approach the
  // reconciliation script uses.
  const idxRows = await prisma.$queryRaw<{ indexname: string; indexdef: string }[]>`
    SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename IN ('Seller', 'Offer', 'OfferInventory')`;
  const idx = new Map(idxRows.map((r) => [r.indexname, r.indexdef]));
  ok(
    "1  Seller: partial UNIQUE index on type='FIRST_PARTY' exists",
    /UNIQUE/i.test(idx.get("seller_one_first_party") ?? "") &&
      /FIRST_PARTY/i.test(idx.get("seller_one_first_party") ?? ""),
    idx.get("seller_one_first_party") ?? "missing",
  );
  ok(
    "2  Offer: UNIQUE(sellerId, variantId, condition) exists",
    /UNIQUE/i.test(idx.get("Offer_sellerId_variantId_condition_key") ?? ""),
    idx.get("Offer_sellerId_variantId_condition_key") ?? "missing",
  );
  ok(
    "2  Offer: UNIQUE(sellerId, sellerSku) exists",
    /UNIQUE/i.test(idx.get("Offer_sellerId_sellerSku_key") ?? ""),
    idx.get("Offer_sellerId_sellerSku_key") ?? "missing",
  );
  ok(
    "3  OfferInventory: UNIQUE(offerId) exists",
    /UNIQUE/i.test(idx.get("OfferInventory_offerId_key") ?? ""),
    idx.get("OfferInventory_offerId_key") ?? "missing",
  );

  // ---- Seller-scoped isolation (real rows, rolled back) ---------------
  const variant = await prisma.variant.findFirst({ where: { status: "ACTIVE" }, select: { id: true } });
  if (!variant) {
    ok("B  (isolation skipped — no ACTIVE variant to test against)", true);
    return;
  }
  const suffix = "test9c-" + Date.now();

  try {
    await prisma.$transaction(async (tx) => {
      const sellerA = await tx.seller.create({
        data: { type: "THIRD_PARTY", status: "APPROVED", displayName: "Test A", slug: `a-${suffix}`, supportEmail: "a@example.test" },
      });
      const sellerB = await tx.seller.create({
        data: { type: "THIRD_PARTY", status: "APPROVED", displayName: "Test B", slug: `b-${suffix}`, supportEmail: "b@example.test" },
      });
      const offerA = await tx.offer.create({
        data: { sellerId: sellerA.id, variantId: variant.id, price: 1000, condition: "NEW", status: "ACTIVE", sellerSku: `A-${suffix}` },
      });
      await tx.offerInventory.create({ data: { offerId: offerA.id, quantity: 5, reserved: 0, reorderPoint: 2 } });
      const offerB = await tx.offer.create({
        data: { sellerId: sellerB.id, variantId: variant.id, price: 900, condition: "NEW", status: "ACTIVE", sellerSku: `B-${suffix}` },
      });
      await tx.offerInventory.create({ data: { offerId: offerB.id, quantity: 20, reserved: 0, reorderPoint: 2 } });

      const ctxA: SellerContext = {
        sellerId: sellerA.id,
        sellerName: "Test A",
        sellerUserId: "x",
        userId: "test-user",
        role: "OWNER",
        permissions: new Set(),
      };

      const aOwn = await getOfferForSeller(ctxA, offerA.id, tx);
      ok("11 getOfferForSeller returns the seller's own offer", aOwn?.id === offerA.id);

      const aSeesB = await getOfferForSeller(ctxA, offerB.id, tx);
      ok("12 getOfferForSeller(ctxA, offerB) → null (cross-seller)", aSeesB === null, `got ${aSeesB?.id}`);

      const listA = await listSellerOffers(ctxA, {}, tx);
      ok("12 listSellerOffers(ctxA) contains own offer", listA.some((o) => o.id === offerA.id));
      ok("13 listSellerOffers(ctxA) excludes Seller B's offer", !listA.some((o) => o.id === offerB.id));

      // cross-seller write rejected (returns an error, never throws → no poison)
      const crossWrite = await adjustOfferStock(ctxA, offerB.id, -1, "TEST", null, tx);
      ok("13 adjustOfferStock(ctxA, offerB) rejected NOT_FOUND",
        crossWrite.ok === false && crossWrite.code === "NOT_FOUND", JSON.stringify(crossWrite));

      const okWrite = await adjustOfferStock(ctxA, offerA.id, -2, "TEST", null, tx);
      ok("12 adjustOfferStock(ctxA, offerA, -2) ok → 3",
        okWrite.ok === true && okWrite.newQuantity === 3, JSON.stringify(okWrite));

      const belowZero = await adjustOfferStock(ctxA, offerA.id, -9999, "TEST", null, tx);
      ok("12 adjustOfferStock below zero → INVARIANT",
        belowZero.ok === false && belowZero.code === "INVARIANT", JSON.stringify(belowZero));

      const adjRows = await tx.offerAdjustment.count({ where: { offerInventory: { offer: { sellerId: sellerA.id } } } });
      ok("12 own adjustment recorded on OfferAdjustment", adjRows === 1, `rows ${adjRows}`);

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  const leaked = await prisma.seller.count({ where: { slug: { contains: suffix } } });
  ok("B  isolation test rows rolled back (0 leaked sellers)", leaked === 0, `leaked ${leaked}`);
}

export async function runTests(prisma: PrismaClient) {
  pureTests();
  await dbTests(prisma);
  console.log(`\n  ${passed} passed, ${failed} failed.`);
  if (failed > 0) throw new Error(`${failed} marketplace-foundation check(s) failed.`);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });
  runTests(prisma)
    .then(() => console.log("All marketplace-foundation checks passed."))
    .catch((e) => {
      console.error(e.message ?? e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
