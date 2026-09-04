import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SellerUserRole } from "@/lib/marketplace/types";

/**
 * Admin (cross-seller) SellerUser management — Phase 9F-4b.
 *
 * The operator plane manages seller membership. Every function is passed BOTH a
 * `sellerId` and the target `sellerUserId`, and every lookup/mutation is scoped
 * `where: { id: sellerUserId, sellerId }` — a mismatched pair (a SellerUser that
 * belongs to another seller) resolves to NOT_FOUND, so an admin editing seller
 * A's roster can never flip a row that belongs to seller B.
 *
 * Roles are fixed: OWNER | MANAGER | STAFF (spec — no new seller roles).
 * Statuses used here: ACTIVE | DISABLED. `INVITED` is reserved for a future
 * `SellerInvite` flow (not built — see the 9F-4b report).
 *
 * Pure data mutations — the caller (actions.ts) does auth + audit. Each takes an
 * optional transaction client for tests. There is NO seller-plane counterpart:
 * `/seller` code never manages membership.
 */

type Client = Prisma.TransactionClient | typeof prisma;

const SELLER_USER_ROLES = ["OWNER", "MANAGER", "STAFF"] as const;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type SellerUserError =
  | { ok: false; code: "NOT_FOUND"; error: string }
  | { ok: false; code: "VALIDATION"; error: string }
  | { ok: false; code: "NO_ACCOUNT"; error: string }
  | { ok: false; code: "CONFLICT"; error: string }
  | { ok: false; code: "LAST_OWNER"; error: string };

function isRole(v: string): v is SellerUserRole {
  return (SELLER_USER_ROLES as readonly string[]).includes(v);
}

export type AddSellerUserResult =
  | { ok: true; sellerUserId: string; userEmail: string; role: string; verb: "added" | "re-enabled"; sellerName: string }
  | SellerUserError;

export async function addSellerUserByEmail(
  sellerId: string,
  email: string,
  role: string,
  client: Client = prisma,
): Promise<AddSellerUserResult> {
  const normalized = String(email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(normalized)) {
    return { ok: false, code: "VALIDATION", error: "Enter a valid email address." };
  }
  if (!isRole(role)) return { ok: false, code: "VALIDATION", error: "Choose a valid role." };

  const seller = await client.seller.findUnique({ where: { id: sellerId }, select: { id: true, displayName: true } });
  if (!seller) return { ok: false, code: "NOT_FOUND", error: "Seller not found." };

  const user = await client.user.findUnique({
    where: { email: normalized },
    select: { id: true, email: true, supabaseUserId: true },
  });
  if (!user || !user.supabaseUserId) {
    return {
      ok: false,
      code: "NO_ACCOUNT",
      error: "No Axiaro account for that email. Ask them to register first, then add them here.",
    };
  }

  const existing = await client.sellerUser.findUnique({
    where: { sellerId_userId: { sellerId, userId: user.id } },
    select: { id: true, status: true },
  });

  let sellerUserId: string;
  let verb: "added" | "re-enabled";
  if (existing) {
    if (existing.status === "ACTIVE") {
      return { ok: false, code: "CONFLICT", error: "That person is already an active member." };
    }
    await client.sellerUser.update({ where: { id: existing.id }, data: { role, status: "ACTIVE" } });
    sellerUserId = existing.id;
    verb = "re-enabled";
  } else {
    const created = await client.sellerUser.create({
      data: { sellerId, userId: user.id, role, status: "ACTIVE" },
      select: { id: true },
    });
    sellerUserId = created.id;
    verb = "added";
  }

  return { ok: true, sellerUserId, userEmail: user.email, role, verb, sellerName: seller.displayName };
}

/** Count the seller's ACTIVE OWNER members — protects the last owner. */
async function activeOwnerCount(client: Client, sellerId: string, exceptSellerUserId?: string): Promise<number> {
  return client.sellerUser.count({
    where: {
      sellerId,
      role: "OWNER",
      status: "ACTIVE",
      ...(exceptSellerUserId ? { id: { not: exceptSellerUserId } } : {}),
    },
  });
}

export type MemberMutationResult =
  | { ok: true; sellerUserId: string; userEmail: string; from: string; to: string; sellerName: string; noop: boolean }
  | SellerUserError;

export async function setSellerUserRole(
  sellerId: string,
  sellerUserId: string,
  role: string,
  client: Client = prisma,
): Promise<MemberMutationResult> {
  if (!isRole(role)) return { ok: false, code: "VALIDATION", error: "Choose a valid role." };

  const su = await client.sellerUser.findFirst({
    where: { id: sellerUserId, sellerId },
    select: { id: true, role: true, status: true, user: { select: { email: true } }, seller: { select: { displayName: true } } },
  });
  if (!su) return { ok: false, code: "NOT_FOUND", error: "That member isn't on this seller." };
  if (su.role === role) {
    return { ok: true, sellerUserId: su.id, userEmail: su.user.email, from: su.role, to: role, sellerName: su.seller.displayName, noop: true };
  }

  if (su.role === "OWNER" && su.status === "ACTIVE" && role !== "OWNER") {
    if ((await activeOwnerCount(client, sellerId, sellerUserId)) === 0) {
      return { ok: false, code: "LAST_OWNER", error: "A seller must keep at least one active owner." };
    }
  }

  await client.sellerUser.update({ where: { id: su.id }, data: { role } });
  return { ok: true, sellerUserId: su.id, userEmail: su.user.email, from: su.role, to: role, sellerName: su.seller.displayName, noop: false };
}

export async function setSellerUserStatus(
  sellerId: string,
  sellerUserId: string,
  status: "ACTIVE" | "DISABLED",
  client: Client = prisma,
): Promise<MemberMutationResult> {
  if (status !== "ACTIVE" && status !== "DISABLED") {
    return { ok: false, code: "VALIDATION", error: "Invalid status." };
  }

  const su = await client.sellerUser.findFirst({
    where: { id: sellerUserId, sellerId },
    select: { id: true, role: true, status: true, user: { select: { email: true } }, seller: { select: { displayName: true } } },
  });
  if (!su) return { ok: false, code: "NOT_FOUND", error: "That member isn't on this seller." };
  if (su.status === status) {
    return { ok: true, sellerUserId: su.id, userEmail: su.user.email, from: su.status, to: status, sellerName: su.seller.displayName, noop: true };
  }

  if (status === "DISABLED" && su.role === "OWNER" && su.status === "ACTIVE") {
    if ((await activeOwnerCount(client, sellerId, sellerUserId)) === 0) {
      return { ok: false, code: "LAST_OWNER", error: "A seller must keep at least one active owner." };
    }
  }

  await client.sellerUser.update({ where: { id: su.id }, data: { status } });
  return { ok: true, sellerUserId: su.id, userEmail: su.user.email, from: su.status, to: status, sellerName: su.seller.displayName, noop: false };
}
