import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { cleanUserText } from "@/lib/ugc";
import { isSupportedCountry } from "@/lib/countries";
import {
  SELLER_SOCIAL_KEYS,
  type SellerContext,
  type SellerContentStatus,
  type SellerProfileDraft,
  type SellerSettingsView,
  type SellerSocialLinks,
} from "@/lib/marketplace/types";

/**
 * Seller-scoped store-profile data access (Phase 9F-4a).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The ONLY sanctioned way for seller-plane code (`/seller/settings` + its
 * actions) to read or write the `Seller` store-profile columns.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Isolation contract (same as every other seller-*-repository):
 *   - every function REQUIRES a `SellerContext` and scopes to `ctx.sellerId`;
 *   - the write is `where: { id: ctx.sellerId }` — a seller can only ever touch
 *     its own row;
 *   - the protected operator columns (`type`, `status`, `slug`, `commissionRate`,
 *     `displayName`) are NEVER in any update payload built here.
 *
 * Moderation. The profile bundle (bio … socialLinks + logo/banner) carries a
 * `contentStatus`: DRAFT → PENDING → APPROVED. The seller submits (DRAFT →
 * PENDING); an admin with `manage_content` approves (→ APPROVED) or rejects
 * (→ DRAFT). Editing an APPROVED bundle drops it back to PENDING. The seller can
 * never set APPROVED. `notifyEmail` / `supportEmail` are operational contacts —
 * saved immediately, NOT part of the bundle.
 *
 * Nothing here is rendered to customers in 9F-4a.
 */

type Client = Prisma.TransactionClient | typeof prisma;

export type SellerProfileError =
  | { ok: false; code: "NOT_FOUND"; error: string }
  | { ok: false; code: "VALIDATION"; error: string }
  | { ok: false; code: "CONFLICT"; error: string };

export type SellerProfileResult = { ok: true; contentStatus: SellerContentStatus } | SellerProfileError;

const BIO_MAX = 1200;
const POLICY_MAX = 2000;
const CITY_MAX = 80;
const LINK_MAX = 300;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PROFILE_SELECT = {
  id: true,
  displayName: true,
  slug: true,
  status: true,
  supportEmail: true,
  notifyEmail: true,
  bio: true,
  logoMediaId: true,
  bannerMediaId: true,
  returnPolicy: true,
  shippingPolicy: true,
  shipFromCity: true,
  shipFromCountry: true,
  socialLinks: true,
  contentStatus: true,
  contentSubmittedAt: true,
  contentReviewedAt: true,
  contentReviewNote: true,
  logoMedia: { select: { url: true, mimeType: true } },
  bannerMedia: { select: { url: true, mimeType: true } },
} satisfies Prisma.SellerSelect;

function parseSocial(raw: Prisma.JsonValue | null | undefined): SellerSocialLinks {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: SellerSocialLinks = {};
  for (const k of SELLER_SOCIAL_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === "string" && v) out[k] = v;
  }
  return out;
}

/** The full settings view for `/seller/settings`. `null` iff the seller row is gone. */
export async function getSellerSettings(
  ctx: SellerContext,
  client: Client = prisma,
): Promise<SellerSettingsView | null> {
  const row = await client.seller.findFirst({
    where: { id: ctx.sellerId },
    select: PROFILE_SELECT,
  });
  if (!row) return null;

  const isImg = (m?: { url: string; mimeType: string } | null) =>
    m && m.mimeType.startsWith("image/") ? m.url : null;

  return {
    sellerId: row.id,
    displayName: row.displayName,
    slug: row.slug,
    status: row.status as SellerSettingsView["status"],
    supportEmail: row.supportEmail,
    notifyEmail: row.notifyEmail,
    profile: {
      bio: row.bio,
      logoMediaId: row.logoMediaId,
      bannerMediaId: row.bannerMediaId,
      returnPolicy: row.returnPolicy,
      shippingPolicy: row.shippingPolicy,
      shipFromCity: row.shipFromCity,
      shipFromCountry: row.shipFromCountry,
      socialLinks: parseSocial(row.socialLinks),
    },
    logoUrl: isImg(row.logoMedia),
    bannerUrl: isImg(row.bannerMedia),
    contentStatus: row.contentStatus as SellerContentStatus,
    contentSubmittedAt: row.contentSubmittedAt?.toISOString() ?? null,
    contentReviewedAt: row.contentReviewedAt?.toISOString() ?? null,
    contentReviewNote: row.contentReviewNote,
  };
}

