import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getCheckoutData } from "@/lib/checkout";
import { CheckoutFlow } from "@/components/checkout/checkout-flow";

export const metadata: Metadata = { title: "Checkout" };

export default async function CheckoutPage() {
  await requireUser("/checkout");
  const data = await getCheckoutData();

  return (
    <div className="container-page py-6 sm:py-10">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-3xl sm:text-[2.5rem]">Checkout</h1>
        <Link href="/cart" className="text-sm text-ink-soft underline underline-offset-4">
          Back to bag
        </Link>
      </div>
      <CheckoutFlow data={data} />
    </div>
  );
}
