import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckCircle2, Clock, Info } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { getOrderByNumber } from "@/lib/data";
import { getPaymentsConfig } from "@/lib/payments/config";
import { OrderDetail } from "@/components/order/order-detail";
import { CompletePaymentButton } from "@/components/order/complete-payment-button";
import { buttonClasses } from "@/components/ui/button";
import { formatPrice } from "@/lib/utils";

export const metadata: Metadata = { title: "Order confirmed", robots: { index: false } };

export default async function OrderConfirmationPage({
  params,
  searchParams,
}: PageProps<"/order/[orderNumber]">) {
  const { orderNumber } = await params;
  const sp = await searchParams;
  const pay = typeof sp.pay === "string" ? sp.pay : null;

  const order = await getOrderByNumber(orderNumber);
  if (!order) notFound();

  // An order that belongs to a customer is only visible to that customer.
  // (Legacy guest orders have no userId and stay reachable by link.)
  if (order.userId) {
    const user = await getCurrentUser();
    if (!user || user.id !== order.userId) notFound();
  }

  const config = await getPaymentsConfig();
  const awaitingPayment = order.status === "PENDING_PAYMENT";
  const onlinePayable = awaitingPayment && config.sessionsEnabled;
  const isPaid = order.paymentStatus === "PAID" || order.status === "PAID";

  // The return/cancel routes are DISPLAY ONLY — this page never trusts `pay`
  // or any query parameter as proof of payment, and never mutates the order.
  const returnedFromPayment = pay === "return";
  const cancelledPayment = pay === "cancelled";

  return (
    <div className="container-page py-10">
      <div className="mx-auto max-w-md text-center">
        <div
          className={`mx-auto grid h-14 w-14 place-items-center rounded-full ${
            returnedFromPayment && !isPaid ? "bg-info-50" : "bg-sage-50"
          }`}
        >
          {returnedFromPayment && !isPaid ? (
            <Clock size={26} className="text-info" />
          ) : (
            <CheckCircle2 size={26} className="text-sage" />
          )}
        </div>

        <h1 className="mt-5 text-title sm:text-display">
          {returnedFromPayment && !isPaid
            ? "Payment received — confirming"
            : "Thank you — your order is in"}
        </h1>
        <p className="mt-2 text-ink-soft">
          Your order number is{" "}
          <span className="font-medium text-ink">{order.orderNumber}</span>.
        </p>
        <p className="mt-1 text-meta text-ink-faint">
          Order total: {formatPrice(order.grandTotal)}
          {awaitingPayment && !onlinePayable && " · pay on delivery"}
        </p>

        {returnedFromPayment && !isPaid && (
          <div className="mt-5 flex items-start gap-2.5 rounded-md border border-info/30 bg-info-50 px-4 py-3 text-left text-meta text-ink-soft">
            <Info size={15} className="mt-0.5 shrink-0 text-info" />
            <span>
              We’re confirming your payment with the provider. This usually only takes a moment —
              you’ll get an email once it’s confirmed, and this page will update. No need to pay
              again.
            </span>
          </div>
        )}

        {cancelledPayment && awaitingPayment && (
          <div className="mt-5 flex items-start gap-2.5 rounded-md border border-line bg-surface-sunken px-4 py-3 text-left text-meta text-ink-soft">
            <Info size={15} className="mt-0.5 shrink-0 text-ink-faint" />
            <span>
              Payment wasn’t completed. Your order is saved — you can pay now or from your orders
              at any time.
            </span>
          </div>
        )}

        <div className="mt-6 flex flex-wrap justify-center gap-3">
          {onlinePayable && (
            <CompletePaymentButton
              orderNumber={order.orderNumber}
              label={cancelledPayment ? "Pay now" : "Complete payment"}
            />
          )}
          <Link href="/account/orders" className={buttonClasses({ variant: "outline" })}>
            View your orders
          </Link>
          <Link href="/c/all" className={buttonClasses({ variant: "ghost" })}>
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
