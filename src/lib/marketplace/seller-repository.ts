import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getStoreSetting } from "@/lib/marketplace/marketplace-settings";
import type { SellerContext } from "@/lib/marketplace/types";

/**
 * Seller-scoped data-access layer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The ONLY sanctioned way for seller-plane code (`/seller` routes + actions) to
 * touch Offer / OfferInventory / OfferAdjustment.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The isolation contract:
 *   - every function REQUIRES a `SellerContext` and injects
 *     `where: { sellerId: ctx.sellerId }` — a seller can only ever see or change
 *     their own rows;
 *   - ownership is re-checked INSIDE the write transaction (a forged / stale
 *     offerId in a form body fails the `sellerId` guard, not just the route);
 *   - there is deliberately NO unscoped `getOffer(id)` / `listAllOffers()` here.
 *     Cross-seller reads belong to the operator (`/admin`) plane, and to the
 *     storefront buy-box resolver (src/lib/marketplace/offer-resolver.ts), which
 *     returns only public fields.
 *
 * These functions operate ONLY on OfferInventory / OfferAdjustment / Offer. They
 * NEVER touch Inventory, InventoryAdjustment, Variant.stock or
 * src/lib/inventory.ts — there is no dual-write on the seller plane.
 *
 * CUSTOMER-VISIBILITY GATE (9F-1). `marketplace.multiSellerCheckout` is false and
 * must stay so. Enforcement: a THIRD_PARTY seller's Offer can NEVER be set to
 * `status = "ACTIVE"` through this layer while the gate is off — so no 3P offer
 * is ever buy-box-eligible and the storefront/checkout need no change. Going
 * live is a later, separately-approved phase.
 *
 * Every function accepts an optional transaction client so callers — and tests —
 * can compose them.
 */

type Client = Prisma.TransactionClient | typeof prisma;

export type SellerRepoError =
  | { ok: false; code: "NOT_FOUND"; error: string }
  | { ok: false; code: "VALIDATION"; error: string }
  | { ok: false; code: "CONFLICT"; error: string }
  | { ok: false; code: "FORBIDDEN"; error: string }
  | { ok: false; code: "INVARIANT"; error: string };

const OFFER_STATUSES = ["DRAFT", "ACTIVE", "INACTIVE", "ARCHIVED"] as const;
const OFFER_CONDITIONS = ["NEW", "REFURBISHED", "USED_LIKE_NEW", "USED_GOOD"] as const;
type OfferStatus = (typeof OFFER_STATUSES)[number];
type OfferCondition = (typeof OFFER_CONDITIONS)[number];

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type SellerOfferListOptions = {
  status?: string | string[];
  variantId?: string;
  q?: string;
  skip?: number;
  take?: number;
};

const SELLER_OFFER_INCLUDE = {
  inventory: true,
  variant: {
    select: {
      id: true,
      sku: true,
      status: true,
      product: { select: { id: true, name: true, slug: true, status: true } },
      optionValues: {
        select: { optionValue: { select: { value: true, option: { select: { name: true, sortOrder: true } } } } },
      },
    },
  },
} satisfies Prisma.OfferInclude;

/** Every Offer owned by `ctx.sellerId`. Never returns another seller's rows. */
export async function listSellerOffers(
  ctx: SellerContext,
  opts: SellerOfferListOptions = {},
  client: Client = prisma,
) {
  const where: Prisma.OfferWhereInput = { sellerId: ctx.sellerId };
  if (opts.status) {
    where.status = Array.isArray(opts.status) ? { in: opts.status } : opts.status;
  }
  if (opts.variantId) where.variantId = opts.variantId;
  if (opts.q?.trim()) {
    const q = opts.q.trim();
    where.OR = [
      { sellerSku: { contains: q, mode: "insensitive" } },
      { variant: { sku: { contains: q, mode: "insensitive" } } },
      { variant: { product: { name: { contains: q, mode: "insensitive" } } } },
    ];
  }

  return client.offer.findMany({
    where,
    orderBy: { createdAt: "desc" },
    skip: opts.skip,
    take: opts.take,
    include: SELLER_OFFER_INCLUDE,
  });
}

