import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { SellerApplyForm } from "@/components/seller-onboarding/apply-form";

export const metadata: Metadata = {
  title: "Apply to sell",
  description: "Apply to become an Axiaro seller.",
};

export default async function SellerApplyPage() {
  // Existing-account requirement — same auth/redirect pattern every other
  // account-gated page in the storefront uses. Nothing else on this page
  // reads or trusts anything but the id this returns.
  await requireUser("/sell-on-axiaro/apply");

  return (
    <div className="container-page py-10">
      <p className="eyebrow">Sell on Axiaro</p>
      <h1 className="mt-2 max-w-2xl text-title sm:text-display">Apply to become a seller</h1>
      <p className="mt-3 max-w-xl text-ink-soft">
        Tell us a bit about your store. We review every application — you'll hear back by email.
      </p>

      <div className="mt-8">
        <SellerApplyForm />
      </div>
    </div>
  );
}
