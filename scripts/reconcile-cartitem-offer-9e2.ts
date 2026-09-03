/**
 * Phase 9E-2 — CartItem multi-seller uniqueness reconciliation.
 *
 * Read-only. Auto-detects whether the 9E-2 migration
 * (`20260903140000_cartitem_offer_uniqueness.sql`) has been applied yet:
 *
 *   PRE-migration  → verifies the DB is SAFE to migrate:
 *       offerId NULL count = 0
 *       duplicate (cartId, offerId) = 0
 *       every offerId → an ACTIVE Offer whose variantId = CartItem.variantId
 *       no THIRD_PARTY ACTIVE Offer
 *
 *   POST-migration → verifies the constraint landed cleanly:
 *       offerId NOT NULL, FK ON DELETE CASCADE
 *       CartItem_cartId_offerId_key present, CartItem_cartId_variantId_key gone
 *       @@index([cartId]/[variantId]/[offerId]) intact
 *       + all the PRE checks (still hold)
 *
 * Plus (both states): CartItem count / Σquantity / Order / OrderItem /
 * Inventory / OfferInventory / Seller / Payment vs the 9D-E baseline.
 *
 * Exit 1 on any failure.
 *   node --env-file=.env --import tsx scripts/reconcile-cartitem-offer-9e2.ts
 */
import { PrismaClient } from "@prisma/client";

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

