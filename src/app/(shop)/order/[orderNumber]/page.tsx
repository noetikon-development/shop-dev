import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
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

  return (
    <div className="container-page py-10">
      <div className="mx-auto max-w-md text-center">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-sage-50">
          <CheckCircle2 size={26} className="text-sage" />
        </div>
        <h1 className="mt-5 text-3xl">Thank you — your order is in</h1>
        <p className="mt-2 text-ink-soft">
          We&apos;ve emailed a confirmation to <span className="text-ink">{order.email}</span>.
          Your order number is{" "}
          <span className="font-medium text-ink">{order.orderNumber}</span>.
        </p>
        <p className="mt-1 text-sm text-ink-faint">
          Total paid / due: {formatPrice(order.grandTotal)}
        </p>
        <div className="mt-5 flex justify-center gap-3">
          <Link href={`/track?order=${order.orderNumber}`} className="btn btn-outline">
            Track this order
          </Link>
          <Link href="/account/orders" className="btn btn-ghost">
            All orders
          </Link>
        </div>
      </div>

      <div className="mx-auto mt-12 max-w-4xl">
        <OrderDetail order={order} />
      </div>
    </div>
  );
}
