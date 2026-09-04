import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { cleanUserText } from "@/lib/ugc";
import type { SellerContentStatus, SellerSocialLinks } from "@/lib/marketplace/types";
import { SELLER_SOCIAL_KEYS } from "@/lib/marketplace/types";
import {
  canTransitionSeller,
  validateSellerSlug,
  validateCommissionBps,
  DEFAULT_SELLER_COMMISSION_BPS,
  SELLER_TRANSITIONS,
  type SellerLifecycleStatus,
} from "@/lib/admin/sellers/lifecycle";

/**
 * Admin (cross-seller) Seller management data layer — Phase 9F-4b.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * This is the OPERATOR plane. It is deliberately cross-seller: an Axiaro admin
 * onboards and manages every third-party seller from here. It is NOT a
 * seller-scoped repository and must never be imported by `/seller` code.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Authorization is the caller's job (`requirePermission("manage_settings")` in
 * `actions.ts`). Audit is also the caller's job — every function here is a pure
 * data mutation that returns enough detail for the action to write one
 * `adminAuditLog` row (same split as the 9F-3 seller-return repo). Each function
 * takes an optional transaction client so tests can roll back.
 *
 * Scope guard-rails (spec 8 / 15-17 / 20-25):
 *   - `type` is never mutated (a new seller is always THIRD_PARTY; the
 *     `seller_one_first_party` partial index makes a 2nd FIRST_PARTY impossible);
 *   - no `Offer` / `OfferInventory` / `OfferAdjustment` / `Inventory` /
 *     `InventoryAdjustment` / `Variant` / `Product` / `StoreSetting` write ever
 *     happens here — a lifecycle change only flips `Seller.status`;
 *   - content moderation stays in `src/lib/admin/seller-content-actions.ts`
 *     (permission `manage_content`) — this module only READS `contentStatus`.
 */

type Client = Prisma.TransactionClient | typeof prisma;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type AdminSellerError =
  | { ok: false; code: "NOT_FOUND"; error: string }
  | { ok: false; code: "VALIDATION"; error: string }
  | { ok: false; code: "CONFLICT"; error: string }
  | { ok: false; code: "INVALID_TRANSITION"; error: string };

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type AdminSellerRow = {
  id: string;
  displayName: string;
  slug: string;
  type: "FIRST_PARTY" | "THIRD_PARTY";
  status: string;
  contentStatus: SellerContentStatus;
  supportEmail: string;
  commissionRate: number;
  createdAt: string;
  sellerUserCount: number;
  offerCount: number;
};

export async function listAdminSellers(
  opts: { q?: string; status?: string; type?: string } = {},
  client: Client = prisma,
): Promise<AdminSellerRow[]> {
  const where: Prisma.SellerWhereInput = {};
  if (opts.status) where.status = opts.status;
  if (opts.type) where.type = opts.type;
  if (opts.q?.trim()) {
    const q = opts.q.trim();
    where.OR = [
      { displayName: { contains: q, mode: "insensitive" } },
      { slug: { contains: q, mode: "insensitive" } },
      { supportEmail: { contains: q, mode: "insensitive" } },
    ];
  }

  const rows = await client.seller.findMany({
    where,
    orderBy: [{ createdAt: "desc" }],
    select: {
      id: true,
      displayName: true,
      slug: true,
      type: true,
      status: true,
      contentStatus: true,
      supportEmail: true,
      commissionRate: true,
      createdAt: true,
      _count: { select: { sellerUsers: true, offers: true } },
    },
  });

  return rows.map((r) => ({
    id: r.id,
    displayName: r.displayName,
    slug: r.slug,
    type: r.type === "FIRST_PARTY" ? "FIRST_PARTY" : "THIRD_PARTY",
    status: r.status,
    contentStatus: r.contentStatus as SellerContentStatus,
    supportEmail: r.supportEmail,
    commissionRate: r.commissionRate,
    createdAt: r.createdAt.toISOString(),
    sellerUserCount: r._count.sellerUsers,
    offerCount: r._count.offers,
  }));
}

/**
 * READ-ONLY (9F-5a) — a seller's listings (Offers) for the admin detail page.
 * The operator can see what a third-party seller lists against the catalog; it
 * carries no actions. Cross-seller by design (admin plane). Stock comes from the
 * authoritative `OfferInventory`, never `Variant.stock`.
 */
export type AdminSellerOfferRow = {
  id: string;
  productName: string;
  optionLabel: string;
  variantSku: string;
  sellerSku: string | null;
  condition: string;
  status: string;
  price: number;
  compareAtPrice: number | null;
  available: number;
  updatedAt: string;
};

