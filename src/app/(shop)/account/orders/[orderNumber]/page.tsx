import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getOrderByNumber } from "@/lib/data";
import { OrderDetail } from "@/components/order/order-detail";

export async function generateMetadata({
  params,
}: PageProps<"/account/orders/[orderNumber]">): Promise<Metadata> {
  const { orderNumber } = await params;
  return { title: `Order ${orderNumber}` };
}

export default async function AccountOrderPage({
  params,
}: PageProps<"/account/orders/[orderNumber]">) {
  const { orderNumber } = await params;
  const user = await requireUser(`/account/orders/${orderNumber}`);
  const order = await getOrderByNumber(orderNumber);

  if (!order || order.userId !== user.id) notFound();

  return (
    <div className="space-y-6">
      <Link
        href="/account/orders"
        className="inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink"
      >
        <ChevronLeft size={15} /> All orders
      </Link>
      <h2 className="text-xl">Order {order.orderNumber}</h2>
      <OrderDetail order={order} />
    </div>
  );
}
