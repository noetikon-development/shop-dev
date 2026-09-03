/**
 * Phase 9E-1 — CartItem.offerId reconciliation gate.
 *
 * Read-only. Verifies the marketplace offer-binding foundation is coherent:
 *   1. schema  — offerId column (nullable) + FK (SET NULL) + index all present;
 *                @@unique([cartId, variantId]) UNCHANGED
 *   2. binding — every non-null CartItem.offerId points to a real Offer for the
 *                SAME variantId, owned by a FIRST_PARTY APPROVED seller
 *   3. coverage— a CartItem's offerId is NULL iff its variant has no
 *                buy-box-eligible offer (same rule as the storefront)
 *   4. safety  — no THIRD_PARTY ACTIVE offer exists
 *   5. immutability — Order / OrderItem / Inventory / OfferInventory / Seller
 *                row counts unchanged vs the 9D regression baseline
 *
 * Exit 1 on any mismatch. Run before every deploy of 9E-1.
 *
 *   node --env-file=.env --import tsx scripts/reconcile-cartitem-offer-9e1.ts
 */
import { PrismaClient } from "@prisma/client";
import { resolveWinningOfferView } from "../src/lib/marketplace/buy-box-rule";
import type { FullOfferCandidate } from "../src/lib/marketplace/types";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    fail++;
    console.error(`  [FAIL] ${name}   ${detail}`);
  }
};

type OfferRow = {
  id: string;
  status: string;
  price: number;
  compareAtPrice: number | null;
  createdAt: Date;
  seller: { type: string; status: string };
  inventory: { quantity: number; reserved: number; reorderPoint: number } | null;
};
const toCand = (o: OfferRow): FullOfferCandidate => ({
  offerId: o.id,
  sellerId: "",
  sellerType: o.seller.type === "FIRST_PARTY" ? "FIRST_PARTY" : "THIRD_PARTY",
  sellerStatus: o.seller.status as FullOfferCandidate["sellerStatus"],
  offerStatus: o.status as FullOfferCandidate["offerStatus"],
  available: Math.max(0, (o.inventory?.quantity ?? 0) - (o.inventory?.reserved ?? 0)),
  reorderPoint: o.inventory?.reorderPoint ?? 0,
  price: o.price,
  compareAtPrice: o.compareAtPrice,
  createdAt: o.createdAt,
});

