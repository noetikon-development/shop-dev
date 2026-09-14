import type { Metadata } from "next";
import { requireSellerSessionPermission } from "@/lib/seller/session";
import { getSellerVerification } from "@/lib/seller-verification/repository";
import { PageHeader, Card, StatusBadge } from "@/components/seller/ui";
import { SellerVerificationForm } from "@/components/seller/verification-form";

export const metadata: Metadata = { title: "Verification" };

const STATUS_TONE: Record<string, "neutral" | "warning" | "success" | "danger"> = {
  DRAFT: "neutral",
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "danger",
};

/**
 * Seller Verification — identity/business information (Phase 2).
 *
 * `requireSellerSessionPermission("manage_seller_settings")` is the SAME gate
 * `/seller/settings` uses (OWNER + MANAGER) — the session helper itself
 * derives `ctx.sellerId` from the caller's own ACTIVE SellerUser membership,
 * so this page can never load or accidentally leak another seller's record.
 * An unauthenticated visitor is redirected to `/seller/login`; a signed-in
 * user with no usable membership (or only STAFF) gets a real 403 — neither
 * ever reaches this page body.
 *
 * No SellerVerification row is created just by visiting this page — it stays
 * null (and the form starts blank) until the seller explicitly saves a draft.
 */
export default async function SellerVerificationPage() {
  const { ctx } = await requireSellerSessionPermission("manage_seller_settings");
  const verification = await getSellerVerification(ctx);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Seller verification"
        description="Identity and business information Axiaro uses to verify your seller account. Saved as a draft — nothing here is submitted for review yet, and document upload is a later step."
        actions={
          <StatusBadge tone={STATUS_TONE[verification?.status ?? "DRAFT"] ?? "neutral"}>
            {verification?.status ?? "Not started"}
          </StatusBadge>
        }
      />

      <Card>
        <SellerVerificationForm verification={verification} />
      </Card>
    </div>
  );
}
