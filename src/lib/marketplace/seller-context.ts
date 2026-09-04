import "server-only";
import { cache } from "react";
import { forbidden } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { permissionsForSellerRole } from "@/lib/marketplace/seller-permissions";
import type { SellerContext, SellerUserRole } from "@/lib/marketplace/types";

/**
 * Seller-plane authorization.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Mirrors src/lib/admin/rbac.ts, but for the SELLER plane. It does NOT touch
 * `/admin` authentication or the global RBAC (UserRole / Role / Permission) in
 * any way — the two planes are independent. A person may hold both, either, or
 * neither.
 *
 * `getCurrentSellerContext(sellerIdOrSlug)` resolves a context for ONE named
 * seller. The `/seller` portal does not know the seller id at entry, so it goes
 * through `src/lib/seller/session.ts` (`getSellerSession`), which lists the
 * caller's memberships and then calls this for the chosen one.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A seller user is authorised for a given seller ONLY when:
 *   1. they are a verified Supabase user with an application User row, AND
 *   2. the Seller exists and is APPROVED, AND
 *   3. an ACTIVE SellerUser row links that user to that seller.
 * Being merely authenticated is never enough — a SellerUser for Seller B can
 * never resolve a context for Seller C.
 */

export const getCurrentSellerContext = cache(
  async (sellerIdOrSlug: string): Promise<SellerContext | null> => {
    const key = (sellerIdOrSlug ?? "").trim();
    if (!key) return null;

    const user = await getCurrentUser();
    if (!user) return null;

    const seller = await prisma.seller.findFirst({
      where: { OR: [{ id: key }, { slug: key }] },
      select: { id: true, status: true, displayName: true },
    });
    if (!seller || seller.status !== "APPROVED") return null;

    const membership = await prisma.sellerUser.findUnique({
      where: { sellerId_userId: { sellerId: seller.id, userId: user.id } },
      select: { id: true, role: true, status: true },
    });
    if (!membership || membership.status !== "ACTIVE") return null;

    const role = membership.role as SellerUserRole;
    return {
      sellerId: seller.id,
      sellerName: seller.displayName,
      sellerUserId: membership.id,
      userId: user.id,
      role,
      permissions: permissionsForSellerRole(role),
    };
  },
);

/** Pure check for conditional UI. Never the only gate on a mutation. */
export function sellerCan(ctx: SellerContext, permission: string): boolean {
  return ctx.role === "OWNER" || ctx.permissions.has(permission);
}

/**
 * Require a seller context for `sellerIdOrSlug`, or raise the Next.js 403
 * interrupt. Used by the `/seller` layout / server actions once the caller's
 * seller has been resolved.
 */
export async function requireSellerContext(sellerIdOrSlug: string): Promise<SellerContext> {
  const ctx = await getCurrentSellerContext(sellerIdOrSlug);
  if (!ctx) forbidden();
  return ctx;
}

export async function requireSellerPermission(
  sellerIdOrSlug: string,
  permission: string,
): Promise<SellerContext> {
  const ctx = await requireSellerContext(sellerIdOrSlug);
  if (!sellerCan(ctx, permission)) forbidden();
  return ctx;
}
