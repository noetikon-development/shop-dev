import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ChevronLeft, RotateCcw } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getOrderByNumber } from "@/lib/data";
import { returnEligibility } from "@/lib/returns";
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

  const elig = await returnEligibility(user.id, orderNumber);

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
      <ReturnCallout orderNumber={orderNumber} elig={elig} orderStatus={order.status} />
    </div>
  );
}

function ReturnCallout({
  orderNumber,
  elig,
  orderStatus,
}: {
  orderNumber: string;
  elig: Awaited<ReturnType<typeof returnEligibility>>;
  orderStatus: string;
}) {
  if (elig.eligible) {
    return (
      <div className="card-surface flex flex-wrap items-center justify-between gap-3 p-5">
        <div className="flex items-start gap-3">
          <RotateCcw size={18} className="mt-0.5 shrink-0 text-ink-soft" />
          <div>
            <p className="text-sm font-medium">Need to return something?</p>
            <p className="text-sm text-ink-soft">
              You can request a return for items on this order.
            </p>
          </div>
        </div>
        <Link href={`/account/orders/${orderNumber}/return`} className="btn btn-outline">
          Return items
        </Link>
      </div>
    );
  }

  if (elig.code === "already_open" && elig.existingReturnNumber) {
    return (
      <div className="card-surface flex flex-wrap items-center justify-between gap-3 p-5">
        <div className="flex items-start gap-3">
          <RotateCcw size={18} className="mt-0.5 shrink-0 text-ink-soft" />
          <p className="text-sm text-ink-soft">There&apos;s an open return for this order.</p>
        </div>
        <Link href={`/account/returns/${elig.existingReturnNumber}`} className="btn btn-outline">
          View your return
        </Link>
      </div>
    );
  }

  // Only nudge about returns once the order is delivered; stay quiet otherwise.
  if (orderStatus === "DELIVERED" && (elig.code === "window_expired" || elig.code === "nothing_returnable")) {
    return (
      <p className="text-xs text-ink-faint">
        {elig.code === "window_expired"
          ? "The return window for this order has passed. Contact us if you still need help."
          : "All items on this order have already been requested for return."}
      </p>
    );
  }

  return null;
}
