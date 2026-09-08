import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getStoreSetting } from "@/lib/marketplace/marketplace-settings";
import {
  offerPublishBlockers,
  OFFER_PUBLISH_BLOCKER_MESSAGE,
} from "@/lib/marketplace/seller-repository";

/**
 * Admin (cross-seller) Offer status control — Phase 9F-24D (P1-4).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The OPERATOR counterpart to the seller's own `setSellerOfferStatus`. An Axiaro
 * reviewer needs to be able to pull a bad listing (→ INACTIVE / ARCHIVED) or
 * publish a seller's ready DRAFT (→ ACTIVE) WITHOUT the blunt instrument of
 * suspending the whole seller (which nukes every one of their offers).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Deliberately NOT seller-scoped — the caller is `requirePermission`-gated in
 * the action layer (`manage_settings`, same as `/admin/sellers`).
 *
 * The rules are IDENTICAL to the seller path — this is a second door to the same
 * room, not a bypass:
 *   - the transition map is the same (DRAFT/INACTIVE ↔ each other + ACTIVE,
 *     ACTIVE → INACTIVE/ARCHIVED, ARCHIVED terminal);
 *   - `→ ACTIVE` keeps the double-lock (marketplace flag + transition map) AND
 *     runs the same `offerPublishBlockers` readiness check.
 * It touches ONLY `Offer.status` — never OfferInventory, price, condition,
 * Product, Variant, or Seller.
 */

const OFFER_STATUSES = ["DRAFT", "ACTIVE", "INACTIVE", "ARCHIVED"] as const;
export type AdminOfferStatus = (typeof OFFER_STATUSES)[number];

const TRANSITIONS: Record<string, AdminOfferStatus[]> = {
  DRAFT: ["INACTIVE", "ARCHIVED", "ACTIVE"],
  INACTIVE: ["DRAFT", "ARCHIVED", "ACTIVE"],
  ACTIVE: ["INACTIVE", "ARCHIVED"],
  ARCHIVED: [],
};

export type AdminSetOfferStatusResult =
  | {
      ok: true;
      previousStatus: AdminOfferStatus;
      newStatus: AdminOfferStatus;
      storefrontAffected: boolean;
      sellerId: string;
      sellerName: string;
      sellerType: string;
      productName: string;
      variantId: string;
      variantSku: string;
    }
  | { ok: false; code: "NOT_FOUND" | "VALIDATION" | "FORBIDDEN"; error: string };

export async function adminSetOfferStatus(
  offerId: string,
  next: AdminOfferStatus,
  externalTx?: Prisma.TransactionClient,
): Promise<AdminSetOfferStatusResult> {
  if (!(OFFER_STATUSES as readonly string[]).includes(next)) {
    return { ok: false, code: "VALIDATION", error: "Unknown status." };
  }

  // Double-lock, part 1 — the marketplace flag, checked outside the tx exactly
  // like the seller path.
  if (next === "ACTIVE") {
    const gate = await getStoreSetting("marketplace.multiSellerCheckout");
    if (gate !== "true") {
      return { ok: false, code: "FORBIDDEN", error: OFFER_PUBLISH_BLOCKER_MESSAGE.MARKETPLACE_CLOSED };
    }
  }

  const run = async (tx: Prisma.TransactionClient): Promise<AdminSetOfferStatusResult> => {
    const offer = await tx.offer.findUnique({
      where: { id: offerId },
      select: {
        id: true,
        status: true,
        sellerId: true,
        seller: { select: { displayName: true, type: true, status: true } },
        variant: {
          select: {
            id: true,
            sku: true,
            status: true,
            product: { select: { status: true, name: true } },
          },
        },
        inventory: { select: { quantity: true, reserved: true } },
      },
    });
    if (!offer) return { ok: false, code: "NOT_FOUND", error: "That listing no longer exists." };

    const ctx = {
      sellerId: offer.sellerId,
      sellerName: offer.seller.displayName,
      sellerType: offer.seller.type,
      productName: offer.variant.product.name,
      variantId: offer.variant.id,
      variantSku: offer.variant.sku,
    };

    if (offer.status === next) {
      return {
        ok: true,
        previousStatus: offer.status as AdminOfferStatus,
        newStatus: next,
        storefrontAffected: false,
        ...ctx,
      };
    }
    if (offer.status === "ARCHIVED") {
      return { ok: false, code: "VALIDATION", error: "An archived listing can't be reactivated." };
    }
    if (!(TRANSITIONS[offer.status] ?? []).includes(next)) {
      return { ok: false, code: "VALIDATION", error: `Can't move a listing from ${offer.status} to ${next}.` };
    }

    // Double-lock, part 2 — publish-readiness, same check the seller path runs.
    if (next === "ACTIVE") {
      const available = Math.max(0, (offer.inventory?.quantity ?? 0) - (offer.inventory?.reserved ?? 0));
      const blockers = offerPublishBlockers({
        offerStatus: offer.status,
        sellerStatus: offer.seller.status,
        marketplaceOpen: true, // the flag gate above already passed
        productStatus: offer.variant.product.status,
        variantStatus: offer.variant.status,
        available,
      });
      if (blockers.length > 0) {
        return {
          ok: false,
          code: "FORBIDDEN",
          error: blockers.map((b) => OFFER_PUBLISH_BLOCKER_MESSAGE[b]).join(" "),
        };
      }
    }

    await tx.offer.update({ where: { id: offerId }, data: { status: next } });
    return {
      ok: true,
      previousStatus: offer.status as AdminOfferStatus,
      newStatus: next,
      storefrontAffected: offer.status === "ACTIVE" || next === "ACTIVE",
      ...ctx,
    };
  };

  try {
    if (externalTx) return await run(externalTx);
    return await prisma.$transaction(run);
  } catch (err) {
    console.error("[admin/offer-status] adminSetOfferStatus failed", err);
    return { ok: false, code: "VALIDATION", error: "Could not change the listing status." };
  }
}