/** Just the moderation status — cheap, for dashboards / nav badges. */
export async function getSellerContentStatus(
  ctx: SellerContext,
  client: Client = prisma,
): Promise<SellerContentStatus | null> {
  const row = await client.seller.findFirst({
    where: { id: ctx.sellerId },
    select: { contentStatus: true },
  });
  return (row?.contentStatus as SellerContentStatus | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type SellerProfilePatch = Partial<{
  bio: string | null;
  returnPolicy: string | null;
  shippingPolicy: string | null;
  shipFromCity: string | null;
  shipFromCountry: string | null;
  socialLinks: SellerSocialLinks;
}>;

function validateAndCleanPatch(
  patch: SellerProfilePatch,
): { ok: true; data: Prisma.SellerUncheckedUpdateInput } | SellerProfileError {
  const data: Prisma.SellerUncheckedUpdateInput = {};

  const text = (v: string | null | undefined, max: number, label: string) => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    const clean = cleanUserText(v);
    if (clean.length > max) throw new RangeError(`${label} must be ${max} characters or fewer.`);
    return clean || null;
  };

  try {
    if ("bio" in patch) data.bio = text(patch.bio, BIO_MAX, "About");
    if ("returnPolicy" in patch) data.returnPolicy = text(patch.returnPolicy, POLICY_MAX, "Return policy");
    if ("shippingPolicy" in patch)
      data.shippingPolicy = text(patch.shippingPolicy, POLICY_MAX, "Shipping policy");
    if ("shipFromCity" in patch) data.shipFromCity = text(patch.shipFromCity, CITY_MAX, "Ship-from city");
  } catch (e) {
    return { ok: false, code: "VALIDATION", error: e instanceof Error ? e.message : "Invalid input." };
  }

  if ("shipFromCountry" in patch) {
    const c = patch.shipFromCountry;
    if (c == null || c === "") {
      data.shipFromCountry = null;
    } else if (!isSupportedCountry(c)) {
      return { ok: false, code: "VALIDATION", error: "That country isn't on the supported list." };
    } else {
      data.shipFromCountry = c;
    }
  }

  if ("socialLinks" in patch) {
    const links = patch.socialLinks ?? {};
    const clean: SellerSocialLinks = {};
    for (const k of SELLER_SOCIAL_KEYS) {
      const v = links[k];
      if (v == null || v === "") continue;
      const trimmed = String(v).trim();
      if (trimmed.length > LINK_MAX) {
        return { ok: false, code: "VALIDATION", error: `The ${k} link is too long.` };
      }
      let url: URL;
      try {
        url = new URL(trimmed);
      } catch {
        return { ok: false, code: "VALIDATION", error: `The ${k} link must be a full https:// URL.` };
      }
      if (url.protocol !== "https:") {
        return { ok: false, code: "VALIDATION", error: `The ${k} link must use https://.` };
      }
      clean[k] = url.toString();
    }
    data.socialLinks = clean as Prisma.InputJsonValue;
  }

  return { ok: true, data };
}

// ---------------------------------------------------------------------------
// Writes — always scoped to ctx.sellerId
// ---------------------------------------------------------------------------

/**
 * Apply a bundle change. If the bundle was APPROVED it drops back to PENDING and
 * a fresh review cycle begins. DRAFT / PENDING keep their status. Never sets
 * APPROVED. Returns the resulting `contentStatus`.
 */
async function writeBundle(
  tx: Prisma.TransactionClient,
  ctx: SellerContext,
  data: Prisma.SellerUncheckedUpdateInput,
): Promise<SellerProfileResult> {
  const current = await tx.seller.findFirst({
    where: { id: ctx.sellerId },
    select: { contentStatus: true },
  });
  if (!current) return { ok: false, code: "NOT_FOUND", error: "Seller not found." };

  const next: Prisma.SellerUncheckedUpdateInput = { ...data };
  let resultStatus = current.contentStatus as SellerContentStatus;
  if (current.contentStatus === "APPROVED") {
    next.contentStatus = "PENDING";
    next.contentSubmittedAt = new Date();
    next.contentReviewedAt = null;
    next.contentReviewedBy = null;
    next.contentReviewNote = null;
    resultStatus = "PENDING";
  }

  await tx.seller.update({ where: { id: ctx.sellerId }, data: next });
  return { ok: true, contentStatus: resultStatus };
}

/** Edit the moderated store-profile bundle (text fields + social links). */
export async function updateSellerProfileDraft(
  ctx: SellerContext,
  patch: SellerProfilePatch,
  externalTx?: Prisma.TransactionClient,
): Promise<SellerProfileResult> {
  const validated = validateAndCleanPatch(patch);
  if (!validated.ok) return validated;
  if (Object.keys(validated.data).length === 0) {
    const status = await getSellerContentStatus(ctx, externalTx ?? prisma);
    return status ? { ok: true, contentStatus: status } : { ok: false, code: "NOT_FOUND", error: "Seller not found." };
  }

  const run = (tx: Prisma.TransactionClient) => writeBundle(tx, ctx, validated.data);
  try {
    if (externalTx) return await run(externalTx);
    return await prisma.$transaction(run);
  } catch (err) {
    console.error("[seller-profile-repository] updateSellerProfileDraft failed", err);
    return { ok: false, code: "VALIDATION", error: "Could not save your profile." };
  }
}

/**
 * Point the seller's logo or banner at one of its OWN media assets, or clear it
 * (`mediaId = null`). The asset must belong to this seller and be an image.
 * Counts as a bundle edit (APPROVED → PENDING).
 */
export async function setSellerProfileImage(
  ctx: SellerContext,
  slot: "logo" | "banner",
  mediaId: string | null,
  externalTx?: Prisma.TransactionClient,
): Promise<SellerProfileResult> {
  const run = async (tx: Prisma.TransactionClient): Promise<SellerProfileResult> => {
    if (mediaId) {
      const asset = await tx.mediaAsset.findFirst({
        where: { id: mediaId, sellerId: ctx.sellerId },
        select: { id: true, mimeType: true },
      });
      if (!asset) return { ok: false, code: "NOT_FOUND", error: "That image isn't in your media library." };
      if (!asset.mimeType.startsWith("image/")) {
        return { ok: false, code: "VALIDATION", error: "The logo and banner must be image files." };
      }
    }
    const data: Prisma.SellerUncheckedUpdateInput =
      slot === "logo" ? { logoMediaId: mediaId } : { bannerMediaId: mediaId };
    return writeBundle(tx, ctx, data);
  };

  try {
    if (externalTx) return await run(externalTx);
    return await prisma.$transaction(run);
  } catch (err) {
    console.error("[seller-profile-repository] setSellerProfileImage failed", err);
    return { ok: false, code: "VALIDATION", error: "Could not update the image." };
  }
}

/** Submit the DRAFT bundle for admin review (DRAFT → PENDING). Idempotent for PENDING/APPROVED. */
export async function submitSellerProfile(
  ctx: SellerContext,
  externalTx?: Prisma.TransactionClient,
): Promise<SellerProfileResult> {
  const run = async (tx: Prisma.TransactionClient): Promise<SellerProfileResult> => {
    const current = await tx.seller.findFirst({
      where: { id: ctx.sellerId },
      select: { contentStatus: true },
    });
    if (!current) return { ok: false, code: "NOT_FOUND", error: "Seller not found." };
    if (current.contentStatus !== "DRAFT") {
      return { ok: true, contentStatus: current.contentStatus as SellerContentStatus };
    }
    await tx.seller.update({
      where: { id: ctx.sellerId },
      data: { contentStatus: "PENDING", contentSubmittedAt: new Date(), contentReviewNote: null },
    });
    return { ok: true, contentStatus: "PENDING" };
  };

  try {
    if (externalTx) return await run(externalTx);
    return await prisma.$transaction(run);
  } catch (err) {
    console.error("[seller-profile-repository] submitSellerProfile failed", err);
    return { ok: false, code: "VALIDATION", error: "Could not submit your profile for review." };
  }
}

/** Operational contact — saved immediately, no moderation, no bundle effect. */
export async function updateSellerContact(
  ctx: SellerContext,
  patch: { supportEmail?: string; notifyEmail?: string | null },
  externalTx?: Prisma.TransactionClient,
): Promise<{ ok: true } | SellerProfileError> {
  const data: Prisma.SellerUncheckedUpdateInput = {};
  if (patch.supportEmail !== undefined) {
    const e = patch.supportEmail.trim().toLowerCase();
    if (!EMAIL_RE.test(e)) return { ok: false, code: "VALIDATION", error: "Enter a valid support email." };
    data.supportEmail = e;
  }
  if (patch.notifyEmail !== undefined) {
    if (patch.notifyEmail == null || patch.notifyEmail.trim() === "") {
      data.notifyEmail = null;
    } else {
      const e = patch.notifyEmail.trim().toLowerCase();
      if (!EMAIL_RE.test(e)) return { ok: false, code: "VALIDATION", error: "Enter a valid notification email." };
      data.notifyEmail = e;
    }
  }
  if (Object.keys(data).length === 0) return { ok: true };

  const run = async (tx: Prisma.TransactionClient): Promise<{ ok: true } | SellerProfileError> => {
    const exists = await tx.seller.findFirst({ where: { id: ctx.sellerId }, select: { id: true } });
    if (!exists) return { ok: false, code: "NOT_FOUND", error: "Seller not found." };
    await tx.seller.update({ where: { id: ctx.sellerId }, data });
    return { ok: true };
  };

  try {
    if (externalTx) return await run(externalTx);
    return await prisma.$transaction(run);
  } catch (err) {
    console.error("[seller-profile-repository] updateSellerContact failed", err);
    return { ok: false, code: "VALIDATION", error: "Could not save your contact settings." };
  }
}

/** The exact set of `Seller` columns the seller plane must NEVER write. */
export const SELLER_PROTECTED_FIELDS = [
  "type",
  "status",
  "slug",
  "commissionRate",
  "displayName",
  "contentReviewedBy",
] as const;

export type { SellerProfileDraft };
