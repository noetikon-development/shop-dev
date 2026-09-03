import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * FIRST_PARTY (Axiaro) operational inventory read layer — Phase 9E-3D-2.
 *
 * `OfferInventory`, reached through the Axiaro FIRST_PARTY `Offer` (condition
 * `NEW`, 1:1 with a Variant), is the AUTHORITATIVE operational store for
 * Axiaro's own stock. `Inventory` + `Variant.stock` are synchronized
 * compatibility mirrors — every 1P mutation still writes them (checkout
 * 9E-3C-2, cancellation / return 9E-3D-1, admin adjustments 9D-D), so the
 * legacy `InventoryAdjustment` history stays complete and continuous.
 *
 * These readers resolve the FIRST_PARTY offer DIRECTLY, never the buy-box
 * winner: the admin inventory screens are about Axiaro's own stock position,
 * a fixed per-seller fact, not a price competition. THIRD_PARTY offer
 * inventory is never returned here.
 *
 * Writes stay where they are — `src/lib/inventory.ts` (row-locked `Inventory`)
 * mirrored to `OfferInventory` via `src/lib/admin/offer-sync.ts`, lock order
 * OfferInventory-then-Inventory (9E-3D-1). This module is READ-ONLY.
 */

/**
 * Prisma relation-filter that pins an `OfferInventory` / `OfferAdjustment`
 * query to the Axiaro FIRST_PARTY, condition-NEW offer. Compose into a larger
 * `where` on `offer: { ... }`.
 */
export const FIRST_PARTY_OFFER_FILTER = {
  seller: { is: { type: "FIRST_PARTY" } },
  condition: "NEW",
} satisfies Prisma.OfferWhereInput;

/** Shape returned by {@link getFirstPartyStock} — the operational current state. */
export type FirstPartyStock = {
  offerInventoryId: string;
  variantId: string;
  productName: string;
  quantity: number;
  reserved: number;
  reorderPoint: number;
  updatedAt: Date;
};

/**
 * Current operational stock for one variant, from its Axiaro FIRST_PARTY
 * `OfferInventory`. `null` when the variant has no FIRST_PARTY NEW offer
 * (only possible for a pre-9C gap — `ensureFirstPartyOffer` covers creation).
 */
export async function getFirstPartyStock(
  variantId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<FirstPartyStock | null> {
  const oi = await client.offerInventory.findFirst({
    where: { offer: { variantId, ...FIRST_PARTY_OFFER_FILTER } },
    select: {
      id: true,
      quantity: true,
      reserved: true,
      reorderPoint: true,
      updatedAt: true,
      offer: { select: { variantId: true, variant: { select: { product: { select: { name: true } } } } } },
    },
  });
  if (!oi) return null;
  return {
    offerInventoryId: oi.id,
    variantId: oi.offer.variantId,
    productName: oi.offer.variant.product.name,
    quantity: oi.quantity,
    reserved: oi.reserved,
    reorderPoint: oi.reorderPoint,
    updatedAt: oi.updatedAt,
  };
}