export async function countSellerOffersWhere(
  ctx: SellerContext,
  opts: Pick<SellerOfferListOptions, "status" | "variantId" | "q"> = {},
  client: Client = prisma,
): Promise<number> {
  const where: Prisma.OfferWhereInput = { sellerId: ctx.sellerId };
  if (opts.status) where.status = Array.isArray(opts.status) ? { in: opts.status } : opts.status;
  if (opts.variantId) where.variantId = opts.variantId;
  if (opts.q?.trim()) {
    const q = opts.q.trim();
    where.OR = [
      { sellerSku: { contains: q, mode: "insensitive" } },
      { variant: { sku: { contains: q, mode: "insensitive" } } },
      { variant: { product: { name: { contains: q, mode: "insensitive" } } } },
    ];
  }
  return client.offer.count({ where });
}

/**
 * A single Offer, but only if it belongs to `ctx.sellerId`. Returns `null` for a
 * missing offer AND for another seller's offer — the caller cannot tell the
 * difference, which is intentional.
 */
export async function getOfferForSeller(ctx: SellerContext, offerId: string, client: Client = prisma) {
  return client.offer.findFirst({
    where: { id: offerId, sellerId: ctx.sellerId },
    include: SELLER_OFFER_INCLUDE,
  });
}

export async function countSellerOffers(ctx: SellerContext, client: Client = prisma): Promise<number> {
  return client.offer.count({ where: { sellerId: ctx.sellerId } });
}

/** Offer counts grouped by status for the dashboard. */
export async function sellerOfferStatusCounts(
  ctx: SellerContext,
  client: Client = prisma,
): Promise<Record<OfferStatus, number>> {
  const rows = await client.offer.groupBy({
    by: ["status"],
    where: { sellerId: ctx.sellerId },
    _count: { _all: true },
  });
  const out: Record<OfferStatus, number> = { DRAFT: 0, ACTIVE: 0, INACTIVE: 0, ARCHIVED: 0 };
  for (const r of rows) {
    if ((OFFER_STATUSES as readonly string[]).includes(r.status)) {
      out[r.status as OfferStatus] = r._count._all;
    }
  }
  return out;
}

