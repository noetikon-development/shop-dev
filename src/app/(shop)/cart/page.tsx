import type { Metadata } from "next";
import { CartView } from "@/components/cart/cart-view";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = { title: "Your bag" };

export default function CartPage() {
  return (
    <div className="container-page py-8 sm:py-12">
      <PageHeader title="Your bag" />
      <CartView />
    </div>
  );
}
