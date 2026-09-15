"use server";

import { requirePermission } from "@/lib/admin/rbac";
import { getSellerVerificationDocumentSignedUrlForAdmin } from "@/lib/seller-verification/repository";

/**
 * Admin Seller Verification — authorization boundary ONLY (Phase 3
 * foundation). No admin review UI exists yet and nothing calls this
 * function — it exists so a future review page has a ready, already-correct
 * server action to call, rather than inventing its own authorization at
 * that point.
 *
 * Reuses `manage_settings` — the SAME permission `admin/sellers/actions.ts`
 * already requires for seller lifecycle decisions (approve/suspend/close).
 * No new permission was added, and `scripts/seed-rbac.ts` is untouched.
 */
export async function getSellerVerificationDocumentSignedUrlForAdminAction(
  documentId: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  await requirePermission("manage_settings");
  if (!documentId || typeof documentId !== "string") return { ok: false, error: "Invalid request." };
  return getSellerVerificationDocumentSignedUrlForAdmin(documentId);
}