export async function listSellerOffersForAdmin(
  sellerId: string,
  opts: { limit?: number } = {},
  client: Client = prisma,
): Promise<AdminSellerOfferRow[]> {
  const rows = await client.offer.findMany({
    where: { sellerId },
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
    take: Math.min(opts.limit ?? 100, 200),
    select: {
      id: true,
      condition: true,
      status: true,
      price: true,
      compareAtPrice: true,
      sellerSku: true,
      updatedAt: true,
      inventory: { select: { quantity: true, reserved: true } },
      variant: {
        select: {
          sku: true,
          product: { select: { name: true } },
          optionValues: {
            select: { optionValue: { select: { value: true, option: { select: { sortOrder: true } } } } },
          },
        },
      },
    },
  });
  return rows.map((o) => ({
    id: o.id,
    productName: o.variant.product.name,
    optionLabel:
      o.variant.optionValues
        .slice()
        .sort((a, b) => a.optionValue.option.sortOrder - b.optionValue.option.sortOrder)
        .map((ov) => ov.optionValue.value)
        .join(" · ") || "Default",
    variantSku: o.variant.sku,
    sellerSku: o.sellerSku,
    condition: o.condition,
    status: o.status,
    price: o.price,
    compareAtPrice: o.compareAtPrice,
    available: Math.max(0, (o.inventory?.quantity ?? 0) - (o.inventory?.reserved ?? 0)),
    updatedAt: o.updatedAt.toISOString(),
  }));
}

/**
 * READ-ONLY (9F-5b) — a seller's product requests for the admin detail page.
 * Minimal visibility only; the full review workflow (approve / reject / create
 * canonical Product) is 9F-5c. No actions here.
 */
export type AdminSellerRequestRow = {
  id: string;
  status: string;
  name: string;
  categoryName: string | null;
  submittedAt: string | null;
  updatedAt: string;
};

