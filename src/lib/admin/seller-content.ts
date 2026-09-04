import "server-only";
import { prisma } from "@/lib/prisma";
import type { SellerContentStatus, SellerSocialLinks } from "@/lib/marketplace/types";
import { SELLER_SOCIAL_KEYS } from "@/lib/marketplace/types";

/**
 * Admin read layer for seller store-profile review (Phase 9F-4a).
 *
 * This is the OPERATOR plane — deliberately cross-seller. Reviewing requires
 * `manage_content` (checked by the page / actions). Uncached; reviewers see
 * live data.
 *
 * 9F-4a scope is the CONTENT REVIEW QUEUE only. Full seller lifecycle
 * management (create / approve seller / suspend / slug / commission / users)
 * is 9F-4b and is not implemented here.
 */

export type SellerContentRow = {
  sellerId: string;
  displayName: string;
  slug: string;
  sellerStatus: string;
  contentStatus: SellerContentStatus;
  submittedAt: string | null;
  reviewedAt: string | null;
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

/**
 * The review queue. Defaults to everything awaiting review (PENDING); pass
 * `status` to widen. THIRD_PARTY sellers only — Axiaro's own row never needs
 * review.
 */
export async function listSellerContent(opts: { status?: SellerContentStatus | "ALL" } = {}) {
  const status = opts.status ?? "PENDING";
  const rows = await prisma.seller.findMany({
    where: {
      type: "THIRD_PARTY",
      ...(status === "ALL" ? {} : { contentStatus: status }),
    },
    orderBy: [{ contentSubmittedAt: "asc" }, { updatedAt: "desc" }],
    select: {
      id: true,
      displayName: true,
      slug: true,
      status: true,
      contentStatus: true,
      contentSubmittedAt: true,
      contentReviewedAt: true,
    },
  });
  return rows.map<SellerContentRow>((r) => ({
    sellerId: r.id,
    displayName: r.displayName,
    slug: r.slug,
    sellerStatus: r.status,
    contentStatus: r.contentStatus as SellerContentStatus,
    submittedAt: r.contentSubmittedAt?.toISOString() ?? null,
    reviewedAt: r.contentReviewedAt?.toISOString() ?? null,
  }));
}

export async function countPendingSellerContent(): Promise<number> {
  return prisma.seller.count({ where: { type: "THIRD_PARTY", contentStatus: "PENDING" } });
}

export type AdminSellerContentDetail = {
  sellerId: string;
  displayName: string;
  slug: string;
  sellerStatus: string;
  supportEmail: string;
  contentStatus: SellerContentStatus;
  submittedAt: string | null;
  reviewedAt: string | null;
  reviewedByEmail: string | null;
  reviewNote: string | null;
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
  /** Prior review actions on this seller, newest first. */
  history: { at: string; action: string; summary: string | null }[];
};

export async function getAdminSellerContent(sellerId: string): Promise<AdminSellerContentDetail | null> {
  const s = await prisma.seller.findUnique({
    where: { id: sellerId },
    select: {
      id: true,
      displayName: true,
      slug: true,
      status: true,
      supportEmail: true,
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
    },
  });
  if (!s) return null;

  const reviewer = s.contentReviewedBy
    ? await prisma.user.findUnique({ where: { id: s.contentReviewedBy }, select: { email: true } })
    : null;

  const history = await prisma.adminAuditLog.findMany({
    where: { targetType: "seller", targetId: sellerId, action: { startsWith: "seller." } },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { createdAt: true, action: true, summary: true },
  });

  const isImg = (m?: { url: string; mimeType: string } | null) =>
    m && m.mimeType.startsWith("image/") ? m.url : null;

  return {
    sellerId: s.id,
    displayName: s.displayName,
    slug: s.slug,
    sellerStatus: s.status,
    supportEmail: s.supportEmail,
    contentStatus: s.contentStatus as SellerContentStatus,
    submittedAt: s.contentSubmittedAt?.toISOString() ?? null,
    reviewedAt: s.contentReviewedAt?.toISOString() ?? null,
    reviewedByEmail: reviewer?.email ?? null,
    reviewNote: s.contentReviewNote,
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
    history: history.map((h) => ({
      at: h.createdAt.toISOString(),
      action: h.action,
      summary: h.summary,
    })),
  };
}
