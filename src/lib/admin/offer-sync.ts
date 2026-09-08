import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { OFFER_CONDITIONS } from "@/lib/admin/catalog-schemas";

/**
 * FIRST_PARTY (Axiaro) admin inventory authority.
 *
 * Phase 9E-3D-6: the admin stock-adjustment and threshold paths write
 * `OfferInventory` ONLY. `syncFirstPartyOfferStock` / `syncFirstPartyOfferReorderPoint`
 * are the WHOLE write — they row-lock the single Axiaro FIRST_PARTY
 * `OfferInventory` (9F-23b: identified by seller alone, not condition — there is
 * exactly ONE FIRST_PARTY offer per variant; the raw-SQL locks assert that and
 * fail safely otherwise), mutate it, record an `OfferAdjustment` (stock only —
 * threshold changes carry no adjustment, mirroring the old `setReorderPoint`),
 * and re-derive `Variant.stock` DIRECTLY from `OfferInventory` (D-3: the column
 * retires with `Inventory` later). No `Inventory` row is read, locked or
 * written. A THIRD_PARTY offer is never touched.
 *
 * `syncFirstPartyOfferPrice` stays a ONE-WAY write-through: the catalog price
 * edit (`Variant.price`) still drives the 1P `Offer.price` copy (9D-A).
 *
 * SALE / CANCELLATION / RETURN movements live in `src/lib/marketplace/offer-inventory.ts`
 * (checkout / cancel / return — Phase 9E-3C-2 / 9E-3D-1 / 9E-3D-5); those paths
 * do NOT update `Variant.stock` (it is a transitional mirror until S7).
 */

type Tx = Prisma.TransactionClient | typeof prisma;

/**
 * A user-safe result. `error` is copy that MAY be shown to an admin verbatim
 * (matches the wording `src/lib/inventory.ts` used) — never an internal detail.
 */
export type OfferStockResult =
  | { ok: true; previousQuantity: number; newQuantity: number; reserved: number }
  | { ok: false; error: string };

/**
 * Re-derive `Variant.stock` (the denormalised AVAILABLE mirror) from the
 * Axiaro FIRST_PARTY `OfferInventory` — `max(0, quantity - reserved)`. Written
 * directly; no `Inventory` read. `Variant.stock` is read by nobody since 9D-D
 * and retires with `Inventory` (D-3); this keeps it coherent in the meantime.
 *
 * 9F-23b: the subquery is scoped to the FIRST_PARTY seller alone (one 1P offer
 * per variant). If the invariant were violated (>1 FIRST_PARTY offer) the
 * subquery raises "more than one row" and the caller's transaction rolls back —
 * a safe failure, never a silent arbitrary pick.
 */
