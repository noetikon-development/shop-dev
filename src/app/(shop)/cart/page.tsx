import type { Metadata } from "next";
import { CartView } from "@/components/cart/cart-view";

export const metadata: Metadata = { title: "Your bag" };

export default function CartPage() {
  return (
    <div className="container-page py-8 sm:py-12">
      <h1 className="text-3xl sm:text-display">Your bag</h1>
      <div className="mt-8">
        <CartView />
      </div>
    </div>
  );
}