/** Offers for this seller at or below their reorder point (available basis). */
export async function sellerLowStockCount(ctx: SellerContext, client: Client = prisma): Promise<number> {
  const rows = await client.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n
    FROM "OfferInventory" oi
    JOIN "Offer" o ON o."id" = oi."offerId"
    WHERE o."sellerId" = ${ctx.sellerId}
      AND o."status" <> 'ARCHIVED'
      AND (oi."quantity" - oi."reserved") <= oi."reorderPoint"`;
  return rows[0]?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Writes — ownership re-checked inside the transaction
// ---------------------------------------------------------------------------

export type CreateSellerOfferInput = {
  variantId: string;
  price: number;
  compareAtPrice?: number | null;
  condition?: OfferCondition;
  sellerSku?: string | null;
  handlingTimeDays?: number;
  /** opening stock for the new OfferInventory row */
  openingQuantity?: number;
  reorderPoint?: number;
};

export type CreateSellerOfferResult = { ok: true; offerId: string } | SellerRepoError;

function validateOfferCommercials(input: {
  price?: number;
  compareAtPrice?: number | null;
  handlingTimeDays?: number;
  reorderPoint?: number;
  openingQuantity?: number;
}): SellerRepoError | null {
  if (input.price !== undefined) {
    if (!Number.isInteger(input.price) || input.price <= 0) {
      return { ok: false, code: "VALIDATION", error: "Price must be a positive whole number (centavos)." };
    }
  }
  if (input.compareAtPrice != null) {
    if (!Number.isInteger(input.compareAtPrice) || input.compareAtPrice <= 0) {
      return { ok: false, code: "VALIDATION", error: "Compare-at price must be a positive whole number." };
    }
    if (input.price !== undefined && input.compareAtPrice <= input.price) {
      return { ok: false, code: "VALIDATION", error: "Compare-at price must be higher than the price." };
    }
  }
  if (input.handlingTimeDays !== undefined) {
    if (!Number.isInteger(input.handlingTimeDays) || input.handlingTimeDays < 0 || input.handlingTimeDays > 30) {
      return { ok: false, code: "VALIDATION", error: "Handling time must be 0–30 days." };
    }
  }
  if (input.reorderPoint !== undefined) {
    if (!Number.isInteger(input.reorderPoint) || input.reorderPoint < 0) {
      return { ok: false, code: "VALIDATION", error: "Reorder point can't be negative." };
    }
  }
  if (input.openingQuantity !== undefined) {
    if (!Number.isInteger(input.openingQuantity) || input.openingQuantity < 0) {
      return { ok: false, code: "VALIDATION", error: "Opening stock can't be negative." };
    }
  }
  return null;
}

/**
 * Create a new Offer for this seller against a catalog Variant, plus its
 * OfferInventory row (+ an opening `OfferAdjustment`). Always created
 * `status = "DRAFT"` — a seller offer never starts customer-visible.
 */
export async function createSellerOffer(
  ctx: SellerContext,
  input: CreateSellerOfferInput,
  externalTx?: Prisma.TransactionClient,
): Promise<CreateSellerOfferResult> {
  const condition: OfferCondition = input.condition ?? "NEW";
  if (!(OFFER_CONDITIONS as readonly string[]).includes(condition)) {
    return { ok: false, code: "VALIDATION", error: "Unknown condition." };
  }
  const bad = validateOfferCommercials(input);
  if (bad) return bad;
  const sku = input.sellerSku?.trim() || null;

  const run = async (tx: Prisma.TransactionClient): Promise<CreateSellerOfferResult> => {
    const variant = await tx.variant.findUnique({
      where: { id: input.variantId },
      select: { id: true, sku: true, status: true, product: { select: { status: true } } },
    });
    if (!variant) return { ok: false, code: "NOT_FOUND", error: "That product option no longer exists." };
    if (variant.status !== "ACTIVE" || variant.product.status === "ARCHIVED") {
      return { ok: false, code: "VALIDATION", error: "That product option is not available to list against." };
    }

    const dupe = await tx.offer.findUnique({
      where: {
        sellerId_variantId_condition: { sellerId: ctx.sellerId, variantId: input.variantId, condition },
      },
      select: { id: true },
    });
    if (dupe) {
      return { ok: false, code: "CONFLICT", error: "You already have an offer for this option and condition." };
    }
    if (sku) {
      const skuClash = await tx.offer.findFirst({
        where: { sellerId: ctx.sellerId, sellerSku: sku },
        select: { id: true },
      });
      if (skuClash) return { ok: false, code: "CONFLICT", error: "That SKU is already used by one of your offers." };
    }

    const opening = input.openingQuantity ?? 0;
    const offer = await tx.offer.create({
      data: {
        sellerId: ctx.sellerId,
        variantId: input.variantId,
        price: input.price,
        compareAtPrice: input.compareAtPrice ?? null,
        costPrice: null,
        sellerSku: sku,
        condition,
        status: "DRAFT",
        fulfillmentType: "SELLER_FULFILLED",
        handlingTimeDays: input.handlingTimeDays ?? 2,
      },
      select: { id: true },
    });

    const inv = await tx.offerInventory.create({
      data: {
        offerId: offer.id,
        sellerSku: sku,
        quantity: opening,
        reserved: 0,
        reorderPoint: input.reorderPoint ?? 3,
      },
      select: { id: true },
    });
    await tx.offerAdjustment.create({
      data: {
        offerInventoryId: inv.id,
        previousQuantity: 0,
        delta: opening,
        newQuantity: opening,
        reason: "MIGRATION_OPENING",
        note: "Opening balance — seller-created offer (9F-1).",
        actorUserId: ctx.userId,
      },
    });

    return { ok: true, offerId: offer.id };
  };

  try {
    if (externalTx) return await run(externalTx);
    return await prisma.$transaction(run);
  } catch (err) {
    console.error("[seller-repository] createSellerOffer failed", err);
    return { ok: false, code: "VALIDATION", error: "Could not create the offer." };
  }
}

export type UpdateSellerOfferPatch = {
  price?: number;
  compareAtPrice?: number | null;
  sellerSku?: string | null;
  handlingTimeDays?: number;
  condition?: OfferCondition;
};

export type MutateSellerOfferResult = { ok: true } | SellerRepoError;

/** Edit an Offer's commercial terms. Ownership re-checked inside the tx. */
export async function updateSellerOffer(
  ctx: SellerContext,
  offerId: string,
  patch: UpdateSellerOfferPatch,
  externalTx?: Prisma.TransactionClient,
): Promise<MutateSellerOfferResult> {
  const run = async (tx: Prisma.TransactionClient): Promise<MutateSellerOfferResult> => {
    const offer = await tx.offer.findFirst({
      where: { id: offerId, sellerId: ctx.sellerId },
      select: { id: true, price: true, condition: true, variantId: true, status: true },
    });
    if (!offer) return { ok: false, code: "NOT_FOUND", error: "No such offer for this seller." };
    if (offer.status === "ARCHIVED") {
      return { ok: false, code: "VALIDATION", error: "An archived offer can't be edited." };
    }

    const nextPrice = patch.price ?? offer.price;
    const bad = validateOfferCommercials({
      price: patch.price,
      compareAtPrice: patch.compareAtPrice === undefined ? undefined : patch.compareAtPrice,
      handlingTimeDays: patch.handlingTimeDays,
    });
    if (bad) return bad;
    if (patch.compareAtPrice != null && patch.compareAtPrice <= nextPrice) {
      return { ok: false, code: "VALIDATION", error: "Compare-at price must be higher than the price." };
    }

    const data: Prisma.OfferUpdateInput = {};
    if (patch.price !== undefined) data.price = patch.price;
    if (patch.compareAtPrice !== undefined) data.compareAtPrice = patch.compareAtPrice;
    if (patch.handlingTimeDays !== undefined) data.handlingTimeDays = patch.handlingTimeDays;

    if (patch.sellerSku !== undefined) {
      const sku = patch.sellerSku?.trim() || null;
      if (sku) {
        const clash = await tx.offer.findFirst({
          where: { sellerId: ctx.sellerId, sellerSku: sku, id: { not: offerId } },
          select: { id: true },
        });
        if (clash) return { ok: false, code: "CONFLICT", error: "That SKU is already used by one of your offers." };
      }
      data.sellerSku = sku;
      await tx.offerInventory.updateMany({ where: { offerId }, data: { sellerSku: sku } });
    }

    if (patch.condition !== undefined && patch.condition !== offer.condition) {
      if (!(OFFER_CONDITIONS as readonly string[]).includes(patch.condition)) {
        return { ok: false, code: "VALIDATION", error: "Unknown condition." };
      }
      const dupe = await tx.offer.findUnique({
        where: {
          sellerId_variantId_condition: {
            sellerId: ctx.sellerId,
            variantId: offer.variantId,
            condition: patch.condition,
          },
        },
        select: { id: true },
      });
      if (dupe) return { ok: false, code: "CONFLICT", error: "You already have an offer for this option and condition." };
      data.condition = patch.condition;
    }

    if (Object.keys(data).length === 0) return { ok: true };
    await tx.offer.update({ where: { id: offerId }, data });
    return { ok: true };
  };

  try {
    if (externalTx) return await run(externalTx);
    return await prisma.$transaction(run);
  } catch (err) {
    console.error("[seller-repository] updateSellerOffer failed", err);
    return { ok: false, code: "VALIDATION", error: "Could not update the offer." };
  }
}

/**
 * Move an Offer between the seller-controllable statuses.
 *
 * ALLOWED (9F-8c): DRAFT ↔ INACTIVE, either → ARCHIVED, and — ONLY when
 * `marketplace.multiSellerCheckout` is `"true"` — DRAFT → ACTIVE and
 * INACTIVE → ACTIVE. The gate check above remains the first line of defense;
 * this map is the second, independent one (both must permit a transition to
 * ACTIVE, matching the double-lock already documented in the 9F-8b/9F-8c
 * audits). A FIRST_PARTY offer is managed by the operator plane, not here.
 */
export async function setSellerOfferStatus(
  ctx: SellerContext,
  offerId: string,
  next: OfferStatus,
  externalTx?: Prisma.TransactionClient,
): Promise<MutateSellerOfferResult> {
  if (!(OFFER_STATUSES as readonly string[]).includes(next)) {
    return { ok: false, code: "VALIDATION", error: "Unknown status." };
  }
  if (next === "ACTIVE") {
    const gate = await getStoreSetting("marketplace.multiSellerCheckout");
    if (gate !== "true") {
      return {
        ok: false,
        code: "FORBIDDEN",
        error: "Offers can't be published yet — the marketplace isn't open to buyers.",
      };
    }
  }

  const run = async (tx: Prisma.TransactionClient): Promise<MutateSellerOfferResult> => {
    const offer = await tx.offer.findFirst({
      where: { id: offerId, sellerId: ctx.sellerId },
      select: { id: true, status: true },
    });
    if (!offer) return { ok: false, code: "NOT_FOUND", error: "No such offer for this seller." };
    if (offer.status === next) return { ok: true };
    if (offer.status === "ARCHIVED") {
      return { ok: false, code: "VALIDATION", error: "An archived offer can't be reactivated." };
    }
    // The `next === "ACTIVE"` gate check above already ran and returned
    // FORBIDDEN before reaching here if `marketplace.multiSellerCheckout` is
    // not `"true"` — by the time this map is consulted for an ACTIVE
    // destination, the gate has already passed.
    const allowed: Record<string, OfferStatus[]> = {
      DRAFT: ["INACTIVE", "ARCHIVED", "ACTIVE"],
      INACTIVE: ["DRAFT", "ARCHIVED", "ACTIVE"],
      ACTIVE: ["INACTIVE", "ARCHIVED"],
    };
    if (!(allowed[offer.status] ?? []).includes(next)) {
      return { ok: false, code: "VALIDATION", error: `Can't move an offer from ${offer.status} to ${next}.` };
    }
    await tx.offer.update({ where: { id: offerId }, data: { status: next } });
    return { ok: true };
  };

  try {
    if (externalTx) return await run(externalTx);
    return await prisma.$transaction(run);
  } catch (err) {
    console.error("[seller-repository] setSellerOfferStatus failed", err);
    return { ok: false, code: "VALIDATION", error: "Could not change the offer status." };
  }
}

