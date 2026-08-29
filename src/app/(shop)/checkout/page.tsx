import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { CheckoutForm } from "@/components/checkout/checkout-form";

export const metadata: Metadata = { title: "Checkout" };

export default async function CheckoutPage() {
  const currentUser = await getCurrentUser();
  let prefill = {
    email: currentUser?.email ?? "",
    phone: "",
    address: {} as Record<string, string>,
    signedIn: Boolean(currentUser),
  };

  if (currentUser) {
    const address = await prisma.address.findFirst({
      where: { userId: currentUser.id },
      orderBy: { isDefault: "desc" },
    });
    prefill = {
      ...prefill,
      phone: currentUser.phone ?? address?.phone ?? "",
      address: address
        ? {
            recipient: address.recipient,
            line1: address.line1,
            line2: address.line2 ?? "",
            barangay: address.barangay ?? "",
            city: address.city,
            province: address.province,
            region: address.region ?? "",
            postalCode: address.postalCode,
          }
        : {},
    };
  }

  return (
    <div className="container-page py-6 sm:py-10">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-3xl sm:text-[2.5rem]">Checkout</h1>
        <Link href="/cart" className="text-sm text-ink-soft underline underline-offset-4">
          Back to bag
        </Link>
      </div>
      <CheckoutForm prefill={prefill} />
    </div>
  );
}