async function run() {
  console.log("PHASE 9E-1 — CartItem.offerId reconciliation\n");

  // 1. schema ---------------------------------------------------------------
  const col = (await prisma.$queryRawUnsafe(
    `SELECT is_nullable, data_type FROM information_schema.columns WHERE table_name='CartItem' AND column_name='offerId'`,
  )) as { is_nullable: string; data_type: string }[];
  check("1  CartItem.offerId column exists, nullable, text", col[0]?.is_nullable === "YES" && col[0]?.data_type === "text");

  const fk = (await prisma.$queryRawUnsafe(
    `SELECT rc.delete_rule, ccu.table_name AS refs
     FROM information_schema.table_constraints tc
     JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name
     JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
     WHERE tc.table_name='CartItem' AND tc.constraint_name='CartItem_offerId_fkey'`,
  )) as { delete_rule: string; refs: string }[];
  check("1  FK CartItem.offerId → Offer.id, ON DELETE SET NULL", fk[0]?.delete_rule === "SET NULL" && fk[0]?.refs === "Offer");

  const idx = (await prisma.$queryRawUnsafe(
    `SELECT indexname FROM pg_indexes WHERE tablename='CartItem' AND indexname='CartItem_offerId_idx'`,
  )) as unknown[];
  check("1  index CartItem_offerId_idx exists", idx.length === 1);

  const uniq = (await prisma.$queryRawUnsafe(
    `SELECT indexdef FROM pg_indexes WHERE tablename='CartItem' AND indexname='CartItem_cartId_variantId_key'`,
  )) as { indexdef: string }[];
  check(
    "1  @@unique([cartId, variantId]) UNCHANGED",
    uniq.length === 1 && /\("?cartId"?,\s*"?variantId"?\)/.test(uniq[0].indexdef),
    uniq[0]?.indexdef,
  );

  const cols = (await prisma.$queryRawUnsafe(
    `SELECT column_name FROM information_schema.columns WHERE table_name='CartItem' ORDER BY ordinal_position`,
  )) as { column_name: string }[];
  const names = cols.map((c) => c.column_name).sort().join(",");
  check(
    "1  CartItem columns = original 7 + offerId (nothing dropped/renamed)",
    names === ["cartId", "createdAt", "id", "offerId", "priceSnapshot", "quantity", "updatedAt", "variantId"].join(","),
    names,
  );

  // 4. safety -------------------------------------------------------------
  const activeOffers = await prisma.offer.findMany({
    where: { status: "ACTIVE" },
    select: { seller: { select: { type: true } } },
  });
  const thirdParty = activeOffers.filter((o) => o.seller.type !== "FIRST_PARTY").length;
  check("4  no THIRD_PARTY ACTIVE offer exists", thirdParty === 0, `found ${thirdParty}`);

  // 2 + 3. binding + coverage -------------------------------------------
  const items = await prisma.cartItem.findMany({
    select: {
      id: true,
      variantId: true,
      offerId: true,
      variant: {
        select: {
          offers: {
            select: {
              id: true,
              status: true,
              price: true,
              compareAtPrice: true,
              createdAt: true,
              sellerId: true,
              seller: { select: { type: true, status: true } },
              inventory: { select: { quantity: true, reserved: true, reorderPoint: true } },
            },
          },
        },
      },
    },
  });

  let boundOk = 0;
  let boundBad = 0;
  let coverageOk = 0;
  let coverageBad = 0;
  for (const it of items) {
    const win = resolveWinningOfferView(it.variant.offers.map((o) => toCand(o as OfferRow)));
    const expected = win?.offerId ?? null;

    if (it.offerId != null) {
      const bound = it.variant.offers.find((o) => o.id === it.offerId);
      const okBinding = !!bound && bound.seller.type === "FIRST_PARTY" && bound.seller.status === "APPROVED";
      if (okBinding) boundOk++;
      else {
        boundBad++;
        console.error(`     bad binding ${it.id}: offerId=${it.offerId}`);
      }
    }
    // coverage: NULL iff no eligible offer (offerId may legitimately equal the
    // current winner OR a still-valid earlier winner — 9E-1 does not re-pick;
    // for the current 1P catalogue there is exactly one offer per variant, so
    // stored == expected).
    const coverageMatch = (it.offerId == null) === (expected == null);
    if (coverageMatch) coverageOk++;
    else {
      coverageBad++;
      console.error(`     coverage mismatch ${it.id}: stored=${it.offerId} expected=${expected}`);
    }
  }
  check(`2  every non-null offerId → real FIRST_PARTY/APPROVED Offer for the same variant (${boundOk} ok)`, boundBad === 0);
  check(`3  offerId NULL iff no buy-box-eligible offer (${coverageOk}/${items.length})`, coverageBad === 0);

  // For the current 1P catalogue, stored offerId should equal the live winner.
  let exactWinner = 0;
  for (const it of items) {
    const win = resolveWinningOfferView(it.variant.offers.map((o) => toCand(o as OfferRow)));
    if ((it.offerId ?? null) === (win?.offerId ?? null)) exactWinner++;
  }
  check(`3  stored offerId == live winning offer for all ${items.length} items (1P catalogue)`, exactWinner === items.length, `${exactWinner}/${items.length}`);

  // 5. immutability (counts vs the 9D-E regression baseline) -------------
  const counts = {
    products: await prisma.product.count(),
    variants: await prisma.variant.count(),
    inventory: await prisma.inventory.count(),
    offers: await prisma.offer.count(),
    offerInventory: await prisma.offerInventory.count(),
    sellers: await prisma.seller.count(),
    orders: await prisma.order.count(),
    orderItems: await prisma.orderItem.count(),
  };
  console.log(`\n  counts: ${JSON.stringify(counts)}`);
  check("5  Seller count == 1 (Axiaro only)", counts.sellers === 1);
  check("5  Offer count == 328 (9C baseline)", counts.offers === 328);
  check("5  OfferInventory count == 328", counts.offerInventory === 328);
  check("5  Inventory count == 328", counts.inventory === 328);
  check("5  Order / OrderItem untouched (3 seed orders, 3 items — 9D baseline)", counts.orders === 3 && counts.orderItems === 3, JSON.stringify({ o: counts.orders, i: counts.orderItems }));

  console.log(`\n  ${pass} passed, ${fail} failed.`);
  if (fail > 0) {
    console.error("\nRECONCILIATION FAILED.");
    process.exitCode = 1;
  } else {
    console.log("\nRECONCILIATION PASSED — offerId binding is coherent, additive, and 1P-safe.");
  }
}

run()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