export type MutateOfferInventoryResult =
  | { ok: true; previousQuantity: number; newQuantity: number; reserved: number; reorderPoint: number }
  | SellerRepoError;

async function runAdjust(
  tx: Prisma.TransactionClient,
  ctx: SellerContext,
  offerId: string,
  delta: number,
  reason: string,
  note: string | null,
): Promise<MutateOfferInventoryResult> {
  // Lock the OfferInventory row, but ONLY for an offer this seller owns.
  const locked = await tx.$queryRaw<
    { id: string; quantity: number; reserved: number; reorderPoint: number }[]
  >`
    SELECT oi."id", oi."quantity", oi."reserved", oi."reorderPoint"
    FROM "OfferInventory" oi
    JOIN "Offer" o ON o."id" = oi."offerId"
    WHERE oi."offerId" = ${offerId} AND o."sellerId" = ${ctx.sellerId}
    FOR UPDATE OF oi`;
  const inv = locked[0];
  if (!inv) return { ok: false, code: "NOT_FOUND", error: "No such offer for this seller." };

  const previousQuantity = inv.quantity;
  const newQuantity = previousQuantity + delta;
  if (newQuantity < 0) {
    return { ok: false, code: "INVARIANT", error: "Stock can't go below zero." };
  }
  if (newQuantity < inv.reserved) {
    return {
      ok: false,
      code: "INVARIANT",
      error: `Can't reduce below the ${inv.reserved} unit(s) currently reserved.`,
    };
  }

  if (delta !== 0) {
    await tx.offerInventory.update({ where: { id: inv.id }, data: { quantity: newQuantity } });
    await tx.offerAdjustment.create({
      data: {
        offerInventoryId: inv.id,
        previousQuantity,
        delta,
        newQuantity,
        reason: reason.trim(),
        note: note?.trim() || null,
        actorUserId: ctx.userId,
      },
    });
  }

  return { ok: true, previousQuantity, newQuantity, reserved: inv.reserved, reorderPoint: inv.reorderPoint };
}

