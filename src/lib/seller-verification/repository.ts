import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SellerContext } from "@/lib/marketplace/types";

/**
 * Seller Verification — identity/business draft repository (Phase 2).
 *
 * Every function takes a `SellerContext` (from `requireSellerSessionPermission`,
 * never a client-supplied sellerId) and re-scopes every query to
 * `ctx.sellerId` inside its own transaction — the same discipline as
 * `seller-profile-repository.ts`'s `updateSellerProfileDraft`. There is no
 * function anywhere in this module that reads or writes a verification row
 * by a caller-supplied id; a seller can only ever reach its OWN row.
 *
 * A seller can accumulate more than one `SellerVerification` row over time
 * (a rejected one, then a fresh resubmission — see the model's own doc
 * comment), so every read/write here operates on the LATEST row only,
 * ordered by `createdAt`. This phase never creates a row automatically —
 * `getSellerVerification` returns `null` until the seller explicitly saves a
 * draft for the first time.
 */

const VERIFICATION_SELECT = {
  id: true,
  sellerId: true,
  status: true,
  submittedAt: true,
  reviewedAt: true,
  reviewNote: true,
  legalName: true,
  phone: true,
  phoneVerifiedAt: true,
  addressLine1: true,
  addressLine2: true,
  barangay: true,
  city: true,
  province: true,
  postalCode: true,
  country: true,
  businessType: true,
  businessName: true,
  businessRegistrationNumber: true,
  dtiRegistrationNumber: true,
  secRegistrationNumber: true,
  tin: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type SellerVerificationView = Prisma.SellerVerificationGetPayload<{ select: typeof VERIFICATION_SELECT }>;

export type SellerVerificationDraftPatch = {
  legalName: string | null;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  barangay: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  country: string | null;
  businessType: string | null;
  businessName: string | null;
  businessRegistrationNumber: string | null;
  dtiRegistrationNumber: string | null;
  secRegistrationNumber: string | null;
  tin: string | null;
};

export type SellerVerificationResult =
  | { ok: true; verification: SellerVerificationView }
  | { ok: false; error: string };

/** The seller's own latest verification row, or null if it has never started one. */
export async function getSellerVerification(
  ctx: SellerContext,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<SellerVerificationView | null> {
  return client.sellerVerification.findFirst({
    where: { sellerId: ctx.sellerId },
    orderBy: { createdAt: "desc" },
    select: VERIFICATION_SELECT,
  });
}

/**
 * Save a draft. Creates a new row (status DRAFT) the FIRST time this seller
 * explicitly saves — never automatically, never on merely viewing the page.
 * On every later save, updates that same row in place as long as it is still
 * DRAFT. If the seller's latest row has already moved past DRAFT (a later
 * phase's PENDING/APPROVED/REJECTED — unreachable in this phase, but handled
 * correctly for when it is), a fresh DRAFT row is created instead of
 * mutating a submitted/reviewed one out from under a reviewer.
 */
export async function saveSellerVerificationDraft(
  ctx: SellerContext,
  patch: SellerVerificationDraftPatch,
  externalTx?: Prisma.TransactionClient,
): Promise<SellerVerificationResult> {
  const run = async (tx: Prisma.TransactionClient): Promise<SellerVerificationResult> => {
    const existing = await tx.sellerVerification.findFirst({
      where: { sellerId: ctx.sellerId },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true },
    });

    const verification =
      existing && existing.status === "DRAFT"
        ? await tx.sellerVerification.update({
            where: { id: existing.id },
            data: patch,
            select: VERIFICATION_SELECT,
          })
        : await tx.sellerVerification.create({
            data: { sellerId: ctx.sellerId, status: "DRAFT", ...patch },
            select: VERIFICATION_SELECT,
          });

    return { ok: true, verification };
  };

  try {
    return externalTx ? await run(externalTx) : await prisma.$transaction(run);
  } catch (err) {
    console.error("[seller-verification-repository] saveSellerVerificationDraft failed", err);
    return { ok: false, error: "Could not save your verification details." };
  }
}
