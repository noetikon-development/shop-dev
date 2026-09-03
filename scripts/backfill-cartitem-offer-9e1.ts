/**
 * Phase 9E-1 — backfill CartItem.offerId (the marketplace offer-binding
 * foundation).
 *
 * For every existing CartItem, resolve the current winning Offer for its
 * Variant with the SAME deterministic buy-box rule the storefront uses
 * (`resolveWinningOfferView`) and record it on `CartItem.offerId`. Leaves
 * `offerId` NULL when no Offer is ACTIVE + APPROVED-seller + in stock.
 *
 * NEVER touches: Variant, priceSnapshot, quantity, cart status, Order,
 * OrderItem, Inventory, OfferInventory, Seller. NEVER deletes a CartItem.
 * Additive, idempotent, reversible.
 *
 *   node --env-file=.env --import tsx scripts/backfill-cartitem-offer-9e1.ts --dry-run
 *   node --env-file=.env --import tsx scripts/backfill-cartitem-offer-9e1.ts
 *   node --env-file=.env --import tsx scripts/backfill-cartitem-offer-9e1.ts --revert
 *
 * dev + prod share ONE database — treat every non-dry-run as production-impacting.
 */
import { PrismaClient } from "@prisma/client";
import { resolveWinningOfferView } from "../src/lib/marketplace/buy-box-rule";
import type { FullOfferCandidate } from "../src/lib/marketplace/types";

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL,
});

const DRY_RUN = process.argv.includes("--dry-run");
const REVERT = process.argv.includes("--revert");

class BackfillStop extends Error {}

type OfferRow = {
  id: string;
  status: string;
  price: number;
  compareAtPrice: number | null;
  createdAt: Date;
  seller: { type: string; status: string };
  inventory: { quantity: number; reserved: number; reorderPoint: number } | null;
};

function toCandidate(o: OfferRow): FullOfferCandidate {
  return {
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
  };
}

// ---------------------------------------------------------------------------
// §17 — current 1P safety. Every ACTIVE offer must belong to Axiaro FIRST_PARTY.
// ---------------------------------------------------------------------------
async function assertFirstPartyOnly() {
  const byType = await prisma.offer.groupBy({
    by: ["status"],
    where: { status: "ACTIVE" },
    _count: { _all: true },
  });
  const totalActive = byType.reduce((n, r) => n + r._count._all, 0);

  const activeOffers = await prisma.offer.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, seller: { select: { type: true } } },
  });
  const firstParty = activeOffers.filter((o) => o.seller.type === "FIRST_PARTY").length;
  const thirdParty = activeOffers.filter((o) => o.seller.type !== "FIRST_PARTY").length;

  console.log("§17 — active-offer seller split");
  console.log(`  TOTAL ACTIVE OFFERS       ${totalActive}`);
  console.log(`  FIRST_PARTY ACTIVE OFFERS ${firstParty}`);
  console.log(`  THIRD_PARTY ACTIVE OFFERS ${thirdParty}`);

  if (thirdParty > 0) {
    throw new BackfillStop(
      `${thirdParty} THIRD_PARTY ACTIVE Offer(s) exist — 9E-1 assumes a 1P-only catalogue. ` +
        `STOP: investigate before binding cart items. (No data was changed.)`,
    );
  }
  console.log("  → OK: 1P-only catalogue.\n");
}

// ---------------------------------------------------------------------------
async function loadCartItems() {
  return prisma.cartItem.findMany({
    select: {
      id: true,
      cartId: true,
      variantId: true,
      offerId: true,
      quantity: true,
      priceSnapshot: true,
      variant: {
        select: {
          offers: {
            select: {
              id: true,
              status: true,
              price: true,
              compareAtPrice: true,
              createdAt: true,
              seller: { select: { type: true, status: true } },
              inventory: { select: { quantity: true, reserved: true, reorderPoint: true } },
            },
          },
        },
      },
    },
  });
}

function resolveTarget(item: Awaited<ReturnType<typeof loadCartItems>>[number]): string | null {
  const win = resolveWinningOfferView(item.variant.offers.map((o) => toCandidate(o as OfferRow)));
  return win?.offerId ?? null;
}

// ---------------------------------------------------------------------------
async function revert() {
  console.log("PHASE 9E-1 BACKFILL — REVERT\n");
  const before = await prisma.cartItem.count({ where: { offerId: { not: null } } });
  console.log(`CartItems with a non-null offerId (before): ${before}`);
  if (DRY_RUN) {
    console.log("(--dry-run) would set offerId = NULL on all of them. No write.");
    return;
  }
  const res = await prisma.cartItem.updateMany({ data: { offerId: null } });
  const after = await prisma.cartItem.count({ where: { offerId: { not: null } } });
  console.log(`Cleared offerId on ${res.count} CartItem(s). Non-null offerId now: ${after}`);
  if (after !== 0) throw new BackfillStop("REVERT did not clear every offerId — investigate.");
  console.log("\nREVERT COMPLETE — no CartItem deleted, no other column touched.");
}