/**
 * Apply a signed delta to an Offer's own stock (OfferInventory), record an
 * OfferAdjustment, and keep the same invariants Inventory enforces
 * (quantity >= 0, quantity >= reserved). Row-locked for the transaction.
 *
 * Only ever touches OfferInventory / OfferAdjustment. Never Inventory /
 * Variant.stock.
 */
export async function adjustOfferStock(
  ctx: SellerContext,
  offerId: string,
  delta: number,
  reason: string,
  note?: string | null,
  externalTx?: Prisma.TransactionClient,
): Promise<MutateOfferInventoryResult> {
  if (!Number.isInteger(delta)) {
    return { ok: false, code: "VALIDATION", error: "Adjustment must be a whole number." };
  }
  if (!reason || !reason.trim()) {
    return { ok: false, code: "VALIDATION", error: "A reason is required." };
  }

  try {
    if (externalTx) return await runAdjust(externalTx, ctx, offerId, delta, reason, note ?? null);
    return await prisma.$transaction((tx) => runAdjust(tx, ctx, offerId, delta, reason, note ?? null));
  } catch (err) {
    console.error("[seller-repository] adjustOfferStock failed", err);
    return { ok: false, code: "VALIDATION", error: "Could not adjust stock." };
  }
}

/** Set an Offer's OfferInventory reorder point (no adjustment row — not a quantity change). */
export async function setSellerOfferReorderPoint(
  ctx: SellerContext,
  offerId: string,
  reorderPoint: number,
  externalTx?: Prisma.TransactionClient,
): Promise<{ ok: true; previous: number } | SellerRepoError> {
  if (!Number.isInteger(reorderPoint) || reorderPoint < 0) {
    return { ok: false, code: "VALIDATION", error: "Reorder point can't be negative." };
  }

  const run = async (
    tx: Prisma.TransactionClient,
  ): Promise<{ ok: true; previous: number } | SellerRepoError> => {
    const locked = await tx.$queryRaw<{ id: string; reorderPoint: number }[]>`
      SELECT oi."id", oi."reorderPoint"
      FROM "OfferInventory" oi
      JOIN "Offer" o ON o."id" = oi."offerId"
      WHERE oi."offerId" = ${offerId} AND o."sellerId" = ${ctx.sellerId}
      FOR UPDATE OF oi`;
    const inv = locked[0];
    if (!inv) return { ok: false, code: "NOT_FOUND", error: "No such offer for this seller." };
    if (inv.reorderPoint === reorderPoint) return { ok: true, previous: inv.reorderPoint };
    await tx.offerInventory.update({ where: { id: inv.id }, data: { reorderPoint } });
    return { ok: true, previous: inv.reorderPoint };
  };

  try {
    if (externalTx) return await run(externalTx);
    return await prisma.$transaction(run);
  } catch (err) {
    console.error("[seller-repository] setSellerOfferReorderPoint failed", err);
    return { ok: false, code: "VALIDATION", error: "Could not update the reorder point." };
  }
}