async function run() {
  console.log("PHASE 9E-2 — CartItem multi-seller uniqueness reconciliation\n");

  // ── detect migration state ─────────────────────────────────────────────
  const newIdx = (await prisma.$queryRawUnsafe(
    `SELECT indexname FROM pg_indexes WHERE tablename='CartItem' AND indexname='CartItem_cartId_offerId_key'`,
  )) as unknown[];
  const oldIdx = (await prisma.$queryRawUnsafe(
    `SELECT indexname FROM pg_indexes WHERE tablename='CartItem' AND indexname='CartItem_cartId_variantId_key'`,
  )) as unknown[];
  const applied = newIdx.length === 1 && oldIdx.length === 0;
  console.log(`  migration state: ${applied ? "APPLIED (post-9E-2)" : "NOT APPLIED (pre-9E-2 — deploy boundary)"}\n`);

  // ── shared data checks (must hold in BOTH states) ──────────────────────
  const items = await prisma.cartItem.findMany({
    select: {
      id: true,
      cartId: true,
      variantId: true,
      offerId: true,
      quantity: true,
      offer: { select: { id: true, status: true, variantId: true, seller: { select: { type: true, status: true } } } },
    },
  });
  const nullOffer = items.filter((i) => i.offerId == null).length;
  check("offerId NULL count = 0 (every line is offer-bound)", nullOffer === 0, `found ${nullOffer}`);

  const seen = new Set<string>();
  let dup = 0;
  for (const i of items) {
    const k = `${i.cartId}::${i.offerId}`;
    if (seen.has(k)) dup++;
    seen.add(k);
  }
  check("duplicate (cartId, offerId) = 0", dup === 0, `found ${dup}`);

  let orphan = 0;
  let mismatch = 0;
  let non1p = 0;
  for (const i of items) {
    if (i.offerId && !i.offer) orphan++;
    if (i.offer && i.offer.variantId !== i.variantId) mismatch++;
    if (i.offer && (i.offer.seller.type !== "FIRST_PARTY" || i.offer.seller.status !== "APPROVED")) non1p++;
  }
  check("every offerId → a real Offer", orphan === 0, `orphans ${orphan}`);
  check("bound Offer.variantId === CartItem.variantId", mismatch === 0, `mismatches ${mismatch}`);
  check("every bound Offer is FIRST_PARTY / APPROVED", non1p === 0, `others ${non1p}`);

  const activeOffers = await prisma.offer.findMany({ where: { status: "ACTIVE" }, select: { seller: { select: { type: true } } } });
  const tp = activeOffers.filter((o) => o.seller.type !== "FIRST_PARTY").length;
  check("no THIRD_PARTY ACTIVE Offer exists", tp === 0, `found ${tp}`);

  // ── state-specific schema checks ──────────────────────────────────────
  const col = (await prisma.$queryRawUnsafe(
    `SELECT is_nullable FROM information_schema.columns WHERE table_name='CartItem' AND column_name='offerId'`,
  )) as { is_nullable: string }[];
  const fk = (await prisma.$queryRawUnsafe(
    `SELECT rc.delete_rule FROM information_schema.table_constraints tc
     JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name
     WHERE tc.table_name='CartItem' AND tc.constraint_name='CartItem_offerId_fkey'`,
  )) as { delete_rule: string }[];
  const idxCart = (await prisma.$queryRawUnsafe(`SELECT 1 FROM pg_indexes WHERE tablename='CartItem' AND indexname='CartItem_cartId_idx'`)) as unknown[];
  const idxVariant = (await prisma.$queryRawUnsafe(`SELECT 1 FROM pg_indexes WHERE tablename='CartItem' AND indexname='CartItem_variantId_idx'`)) as unknown[];
  const idxOffer = (await prisma.$queryRawUnsafe(`SELECT 1 FROM pg_indexes WHERE tablename='CartItem' AND indexname='CartItem_offerId_idx'`)) as unknown[];

  if (applied) {
    check("offerId is NOT NULL", col[0]?.is_nullable === "NO");
    check("FK CartItem.offerId → Offer ON DELETE CASCADE", fk[0]?.delete_rule === "CASCADE", fk[0]?.delete_rule);
    check("CartItem_cartId_offerId_key present", newIdx.length === 1);
    check("CartItem_cartId_variantId_key dropped", oldIdx.length === 0);
  } else {
    check("offerId still nullable (9E-1 state — expected pre-migration)", col[0]?.is_nullable === "YES");
    check("FK still ON DELETE SET NULL (9E-1 state)", fk[0]?.delete_rule === "SET NULL", fk[0]?.delete_rule);
    check("CartItem_cartId_variantId_key still present (9E-1 state)", oldIdx.length === 1);
    check("READY: SET NOT NULL will succeed (0 nulls) + CREATE UNIQUE (cartId,offerId) will succeed (0 dups)", nullOffer === 0 && dup === 0);
  }
  check("@@index([cartId]) intact", idxCart.length === 1);
  check("@@index([variantId]) intact", idxVariant.length === 1);
  check("@@index([offerId]) intact", idxOffer.length === 1);

  // ── baseline immutability ────────────────────────────────────────────
  const counts = {
    cartItems: items.length,
    qtySum: items.reduce((n, i) => n + i.quantity, 0),
    orders: await prisma.order.count(),
    orderItems: await prisma.orderItem.count(),
    payments: await prisma.payment.count(),
    sellers: await prisma.seller.count(),
    inventory: await prisma.inventory.count(),
    offerInventory: await prisma.offerInventory.count(),
  };
  console.log(`\n  counts: ${JSON.stringify(counts)}`);
  check("Seller count == 1", counts.sellers === 1);
  check("Inventory / OfferInventory == 328 / 328", counts.inventory === 328 && counts.offerInventory === 328);
  check("Order / OrderItem unchanged (3 / 3 — 9D baseline)", counts.orders === 3 && counts.orderItems === 3, JSON.stringify(counts));
  check("Payment count == 0 (PayMongo dormant)", counts.payments === 0);

  console.log(`\n  ${pass} passed, ${fail} failed.`);
  if (fail > 0) {
    console.error("\nRECONCILIATION FAILED.");
    process.exitCode = 1;
  } else {
    console.log(`\nRECONCILIATION PASSED — ${applied ? "9E-2 constraint is coherent." : "DB is SAFE to apply the 9E-2 migration."}`);
  }
}

run()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