// ---------------------------------------------------------------------------
async function backfill() {
  console.log(`PHASE 9E-1 BACKFILL — ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE"}\n`);

  await assertFirstPartyOnly();

  // ── §6 — snapshot BEFORE ────────────────────────────────────────────────
  const items = await loadCartItems();
  const total = items.length;

  const preSums = {
    quantity: items.reduce((n, i) => n + i.quantity, 0),
    priceSnapshot: items.reduce((n, i) => n + i.priceSnapshot, 0),
  };

  let eligible = 0;
  let noOffer = 0;
  let alreadyBound = 0;
  const plan: { id: string; from: string | null; to: string | null }[] = [];

  for (const item of items) {
    const target = resolveTarget(item);
    if (target) eligible++;
    else noOffer++;
    if (item.offerId != null) alreadyBound++;
    if (item.offerId !== target) plan.push({ id: item.id, from: item.offerId, to: target });
  }

  console.log("§6 — BEFORE");
  console.log(`  TOTAL CART ITEMS                     ${total}`);
  console.log(`  ITEMS WITH ELIGIBLE OFFER            ${eligible}`);
  console.log(`  ITEMS WITHOUT ELIGIBLE OFFER         ${noOffer}`);
  console.log(`  ITEMS ALREADY ASSOCIATED WITH OFFER  ${alreadyBound}`);
  console.log(`  ROWS THAT WOULD CHANGE               ${plan.length}\n`);

  if (total === 0) {
    console.log("No CartItems — nothing to backfill. Done.");
    return;
  }

  if (DRY_RUN) {
    console.log("(--dry-run) — no rows written. Sample plan (first 10):");
    for (const p of plan.slice(0, 10)) console.log(`  ${p.id}: ${p.from ?? "NULL"} → ${p.to ?? "NULL"}`);
    return;
  }

  // ── apply, one row at a time, offerId ONLY ──────────────────────────────
  let backfilled = 0;
  let failed = 0;
  for (const p of plan) {
    try {
      await prisma.cartItem.update({ where: { id: p.id }, data: { offerId: p.to } });
      backfilled++;
    } catch (e) {
      failed++;
      console.error(`  FAILED ${p.id}: ${(e as Error).message}`);
      throw new BackfillStop(
        `Backfill aborted after ${backfilled} update(s), ${failed} failure(s). ` +
          `Partial state is committed row-by-row — re-run to resume (idempotent).`,
      );
    }
  }

  // ── §6 / §18 — snapshot AFTER + integrity ───────────────────────────────
  const after = await prisma.cartItem.findMany({
    select: { id: true, offerId: true, quantity: true, priceSnapshot: true, variantId: true },
  });
  const postSums = {
    quantity: after.reduce((n, i) => n + i.quantity, 0),
    priceSnapshot: after.reduce((n, i) => n + i.priceSnapshot, 0),
  };
  const nullOfferId = after.filter((i) => i.offerId == null).length;

  console.log("\n§6 — AFTER");
  console.log(`  BACKFILLED COUNT     ${backfilled}`);
  console.log(`  NULL offerId COUNT   ${nullOfferId}`);
  console.log(`  FAILED COUNT         ${failed}`);

  console.log("\n§18 — integrity");
  const rowCountOk = after.length === total;
  const qtyOk = postSums.quantity === preSums.quantity;
  const priceOk = postSums.priceSnapshot === preSums.priceSnapshot;
  const variantOk = after.every((a) => items.find((i) => i.id === a.id)?.variantId === a.variantId);
  console.log(`  A/F  CartItem row count unchanged      ${rowCountOk ? "OK" : "FAIL"} (${total} → ${after.length})`);
  console.log(`  D    Σ quantity unchanged              ${qtyOk ? "OK" : "FAIL"} (${preSums.quantity} → ${postSums.quantity})`);
  console.log(`  E    Σ priceSnapshot unchanged         ${priceOk ? "OK" : "FAIL"} (${preSums.priceSnapshot} → ${postSums.priceSnapshot})`);
  console.log(`  C    variantId unchanged on every row  ${variantOk ? "OK" : "FAIL"}`);
  console.log(`  B    no CartItem deleted               ${rowCountOk ? "OK" : "FAIL"}`);
  console.log(`  H    expected NULL offerId == "no eligible offer" count  ${nullOfferId === noOffer ? "OK" : "FAIL"} (${nullOfferId} vs ${noOffer})`);

  if (!rowCountOk || !qtyOk || !priceOk || !variantOk) {
    throw new BackfillStop("Post-backfill integrity check FAILED — investigate immediately.");
  }

  console.log("\nBACKFILL COMPLETE — offerId is the ONLY column written.");
}

// ---------------------------------------------------------------------------
(REVERT ? revert() : backfill())
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    if (e instanceof BackfillStop) {
      console.error(`\nSTOP: ${e.message}`);
    } else {
      console.error("\nUNEXPECTED ERROR — stopping, no further writes:", e);
    }
    await prisma.$disconnect();
    process.exit(1);
  });
