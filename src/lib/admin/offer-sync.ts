import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * 1P Offer write-through (Phase 9D-A).
 *
 * The product-card selling price now reads the Axiaro FIRST_PARTY `Offer`
 * (`src/lib/data.ts` `toCard`, `src/lib/wishlist.ts`). `Offer.price` was a frozen
 * 9C copy of `Variant.price`, so the existing admin catalogue write paths must
 * keep the matching 1P offer in step — otherwise a price edit would leave the
 * storefront showing the stale copy.
 *
 * This is ONE-WAY transitional sync only:  admin write → Variant/Product → 1P Offer.
 * It never makes `Offer` the source of truth, never touches `Inventory` /
 * `Variant.stock` / `src/lib/inventory.ts`, and never touches a THIRD_PARTY offer
 * (ownership is pinned to the FIRST_PARTY seller id).
 *
 * `OfferInventory` is created alongside a new offer (quantity copied from the
 * new `Inventory` row, which is 0 at creation) purely to keep the 9C 1:1
 * invariant intact. Stock changes are NOT synced here — that is a later slice.
 */

type Tx = Prisma.TransactionClient | typeof prisma;

/** The Axiaro FIRST_PARTY seller id (one row, enforced unique by a partial index). */
export async function firstPartySellerId(tx: Tx = prisma): Promise<string | null> {
  const seller = await tx.seller.findFirst({
    where: { type: "FIRST_PARTY" },
    select: { id: true },
  });
  return seller?.id ?? null;
}

/**
 * Push the current commercial values of a Variant onto its Axiaro FIRST_PARTY
 * offer (NEW condition). No-op when the 1P seller or the offer is missing —
 * `ensureFirstPartyOffer` covers creation.
 */
export async function syncFirstPartyOfferPrice(
  variantId: string,
  data: { price: number; compareAtPrice: number | null },
  tx: Tx = prisma,
): Promise<void> {
  const sellerId = await firstPartySellerId(tx);
  if (!sellerId) return;
  await tx.offer.updateMany({
    where: { variantId, sellerId, condition: "NEW" },
    data: { price: data.price, compareAtPrice: data.compareAtPrice },
  });
}

/**
 * Create the Axiaro FIRST_PARTY offer (+ its OfferInventory + opening
 * OfferAdjustment) for a newly-created Variant, if it does not already exist.
 * Safe to call inside the same transaction that created the Variant + Inventory.
 */
export async function ensureFirstPartyOffer(
  variant: {
    id: string;
    sku: string;
    price: number;
    compareAtPrice: number | null;
  },
  opts: { productStatus: string; costPrice: number | null },
  tx: Tx = prisma,
): Promise<void> {
  const sellerId = await firstPartySellerId(tx);
  if (!sellerId) return;

  const existing = await tx.offer.findUnique({
    where: {
      sellerId_variantId_condition: { sellerId, variantId: variant.id, condition: "NEW" },
    },
    select: { id: true, inventory: { select: { id: true } } },
  });

  let offerId = existing?.id ?? null;
  if (!offerId) {
    const created = await tx.offer.create({
      data: {
        sellerId,
        variantId: variant.id,
        price: variant.price,
        compareAtPrice: variant.compareAtPrice,
        costPrice: opts.costPrice,
        sellerSku: variant.sku,
        condition: "NEW",
        status: opts.productStatus === "ACTIVE" ? "ACTIVE" : "DRAFT",
        fulfillmentType: "SELLER_FULFILLED",
        handlingTimeDays: 2,
      },
      select: { id: true },
    });
    offerId = created.id;
  }

  if (!existing?.inventory) {
    // Copy the just-created Inventory row (quantity is 0 at creation).
    const inv = await tx.inventory.findUnique({
      where: { variantId: variant.id },
      select: { quantity: true, reserved: true, reorderPoint: true, restockEta: true, sku: true },
    });
    const created = await tx.offerInventory.create({
      data: {
        offerId,
        sellerSku: inv?.sku ?? variant.sku,
        quantity: inv?.quantity ?? 0,
        reserved: inv?.reserved ?? 0,
        reorderPoint: inv?.reorderPoint ?? 3,
        restockEta: inv?.restockEta ?? null,
      },
      select: { id: true, quantity: true },
    });
    await tx.offerAdjustment.create({
      data: {
        offerInventoryId: created.id,
        previousQuantity: 0,
        delta: created.quantity,
        newQuantity: created.quantity,
        reason: "MIGRATION_OPENING",
        note: "Phase 9D-A — opening balance for an admin-created variant.",
        actorUserId: null,
      },
    });
  }
}
