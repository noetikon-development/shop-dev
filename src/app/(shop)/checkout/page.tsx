import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getCheckoutData } from "@/lib/checkout";
import { CheckoutFlow } from "@/components/checkout/checkout-flow";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = { title: "Checkout" };

export default async function CheckoutPage() {
  await requireUser("/checkout");
  const data = await getCheckoutData();

  return (
    <div className="container-page py-6 sm:py-10">
      <PageHeader title="Checkout">
        <Link
          href="/cart"
          className="text-meta font-medium text-ink-soft underline underline-offset-4 hover:text-ink"
        >
          Back to cart
        </Link>
      </PageHeader>
      <CheckoutFlow data={data} />
    </div>
  );
}
