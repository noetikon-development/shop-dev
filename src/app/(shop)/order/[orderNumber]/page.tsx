import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { getOrderByNumber } from "@/lib/data";
import { OrderDetail } from "@/components/order/order-detail";
import { formatPrice } from "@/lib/utils";

export const metadata: Metadata = { title: "Order confirmed", robots: { index: false } };

export default async function OrderConfirmationPage({
  params,
}: PageProps<"/order/[orderNumber]">) {
  const { orderNumber } = await params;
  const order = await getOrderByNumber(orderNumber);
  if (!order) notFound();

  // An order that belongs to a customer is only visible to that customer.
  // (Legacy guest orders have no userId and stay reachable by link.)
  if (order.userId) {
    const user = await getCurrentUser();
    if (!user || user.id !== order.userId) notFound();
  }

  const awaitingPayment =
    order.status === "PENDING_PAYMENT" || order.paymentStatus === "PENDING";

  return (
    <div className="container-page py-10">
      <div className="mx-auto max-w-md text-center">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-sage-50">
          <CheckCircle2 size={26} className="text-sage" />
        </div>
        <h1 className="mt-5 text-3xl">Thank you — your order is in</h1>
        <p className="mt-2 text-ink-soft">
          Your order number is{" "}
          <span className="font-medium text-ink">{order.orderNumber}</span>.
        </p>
        <p className="mt-1 text-sm text-ink-faint">
          Order total: {formatPrice(order.grandTotal)}
          {awaitingPayment && " · awaiting payment"}
        </p>
        <div className="mt-5 flex justify-center gap-3">
          <Link href="/account/orders" className="btn btn-outline">
            View your orders
          </Link>
          <Link href="/c/all" className="btn btn-ghost">
            Continue shopping
          </Link>
        </div>
      </div>

      <div className="mx-auto mt-12 max-w-4xl">
        <OrderDetail order={order} />
      </div>
    </div>
  );
}