export async function listSellerProductRequestsForAdmin(
  sellerId: string,
  opts: { limit?: number } = {},
  client: Client = prisma,
): Promise<AdminSellerRequestRow[]> {
  const rows = await client.sellerProductRequest.findMany({
    where: { sellerId },
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
    take: Math.min(opts.limit ?? 50, 100),
    select: {
      id: true,
      status: true,
      proposedName: true,
      submittedAt: true,
      updatedAt: true,
      proposedCategory: { select: { name: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    name: r.proposedName,
    categoryName: r.proposedCategory?.name ?? null,
    submittedAt: r.submittedAt?.toISOString() ?? null,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function sellerStatusCounts(client: Client = prisma): Promise<Record<string, number>> {
  const rows = await client.seller.groupBy({ by: ["status"], _count: { _all: true } });
  const out: Record<string, number> = { PENDING: 0, APPROVED: 0, SUSPENDED: 0, CLOSED: 0 };
  for (const r of rows) out[r.status] = r._count._all;
  return out;
}

export type AdminSellerDetail = {
  id: string;
  displayName: string;
  slug: string;
  type: "FIRST_PARTY" | "THIRD_PARTY";
  status: string;
  supportEmail: string;
  notifyEmail: string | null;
  commissionRate: number;
  createdAt: string;
  updatedAt: string;
  content: {
    status: SellerContentStatus;
    submittedAt: string | null;
    reviewedAt: string | null;
    reviewedByEmail: string | null;
    reviewNote: string | null;
  };
  profile: {
    bio: string | null;
    returnPolicy: string | null;
    shippingPolicy: string | null;
    shipFromCity: string | null;
    shipFromCountry: string | null;
    socialLinks: SellerSocialLinks;
    logoUrl: string | null;
    bannerUrl: string | null;
  };
  offerCounts: Record<string, number>;
  sellerUsers: {
    id: string;
    userId: string;
    email: string;
    name: string | null;
    role: string;
    status: string;
    createdAt: string;
  }[];
  audit: { at: string; action: string; summary: string | null; actorEmail: string | null }[];
  allowedTransitions: SellerLifecycleStatus[];
};

function socialFrom(raw: unknown): SellerSocialLinks {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: SellerSocialLinks = {};
  for (const k of SELLER_SOCIAL_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === "string" && v) out[k] = v;
  }
  return out;
}

export async function getAdminSeller(id: string, client: Client = prisma): Promise<AdminSellerDetail | null> {
  const s = await client.seller.findUnique({
    where: { id },
    select: {
      id: true,
      displayName: true,
      slug: true,
      type: true,
      status: true,
      supportEmail: true,
      notifyEmail: true,
      commissionRate: true,
      createdAt: true,
      updatedAt: true,
      contentStatus: true,
      contentSubmittedAt: true,
      contentReviewedAt: true,
      contentReviewedBy: true,
      contentReviewNote: true,
      bio: true,
      returnPolicy: true,
      shippingPolicy: true,
      shipFromCity: true,
      shipFromCountry: true,
      socialLinks: true,
      logoMedia: { select: { url: true, mimeType: true } },
      bannerMedia: { select: { url: true, mimeType: true } },
      sellerUsers: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          userId: true,
          role: true,
          status: true,
          createdAt: true,
          user: { select: { email: true, name: true } },
        },
      },
    },
  });
  if (!s) return null;

  const suIds = s.sellerUsers.map((u) => u.id);
  const [offerGroups, reviewer, audit] = await Promise.all([
    client.offer.groupBy({ by: ["status"], where: { sellerId: id }, _count: { _all: true } }),
    s.contentReviewedBy
      ? client.user.findUnique({ where: { id: s.contentReviewedBy }, select: { email: true } })
      : Promise.resolve(null),
    client.adminAuditLog.findMany({
      where: {
        OR: [
          { targetType: "seller", targetId: id },
          ...(suIds.length ? [{ targetType: "seller_user", targetId: { in: suIds } }] : []),
        ],
        action: { startsWith: "seller" },
      },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { createdAt: true, action: true, summary: true, actor: { select: { email: true } } },
    }),
  ]);

  const offerCounts: Record<string, number> = { DRAFT: 0, ACTIVE: 0, INACTIVE: 0, ARCHIVED: 0 };
  for (const g of offerGroups) offerCounts[g.status] = g._count._all;

  const isImg = (m?: { url: string; mimeType: string } | null) =>
    m && m.mimeType.startsWith("image/") ? m.url : null;

  return {
    id: s.id,
    displayName: s.displayName,
    slug: s.slug,
    type: s.type === "FIRST_PARTY" ? "FIRST_PARTY" : "THIRD_PARTY",
    status: s.status,
    supportEmail: s.supportEmail,
    notifyEmail: s.notifyEmail,
    commissionRate: s.commissionRate,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    content: {
      status: s.contentStatus as SellerContentStatus,
      submittedAt: s.contentSubmittedAt?.toISOString() ?? null,
      reviewedAt: s.contentReviewedAt?.toISOString() ?? null,
      reviewedByEmail: reviewer?.email ?? null,
      reviewNote: s.contentReviewNote,
    },
    profile: {
      bio: s.bio,
      returnPolicy: s.returnPolicy,
      shippingPolicy: s.shippingPolicy,
      shipFromCity: s.shipFromCity,
      shipFromCountry: s.shipFromCountry,
      socialLinks: socialFrom(s.socialLinks),
      logoUrl: isImg(s.logoMedia),
      bannerUrl: isImg(s.bannerMedia),
    },
    offerCounts,
    sellerUsers: s.sellerUsers.map((u) => ({
      id: u.id,
      userId: u.userId,
      email: u.user.email,
      name: u.user.name,
      role: u.role,
      status: u.status,
      createdAt: u.createdAt.toISOString(),
    })),
    audit: audit.map((a) => ({
      at: a.createdAt.toISOString(),
      action: a.action,
      summary: a.summary,
      actorEmail: a.actor?.email ?? null,
    })),
    allowedTransitions: (SELLER_TRANSITIONS[s.status as SellerLifecycleStatus] ?? []) as SellerLifecycleStatus[],
  };
}

// ---------------------------------------------------------------------------
// Writes — lifecycle
// ---------------------------------------------------------------------------

export type TransitionResult =
  | { ok: true; sellerId: string; displayName: string; from: string; to: SellerLifecycleStatus; reactivate: boolean }
  | AdminSellerError
  | { ok: false; code: "CONFLICT"; error: string };

export async function transitionSellerStatus(
  sellerId: string,
  to: SellerLifecycleStatus,
  client: Client = prisma,
): Promise<TransitionResult> {
  const seller = await client.seller.findUnique({
    where: { id: sellerId },
    select: { id: true, displayName: true, status: true },
  });
  if (!seller) return { ok: false, code: "NOT_FOUND", error: "Seller not found." };
  if (seller.status === to) {
    return { ok: true, sellerId, displayName: seller.displayName, from: seller.status, to, reactivate: false };
  }
  if (!canTransitionSeller(seller.status, to)) {
    return { ok: false, code: "INVALID_TRANSITION", error: `Can't move a seller from ${seller.status} to ${to}.` };
  }

  const advanced = await client.seller.updateMany({
    where: { id: sellerId, status: seller.status },
    data: { status: to },
  });
  if (advanced.count === 0) {
    return { ok: false, code: "CONFLICT", error: "The seller's status changed. Reload and try again." };
  }

  return {
    ok: true,
    sellerId,
    displayName: seller.displayName,
    from: seller.status,
    to,
    reactivate: seller.status === "SUSPENDED" && to === "APPROVED",
  };
}

// ---------------------------------------------------------------------------
// Writes — config
// ---------------------------------------------------------------------------

export type SellerConfigPatch = Partial<{
  displayName: string;
  supportEmail: string;
  notifyEmail: string | null;
  commissionRate: number;
  slug: string;
}>;

export type ConfigResult =
  | { ok: true; sellerId: string; displayName: string; changes: Record<string, unknown>; previousSlug: string }
  | AdminSellerError;

export async function updateSellerConfig(
  sellerId: string,
  patch: SellerConfigPatch,
  client: Client = prisma,
): Promise<ConfigResult> {
  const seller = await client.seller.findUnique({
    where: { id: sellerId },
    select: { id: true, displayName: true, slug: true, commissionRate: true },
  });
  if (!seller) return { ok: false, code: "NOT_FOUND", error: "Seller not found." };

  const data: Prisma.SellerUpdateInput = {};
  const changes: Record<string, unknown> = {};

  if (patch.displayName !== undefined) {
    const dn = cleanUserText(patch.displayName);
    if (dn.length < 2 || dn.length > 80) {
      return { ok: false, code: "VALIDATION", error: "Display name must be 2–80 characters." };
    }
    data.displayName = dn;
    changes.displayName = dn;
  }

  if (patch.supportEmail !== undefined) {
    const e = patch.supportEmail.trim().toLowerCase();
    if (!EMAIL_RE.test(e)) return { ok: false, code: "VALIDATION", error: "Enter a valid support email." };
    data.supportEmail = e;
    changes.supportEmail = e;
  }

  if (patch.notifyEmail !== undefined) {
    if (patch.notifyEmail == null || patch.notifyEmail.trim() === "") {
      data.notifyEmail = null;
      changes.notifyEmail = null;
    } else {
      const e = patch.notifyEmail.trim().toLowerCase();
      if (!EMAIL_RE.test(e)) return { ok: false, code: "VALIDATION", error: "Enter a valid notification email." };
      data.notifyEmail = e;
      changes.notifyEmail = e;
    }
  }

  if (patch.commissionRate !== undefined) {
    const c = validateCommissionBps(patch.commissionRate);
    if (!c.ok) return { ok: false, code: "VALIDATION", error: c.error };
    data.commissionRate = c.bps;
    changes.commissionRate = c.bps;
  }

  if (patch.slug !== undefined && patch.slug.trim().toLowerCase() !== seller.slug) {
    const check = validateSellerSlug(patch.slug);
    if (!check.ok) return { ok: false, code: "VALIDATION", error: check.error };
    const clash = await client.seller.findFirst({
      where: { slug: check.slug, id: { not: sellerId } },
      select: { id: true },
    });
    if (clash) return { ok: false, code: "CONFLICT", error: "That slug is already taken." };
    data.slug = check.slug;
    changes.slug = check.slug;
  }

  if (Object.keys(data).length > 0) {
    await client.seller.update({ where: { id: sellerId }, data });
  }

  return { ok: true, sellerId, displayName: seller.displayName, changes, previousSlug: seller.slug };
}

// ---------------------------------------------------------------------------
// Writes — create
// ---------------------------------------------------------------------------

export type CreateSellerInput = {
  displayName: string;
  slug: string;
  supportEmail: string;
  commissionRate?: number;
};

export type CreateResult =
  | { ok: true; sellerId: string; displayName: string; slug: string; commissionRate: number }
  | AdminSellerError;

export async function createSeller(input: CreateSellerInput, client: Client = prisma): Promise<CreateResult> {
  const displayName = cleanUserText(input.displayName);
  if (displayName.length < 2 || displayName.length > 80) {
    return { ok: false, code: "VALIDATION", error: "Display name must be 2–80 characters." };
  }
  const slugCheck = validateSellerSlug(input.slug);
  if (!slugCheck.ok) return { ok: false, code: "VALIDATION", error: slugCheck.error };
  const supportEmail = input.supportEmail.trim().toLowerCase();
  if (!EMAIL_RE.test(supportEmail)) {
    return { ok: false, code: "VALIDATION", error: "Enter a valid support email." };
  }
  const commission = validateCommissionBps(input.commissionRate ?? DEFAULT_SELLER_COMMISSION_BPS);
  if (!commission.ok) return { ok: false, code: "VALIDATION", error: commission.error };

  const clash = await client.seller.findUnique({ where: { slug: slugCheck.slug }, select: { id: true } });
  if (clash) return { ok: false, code: "CONFLICT", error: "That slug is already taken." };

  const created = await client.seller.create({
    data: {
      type: "THIRD_PARTY", // never FIRST_PARTY from this workflow (spec 4)
      status: "PENDING", // spec 4 — always starts PENDING
      displayName,
      slug: slugCheck.slug,
      supportEmail,
      commissionRate: commission.bps,
      contentStatus: "DRAFT",
    },
    select: { id: true },
  });

  return { ok: true, sellerId: created.id, displayName, slug: slugCheck.slug, commissionRate: commission.bps };
}
