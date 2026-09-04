import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect, forbidden } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import {
  getCurrentSellerContext,
  sellerCan,
} from "@/lib/marketplace/seller-context";
import type { SellerContext, SellerMembership, SellerUserRole } from "@/lib/marketplace/types";

/**
 * Portal session resolution for `/seller`.
 *
 * The portal does not know which seller the visitor manages, so this module
 * turns "the signed-in user" into "an established SellerContext":
 *
 *   1. list the user's ACTIVE `SellerUser` memberships (`listSellerMemberships`)
 *   2. pick the current one — the `axr_seller` cookie if it names a usable
 *      membership, otherwise the sole usable membership
 *   3. hand off to `getCurrentSellerContext(sellerId)` for the real gate
 *      (Seller APPROVED + membership ACTIVE + permission set)
 *
 * Nothing here trusts a client value beyond "which of MY memberships to show" —
 * the cookie can only ever select among sellers the user already belongs to.
 */

export const SELLER_COOKIE = "axr_seller";

/** Every ACTIVE membership for the signed-in user. Empty when not signed in. */
export const listSellerMemberships = cache(async (): Promise<SellerMembership[]> => {
  const user = await getCurrentUser();
  if (!user) return [];

  const rows = await prisma.sellerUser.findMany({
    where: { userId: user.id, status: "ACTIVE" },
    select: {
      role: true,
      seller: {
        select: { id: true, displayName: true, slug: true, status: true, type: true },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  return rows.map((r) => ({
    sellerId: r.seller.id,
    sellerName: r.seller.displayName,
    sellerSlug: r.seller.slug,
    sellerStatus: r.seller.status as SellerMembership["sellerStatus"],
    sellerType: r.seller.type === "FIRST_PARTY" ? "FIRST_PARTY" : "THIRD_PARTY",
    role: r.role as SellerUserRole,
  }));
});

/** Memberships whose Seller is APPROVED — the ones the portal can actually open. */
export async function usableSellerMemberships(): Promise<SellerMembership[]> {
  return (await listSellerMemberships()).filter((m) => m.sellerStatus === "APPROVED");
}

export type SellerSession = {
  ctx: SellerContext;
  /** all of the user's ACTIVE memberships — for the seller switcher */
  memberships: SellerMembership[];
};

/**
 * The seller session for the current request, or `null` when the visitor is not
 * signed in, has no ACTIVE membership, or has one but its Seller is not APPROVED.
 * Deduped per request.
 */
export const getSellerSession = cache(async (): Promise<SellerSession | null> => {
  const memberships = await listSellerMemberships();
  if (memberships.length === 0) return null;

  const usable = memberships.filter((m) => m.sellerStatus === "APPROVED");
  if (usable.length === 0) return null;

  const cookieStore = await cookies();
  const wanted = cookieStore.get(SELLER_COOKIE)?.value;
  const chosen =
    (wanted && usable.find((m) => m.sellerId === wanted)) || usable[0];

  const ctx = await getCurrentSellerContext(chosen.sellerId);
  if (!ctx) return null;

  return { ctx, memberships };
});

/**
 * Require an established seller session. Guests → `/seller/login`; a signed-in
 * user with no usable membership → 403. Use in the `/seller` layout and every
 * seller server action.
 */
export async function requireSellerSession(redirectTo?: string): Promise<SellerSession> {
  const user = await getCurrentUser();
  if (!user) {
    redirect(
      `/seller/login${redirectTo ? `?redirectTo=${encodeURIComponent(redirectTo)}` : ""}`,
    );
  }
  const session = await getSellerSession();
  if (!session) forbidden();
  return session;
}

/** Require a seller session AND a specific seller-scoped permission (OWNER always passes). */
export async function requireSellerSessionPermission(
  permission: string,
): Promise<SellerSession> {
  const session = await requireSellerSession();
  if (!sellerCan(session.ctx, permission)) forbidden();
  return session;
}