export async function syncVariantStockFromFirstPartyOffer(
  variantId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "Variant" SET "stock" = GREATEST(0, COALESCE((
      SELECT oi."quantity" - oi."reserved"
      FROM "OfferInventory" oi
      JOIN "Offer" o ON o."id" = oi."offerId"
      JOIN "Seller" s ON s."id" = o."sellerId"
      WHERE o."variantId" = ${variantId} AND s."type" = 'FIRST_PARTY'
    ), 0))
    WHERE "id" = ${variantId}`;
}

/** The Axiaro FIRST_PARTY seller id (one row, enforced unique by a partial index). */
export async function firstPartySellerId(tx: Tx = prisma): Promise<string | null> {
  const seller = await tx.seller.findFirst({
    where: { type: "FIRST_PARTY" },
    select: { id: true },
  });
  return seller?.id ?? null;
}

/**
 * Push the current commercial values of a Variant onto its single Axiaro
 * FIRST_PARTY offer. No-op when the 1P seller or the offer is missing —
 * `ensureFirstPartyOffer` covers creation. 9F-23b: keyed on the FIRST_PARTY
 * seller alone (one 1P offer per variant); `updateMany` touches exactly that
 * one row, or zero.
 */
export async function syncFirstPartyOfferPrice(
  variantId: string,
  data: { price: number; compareAtPrice: number | null },
  tx: Tx = prisma,
): Promise<void> {
  const sellerId = await firstPartySellerId(tx);
  if (!sellerId) return;
  await tx.offer.updateMany({
    where: { variantId, sellerId },
    data: { price: data.price, compareAtPrice: data.compareAtPrice },
  });
}

/**
 * 9F-23b: row-lock (`FOR UPDATE`) the ONE Axiaro FIRST_PARTY `OfferInventory`
 * for a variant, identified by the seller alone (not condition). A THIRD_PARTY
 * offer on the same variant is never touched. `LIMIT 2` so a broken invariant
 * (>1 FIRST_PARTY offer) is detected and rejected rather than silently picking
 * an arbitrary row. Returns `{ ok:false, error }` for zero-offer or
 * multiple-offer — never throws for those; the caller surfaces `error`.
 */
async function lockFirstPartyOfferInventory(
  variantId: string,
  tx: Prisma.TransactionClient,
): Promise<
  | { ok: true; row: { id: string; quantity: number; reserved: number; reorderPoint: number } }
  | { ok: false; error: string }
> {
  const locked = await tx.$queryRaw<
    { id: string; quantity: number; reserved: number; reorderPoint: number }[]
  >`
    SELECT oi."id", oi."quantity", oi."reserved", oi."reorderPoint"
    FROM "OfferInventory" oi
    JOIN "Offer" o ON o."id" = oi."offerId"
    JOIN "Seller" s ON s."id" = o."sellerId"
    WHERE o."variantId" = ${variantId} AND s."type" = 'FIRST_PARTY'
    FOR UPDATE OF oi
    LIMIT 2`;
  if (locked.length === 0) return { ok: false, error: "No inventory record for that variant." };
  if (locked.length > 1) {
    return {
      ok: false,
      error: "This variant has more than one Axiaro listing — stock can’t be adjusted until that’s resolved.",
    };
  }
  return { ok: true, row: locked[0] };
}

/**
 * Apply a signed `delta` to the Axiaro FIRST_PARTY `OfferInventory` on-hand
 * quantity, record an `OfferAdjustment`, and re-derive `Variant.stock` — all
 * inside the caller's transaction. Phase 9E-3D-6: this is the WHOLE admin stock
 * write; no `Inventory` row is read, locked or written.
 *
 * Rejects (returns `{ ok:false }`, does NOT throw) a change that would take
 * quantity below 0 or below the currently reserved amount, or when the
 * one-FIRST_PARTY-offer-per-variant invariant is broken — the caller surfaces
 * `error` verbatim. Throws only on an unexpected DB failure.
 *
 * `reserved` is never changed here (admin stock adjustments only move on-hand
 * quantity — reservation state is owned by checkout).
 */
export async function syncFirstPartyOfferStock(
  variantId: string,
  delta: number,
  reason: string,
  note: string | null,
  actorUserId: string | null,
  tx: Prisma.TransactionClient,
): Promise<OfferStockResult> {
  const locked = await lockFirstPartyOfferInventory(variantId, tx);
  if (!locked.ok) return { ok: false, error: locked.error };
  const inv = locked.row;

  const previousQuantity = inv.quantity;
  const newQuantity = previousQuantity + delta;
  if (newQuantity < 0) {
    return { ok: false, error: "Stock can’t go below zero." };
  }
  if (newQuantity < inv.reserved) {
    return { ok: false, error: `Can’t reduce below the ${inv.reserved} unit(s) currently reserved.` };
  }

  if (delta !== 0) {
    await tx.offerInventory.update({ where: { id: inv.id }, data: { quantity: newQuantity } });
    await tx.offerAdjustment.create({
      data: {
        offerInventoryId: inv.id,
        previousQuantity,
        delta,
        newQuantity,
        reason,
        note: note?.trim() || null,
        actorUserId,
      },
    });
    await syncVariantStockFromFirstPartyOffer(variantId, tx);
  }

  return { ok: true, previousQuantity, newQuantity, reserved: inv.reserved };
}

/**
 * Set the Axiaro FIRST_PARTY `OfferInventory.reorderPoint`. Phase 9E-3D-6: the
 * WHOLE admin threshold write — no `Inventory.reorderPoint` update. No
 * `OfferAdjustment` (a threshold change is not a quantity change, matching the
 * old `setReorderPoint`). `Variant.stock` is unaffected (it is derived from
 * available, not the reorder point). 9F-23b: row-locks the one FIRST_PARTY
 * `OfferInventory` (seller anchor, fail-safe on 0 / >1).
 */
export async function syncFirstPartyOfferReorderPoint(
  variantId: string,
  reorderPoint: number,
  tx: Prisma.TransactionClient,
): Promise<{ ok: true; previous: number } | { ok: false; error: string }> {
  const locked = await lockFirstPartyOfferInventory(variantId, tx);
  if (!locked.ok) return { ok: false, error: locked.error };
  const inv = locked.row;
  await tx.offerInventory.update({ where: { id: inv.id }, data: { reorderPoint } });
  return { ok: true, previous: inv.reorderPoint };
}

/**
 * Create the Axiaro FIRST_PARTY offer (+ its OfferInventory + opening
 * OfferAdjustment) for a newly-created Variant, if it does not already exist.
 * Safe to call inside the same transaction that created the Variant + Inventory.
 *
 * 9F-23b: discovery is by `(sellerId, variantId)` — the one Axiaro offer for the
 * variant, whatever its condition. If it already exists this is a no-op for the
 * offer row (it NEVER creates a second 1P offer, and never overwrites an
 * existing condition). `opts.condition` sets the condition ONLY on a fresh
 * create and defaults to `"NEW"` — no caller passes it yet; it is the seam for
 * the later CMS control (9F-23c).
 */
export async function ensureFirstPartyOffer(
  variant: {
    id: string;
    sku: string;
    price: number;
    compareAtPrice: number | null;
  },
  opts: { productStatus: string; costPrice: number | null; condition?: string },
  tx: Tx = prisma,
): Promise<void> {
  const sellerId = await firstPartySellerId(tx);
  if (!sellerId) return;

  const existing = await tx.offer.findFirst({
    where: { sellerId, variantId: variant.id },
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
        condition: opts.condition ?? "NEW",
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

/**
 * 9F-25A (G5) — keep every Axiaro FIRST_PARTY `Offer.status` in step with the
 * catalog `Product.status`. `Product.status` is authoritative for its own 1P
 * offers:
 *
 *   ACTIVE   → FIRST_PARTY offers ACTIVE
 *   DRAFT    → FIRST_PARTY offers DRAFT
 *   ARCHIVED → FIRST_PARTY offers ARCHIVED
 *
 * Called by `setProductStatus` and `updateProduct` whenever the product status
 * changes. A single `updateMany` scoped to `seller.type = 'FIRST_PARTY'` and the
 * product's variants:
 *   - NEVER touches a THIRD_PARTY offer (a 3P seller on the same variant keeps
 *     its own status — that plane is `setSellerOfferStatus` / `adminSetOfferStatus`);
 *   - NEVER touches `Offer.id`, `OfferInventory`, price, condition, cost, SKU,
 *     `handlingTimeDays`, or any seller/variant relationship — only `status`;
 *   - NEVER creates an offer (drift where a variant has NO 1P offer is
 *     `ensureFirstPartyOffer`'s job, at variant-creation time);
 *   - is idempotent — `status: { not: target }` means an already-aligned offer
 *     is not rewritten, so re-running (or a no-status-change product save) is a
 *     zero-row no-op.
 *
 * Returns the number of 1P offers actually moved (0 when everything was already
 * aligned).
 */
export async function syncFirstPartyOfferStatusToProduct(
  productId: string,
  productStatus: string,
  tx: Tx = prisma,
): Promise<number> {
  const target =
    productStatus === "ACTIVE" ? "ACTIVE" : productStatus === "ARCHIVED" ? "ARCHIVED" : "DRAFT";
  const res = await tx.offer.updateMany({
    where: {
      variant: { is: { productId } },
      seller: { is: { type: "FIRST_PARTY" } },
      status: { not: target },
    },
    data: { status: target },
  });
  return res.count;
}

/**
 * 9F-23c — set the `condition` of the single Axiaro FIRST_PARTY Offer for a
 * variant, in place. This is the ONLY writer of a non-NEW condition onto a 1P
 * offer; it is driven by the CMS variant editor through `updateVariant`.
 *
 * Model B: ONE FIRST_PARTY offer per variant, condition an editable attribute.
 * The existing `Offer` row is UPDATEd — same `Offer.id`, same `OfferInventory`,
 * same `OfferAdjustment` history, same `CartItem.offerId` / `OrderItem.offerId`
 * bindings. Never creates a second offer; `@@unique([sellerId, variantId,
 * condition])` is untouched (there is only one 1P offer, so no collision).
 *
 * Guards (returns `{ ok:false, error }`, never throws for these — caller shows
 * `error` verbatim):
 *   - unknown condition value → rejected
 *   - zero FIRST_PARTY offer for the variant → safe failure
 *   - more than one FIRST_PARTY offer → safe failure (never an arbitrary pick;
 *     same fail-safe pattern as `lockFirstPartyOfferInventory`, 9F-23b)
 *   - the product is ACTIVE → rejected ("Set this product to Draft…") so a live
 *     customer's listing can't silently flip New → Refurbished. Historical
 *     `OrderItem.condition` snapshots are irrelevant and never touched.
 *
 * A no-op (condition already equals the target) succeeds without a write, even
 * for an ACTIVE product.
 */
export async function setFirstPartyOfferCondition(
  variantId: string,
  condition: string,
  tx: Prisma.TransactionClient,
): Promise<
  | { ok: true; previous: string; changed: boolean }
  | { ok: false; error: string }
> {
  if (!(OFFER_CONDITIONS as readonly string[]).includes(condition)) {
    return { ok: false, error: "That isn’t a condition we recognise." };
  }

  const rows = await tx.$queryRaw<
    { id: string; condition: string; productStatus: string }[]
  >`
    SELECT o."id", o."condition", p."status" AS "productStatus"
    FROM "Offer" o
    JOIN "Seller" s ON s."id" = o."sellerId"
    JOIN "Variant" v ON v."id" = o."variantId"
    JOIN "Product" p ON p."id" = v."productId"
    WHERE o."variantId" = ${variantId} AND s."type" = 'FIRST_PARTY'
    FOR UPDATE OF o
    LIMIT 2`;

  if (rows.length === 0) return { ok: false, error: "No Axiaro listing exists for that variant." };
  if (rows.length > 1) {
    return {
      ok: false,
      error: "This variant has more than one Axiaro listing — resolve that before changing its condition.",
    };
  }

  const offer = rows[0];
  if (offer.condition === condition) {
    return { ok: true, previous: offer.condition, changed: false };
  }
  if (offer.productStatus === "ACTIVE") {
    return { ok: false, error: "Set this product to Draft before changing its condition." };
  }

  await tx.offer.update({ where: { id: offer.id }, data: { condition } });
  return { ok: true, previous: offer.condition, changed: true };
}
